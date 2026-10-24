import {
	and,
	asc,
	company,
	contact,
	contains,
	DealStage,
	db,
	deal,
	desc,
	eq,
	equalsInsensitive,
	firstRow,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	type SQL,
	sql,
	user,
} from "@crm/db";
import { LOSING_DEAL_STAGES, OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import { domainOf, normalise } from "./names";

export type RecordKind = "contact" | "company" | "deal";

export type ContactHit = {
	kind: "contact";
	id: string;
	name: string;
	title: string | null;
	email: string | null;
	company: { id: string; name: string } | null;
	lastActivityAt: string | null;
};

export type CompanyHit = {
	kind: "company";
	id: string;
	name: string;
	domain: string | null;
	industry: string | null;
	contacts: number;
	deals: number;
};

export type DealHit = {
	kind: "deal";
	id: string;
	name: string;
	stage: string;
	amount: number | null;
	currency: string;
	company: { id: string; name: string };
};

export type SearchHit = ContactHit | CompanyHit | DealHit;

export type SearchResult = {
	query: string;
	contacts: ContactHit[];
	companies: CompanyHit[];
	deals: DealHit[];
	total: number;
};

export type DealListStatus = "open" | "won" | "lost" | "all";

export type DealListOptions = {
	status?: DealListStatus;
	inactiveForDays?: number;
	companyId?: string;
	ownerId?: string;
	limit?: number;
	cursor?: string;
	now?: Date;
};

export async function listDeals(options: DealListOptions = {}) {
	const status = options.status ?? "open";
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
	const now = options.now ?? new Date();
	const cutoff =
		options.inactiveForDays === undefined
			? null
			: new Date(
					now.getTime() - Math.max(options.inactiveForDays, 0) * 86_400_000,
				);
	const stages =
		status === "open"
			? [...OPEN_DEAL_STAGES]
			: status === "won"
				? [DealStage.CLOSED_WON]
				: status === "lost"
					? [...LOSING_DEAL_STAGES]
					: null;

	const rows = await db
		.select({
			id: deal.id,
			name: deal.name,
			stage: deal.stage,
			amount: deal.amount,
			currency: deal.currency,
			createdAt: deal.createdAt,
			lastActivityAt: deal.lastActivityAt,
			expectedCloseDate: deal.expectedCloseDate,
			company: {
				id: company.id,
				name: company.name,
				domain: company.domain,
				iconUrl: company.iconUrl,
				iconDarkUrl: company.iconDarkUrl,
				iconTone: company.iconTone,
				logoUrl: company.logoUrl,
			},
			owner: {
				id: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
			},
		})
		.from(deal)
		.innerJoin(company, eq(company.id, deal.companyId))
		.leftJoin(user, eq(user.id, deal.ownerId))
		.where(
			and(
				stages ? inArray(deal.stage, stages) : undefined,
				options.companyId ? eq(deal.companyId, options.companyId) : undefined,
				options.ownerId ? eq(deal.ownerId, options.ownerId) : undefined,
				cutoff
					? or(
							lte(deal.lastActivityAt, cutoff),
							and(isNull(deal.lastActivityAt), lte(deal.createdAt, cutoff)),
						)
					: undefined,
				options.cursor ? await dealsAfter(options.cursor) : undefined,
			),
		)
		.orderBy(
			sql`${deal.lastActivityAt} asc nulls first`,
			asc(deal.createdAt),
			asc(deal.id),
		)
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);

	return {
		criteria: {
			status,
			inactiveForDays: options.inactiveForDays ?? null,
			companyId: options.companyId ?? null,
			ownerId: options.ownerId ?? null,
		},
		asOf: now.toISOString(),
		deals: page.map((deal) => {
			const activityDate = deal.lastActivityAt ?? deal.createdAt;
			return {
				id: deal.id,
				name: deal.name,
				stage: deal.stage,
				amount: deal.amount === null ? null : Number(deal.amount),
				currency: deal.currency,
				company: deal.company,
				owner: deal.owner,
				createdAt: deal.createdAt.toISOString(),
				lastActivityAt: deal.lastActivityAt?.toISOString() ?? null,
				daysSinceLastActivity: Math.max(
					0,
					Math.floor((now.getTime() - activityDate.getTime()) / 86_400_000),
				),
				neverActive: deal.lastActivityAt === null,
				expectedCloseDate: deal.expectedCloseDate?.toISOString() ?? null,
			};
		}),
		hasMore,
		nextCursor: hasMore ? page.at(-1)?.id : null,
	};
}

async function dealsAfter(cursorId: string): Promise<SQL | undefined> {
	const cursor = await firstRow(
		db
			.select({
				id: deal.id,
				createdAt: deal.createdAt,
				lastActivityAt: deal.lastActivityAt,
			})
			.from(deal)
			.where(eq(deal.id, cursorId))
			.limit(1),
	);
	if (!cursor) return sql`false`;

	const tail = or(
		gt(deal.createdAt, cursor.createdAt),
		and(eq(deal.createdAt, cursor.createdAt), gt(deal.id, cursor.id)),
	);

	if (cursor.lastActivityAt === null) {
		return or(
			isNotNull(deal.lastActivityAt),
			and(isNull(deal.lastActivityAt), tail),
		);
	}

	return or(
		gt(deal.lastActivityAt, cursor.lastActivityAt),
		and(eq(deal.lastActivityAt, cursor.lastActivityAt), tail),
	);
}

export async function searchCrm(
	query: string,
	options: { kinds?: RecordKind[]; limit?: number } = {},
): Promise<SearchResult> {
	const term = query.trim();
	const kinds = options.kinds ?? ["contact", "company", "deal"];
	const limit = options.limit ?? 10;

	if (term.length < 2) {
		return { query: term, contacts: [], companies: [], deals: [], total: 0 };
	}

	const wants = (kind: RecordKind) => kinds.includes(kind);
	const email = term.includes("@") ? term.toLowerCase() : null;
	const domain = email ? domainOf(email) : bareDomain(term);
	const words = term.split(/\s+/).filter((word) => word.length >= 2);

	const [contacts, companies, deals] = await Promise.all([
		wants("contact") ? searchContacts(term, words, email, limit) : [],
		wants("company") ? searchCompanies(term, words, domain, limit) : [],
		wants("deal") ? searchDeals(term, words, limit) : [],
	]);

	return {
		query: term,
		contacts,
		companies,
		deals,
		total: contacts.length + companies.length + deals.length,
	};
}

async function searchContacts(
	term: string,
	words: string[],
	email: string | null,
	limit: number,
): Promise<ContactHit[]> {
	const matches = words.flatMap((word) => [
		contains(contact.firstName, word, { insensitive: true }),
		contains(contact.lastName, word, { insensitive: true }),
		contains(contact.email, word, { insensitive: true }),
	]);

	const rows = await db
		.select({
			id: contact.id,
			firstName: contact.firstName,
			lastName: contact.lastName,
			title: contact.title,
			email: contact.email,
			lastActivityAt: contact.lastActivityAt,
			company: { id: company.id, name: company.name },
		})
		.from(contact)
		.leftJoin(company, eq(company.id, contact.companyId))
		.where(
			or(
				email ? equalsInsensitive(contact.email, email) : undefined,
				...matches,
				contains(company.name, term, { insensitive: true }),
			),
		)
		.orderBy(desc(contact.lastActivityAt), asc(contact.createdAt))
		.limit(limit * 3);

	return rows
		.map((row) => {
			const name = [row.firstName, row.lastName].filter(Boolean).join(" ");
			return {
				score: score(term, [name, row.email ?? "", row.company?.name ?? ""]),
				hit: {
					kind: "contact" as const,
					id: row.id,
					name,
					title: row.title,
					email: row.email,
					company: row.company,
					lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
				},
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((row) => row.hit);
}

async function searchCompanies(
	term: string,
	words: string[],
	domain: string | null,
	limit: number,
): Promise<CompanyHit[]> {
	const rows = await db
		.select({
			id: company.id,
			name: company.name,
			domain: company.domain,
			industry: company.industry,
			contacts: db.$count(contact, eq(contact.companyId, company.id)),
			deals: db.$count(deal, eq(deal.companyId, company.id)),
		})
		.from(company)
		.where(
			or(
				contains(company.name, term, { insensitive: true }),
				domain
					? contains(company.domain, domain, { insensitive: true })
					: undefined,
				...words.map((word) =>
					contains(company.name, word, { insensitive: true }),
				),
			),
		)
		.orderBy(desc(company.lastActivityAt), asc(company.name))
		.limit(limit * 3);

	return rows
		.map((row) => ({
			score: score(term, [row.name, row.domain ?? ""]),
			hit: {
				kind: "company" as const,
				id: row.id,
				name: row.name,
				domain: row.domain,
				industry: row.industry,
				contacts: row.contacts,
				deals: row.deals,
			},
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((row) => row.hit);
}

async function searchDeals(
	term: string,
	words: string[],
	limit: number,
): Promise<DealHit[]> {
	const rows = await db
		.select({
			id: deal.id,
			name: deal.name,
			stage: deal.stage,
			amount: deal.amount,
			currency: deal.currency,
			company: { id: company.id, name: company.name },
		})
		.from(deal)
		.innerJoin(company, eq(company.id, deal.companyId))
		.where(
			or(
				contains(deal.name, term, { insensitive: true }),
				...words.map((word) =>
					contains(deal.name, word, { insensitive: true }),
				),
				contains(company.name, term, { insensitive: true }),
			),
		)
		.orderBy(desc(deal.lastActivityAt), desc(deal.createdAt))
		.limit(limit * 3);

	return rows
		.map((row) => ({
			score: score(term, [row.name, row.company.name]),
			hit: {
				kind: "deal" as const,
				id: row.id,
				name: row.name,
				stage: row.stage,
				amount: row.amount === null ? null : Number(row.amount),
				currency: row.currency,
				company: row.company,
			},
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((row) => row.hit);
}

function score(term: string, fields: string[]): number {
	const needle = normalise(term);
	if (!needle) return 0;

	let best = 0;
	for (const field of fields) {
		const hay = normalise(field);
		if (!hay) continue;
		if (hay === needle) best = Math.max(best, 4);
		else if (hay.startsWith(needle)) best = Math.max(best, 3);
		else if (hay.includes(needle)) best = Math.max(best, 2);
	}
	if (best > 0) return best;

	const words = term
		.split(/\s+/)
		.map(normalise)
		.filter((word) => word.length >= 2);
	if (words.length === 0) return 0;

	const hay = fields.map(normalise).join(" ");
	return words.filter((word) => hay.includes(word)).length / words.length;
}

function bareDomain(term: string): string | null {
	const candidate = term
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "");
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(candidate) ? candidate : null;
}
