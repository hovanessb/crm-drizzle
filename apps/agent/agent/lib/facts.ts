import {
	and,
	contactBrief,
	contactFact,
	contact as contactTable,
	db,
	desc,
	eq,
	FactBand,
	FactStatus,
	firstRow,
	inArray,
	type JsonValue,
	requireRow,
	whereEq,
} from "@crm/db";
import { type Evidence, scoreEvidence } from "./evidence";
import { currentFocus } from "./focus";
import { isDerivedName, splitName } from "./names";

const FIELDS = {
	name: { column: null },
	title: { column: "title" },
	linkedinUrl: { column: "linkedinUrl" },
	twitterUrl: { column: "twitterUrl" },
	githubUrl: { column: "githubUrl" },
	employer: { column: null },
	seniority: { column: "seniority" },
	function: { column: "function" },
	location: { column: null },
	tenure: { column: null },
} as const;

export type FactField = keyof typeof FIELDS;

export type FactColumn = NonNullable<(typeof FIELDS)[FactField]["column"]>;

export const FACT_FIELDS = Object.keys(FIELDS) as FactField[];

export type FactSubject = {
	email: string | null;
	firstName: string;
	lastName: string | null;
} & { [Column in FactColumn]: string | null };

export function factColumn(field: FactField): FactColumn | null {
	return FIELDS[field].column;
}

export function fillsBlank(input: {
	field: FactField;
	contact: FactSubject;
	hasAgentFact: boolean;
}): boolean {
	const column = FIELDS[input.field].column;
	if (humanOwns({ ...input, column })) return false;

	return isEmpty({ ...input, column });
}

export type RecordFactInput = {
	contactId: string;
	field: FactField;
	value: string;
	evidence: Evidence[];
	method: string;
	sourceUrl?: string;
};

export type RecordFactResult = {
	stored: boolean;
	applied: boolean;
	band: FactBand | null;
	score: number;
	rationale: string;
	reason?: string;
};

export async function recordFact(
	input: RecordFactInput,
): Promise<RecordFactResult> {
	const { contactId, field, value } = input;
	const trimmed = value.trim();

	const scored = scoreEvidence(input.evidence);
	const base = {
		score: scored.score,
		band: scored.band,
		rationale: scored.rationale,
	};

	if (!trimmed) {
		return { ...base, stored: false, applied: false, reason: "Empty value." };
	}

	if (scored.band === null) {
		return {
			...base,
			stored: false,
			applied: false,
			reason:
				"Below the floor for keeping — not stored. Find a source that identifies them, or leave the field alone.",
		};
	}

	const contact = await firstRow(
		db
			.select({
				id: contactTable.id,
				email: contactTable.email,
				firstName: contactTable.firstName,
				lastName: contactTable.lastName,
				title: contactTable.title,
				seniority: contactTable.seniority,
				function: contactTable.function,
				linkedinUrl: contactTable.linkedinUrl,
				twitterUrl: contactTable.twitterUrl,
				githubUrl: contactTable.githubUrl,
			})
			.from(contactTable)
			.where(whereEq(contactTable.id, contactId))
			.limit(1),
	);

	if (!contact) {
		return {
			...base,
			stored: false,
			applied: false,
			reason: "No such contact.",
		};
	}

	const existing = await db
		.select({
			id: contactFact.id,
			value: contactFact.value,
			status: contactFact.status,
		})
		.from(contactFact)
		.where(
			and(
				whereEq(contactFact.contactId, contactId),
				whereEq(contactFact.field, field),
			),
		);

	if (
		existing.some(
			(fact) =>
				fact.status === FactStatus.DISMISSED && sameValue(fact.value, trimmed),
		)
	) {
		return {
			...base,
			stored: false,
			applied: false,
			reason:
				"A person has already dismissed this exact value. Do not offer it again.",
		};
	}

	const currentApplied = existing.find(
		(fact) => fact.status === FactStatus.APPLIED,
	);

	if (currentApplied && sameValue(currentApplied.value, trimmed)) {
		return {
			...base,
			stored: false,
			applied: false,
			reason: "Already on the record, from this same source. Nothing changed.",
		};
	}

	const column = FIELDS[field].column;
	const hasAgentFact = Boolean(currentApplied);

	if (humanOwns({ field, column, contact, hasAgentFact })) {
		return {
			...base,
			stored: false,
			applied: false,
			reason: `A person already filled in ${field}. That outranks anything found on the web.`,
		};
	}

	const applies =
		scored.band === FactBand.VERIFIED ||
		fillsBlank({ field, contact, hasAgentFact });

	if (
		!applies &&
		existing.some(
			(fact) =>
				fact.status === FactStatus.PROPOSED && sameValue(fact.value, trimmed),
		)
	) {
		return {
			...base,
			stored: false,
			applied: false,
			reason:
				"This exact value is already in front of a rep, waiting on them. Offering it twice only makes them read it twice.",
		};
	}

	const sessionId = currentFocus().sessionId;

	await db.transaction(async (tx) => {
		if (applies) {
			await tx
				.update(contactFact)
				.set({ status: FactStatus.SUPERSEDED, supersededAt: new Date() })
				.where(
					and(
						whereEq(contactFact.contactId, contactId),
						whereEq(contactFact.field, field),
						inArray(contactFact.status, [
							FactStatus.APPLIED,
							FactStatus.PROPOSED,
						]),
					),
				);
		}

		await requireRow(
			tx
				.insert(contactFact)
				.values({
					contactId,
					field,
					value: trimmed,
					score: scored.score,
					band: scored.band as FactBand,
					evidence: input.evidence as JsonValue,
					method: input.method,
					sourceUrl: input.sourceUrl ?? null,
					sessionId,
					status: applies ? FactStatus.APPLIED : FactStatus.PROPOSED,
				})
				.returning(),
		);

		if (!applies) return;

		if (column) {
			await requireRow(
				tx
					.update(contactTable)
					.set({ [column]: trimmed })
					.where(whereEq(contactTable.id, contactId))
					.returning(),
			);
		}

		if (field === "name") {
			const split = splitName(trimmed);
			if (split) {
				await requireRow(
					tx
						.update(contactTable)
						.set({ firstName: split.firstName, lastName: split.lastName })
						.where(whereEq(contactTable.id, contactId))
						.returning(),
				);
			}
		}
	});

	return {
		...base,
		stored: true,
		applied: applies,
		reason: applies
			? undefined
			: "The record already carries a value here, and only VERIFIED evidence may replace one, so this is kept as a proposal for a rep to accept or dismiss. This is a normal outcome, not a failure — do not try to raise the score.",
	};
}

export async function lastEmployerChange(contactId: string) {
	const [previous, current] = await Promise.all([
		firstRow(
			db
				.select({
					value: contactFact.value,
					supersededAt: contactFact.supersededAt,
				})
				.from(contactFact)
				.where(
					and(
						whereEq(contactFact.contactId, contactId),
						eq(contactFact.field, "employer"),
						eq(contactFact.status, FactStatus.SUPERSEDED),
					),
				)
				.orderBy(desc(contactFact.supersededAt))
				.limit(1),
		),
		firstRow(
			db
				.select({
					value: contactFact.value,
					observedAt: contactFact.observedAt,
					sourceUrl: contactFact.sourceUrl,
				})
				.from(contactFact)
				.where(
					and(
						whereEq(contactFact.contactId, contactId),
						eq(contactFact.field, "employer"),
						eq(contactFact.status, FactStatus.APPLIED),
					),
				)
				.orderBy(desc(contactFact.observedAt))
				.limit(1),
		),
	]);

	if (!previous || !current || sameValue(previous.value, current.value)) {
		return null;
	}

	return {
		from: previous.value,
		to: current.value,
		observedAt: current.observedAt,
		sourceUrl: current.sourceUrl,
	};
}

export type BriefSections = {
	currentRole?: string;
	tenure?: string;
	previousRoles?: string[];
	seniority?: string;
	function?: string;
	location?: string;
};

export async function writeBrief(input: {
	contactId: string;
	narrative: string;
	sections: BriefSections;
	evidence: Evidence[];
	sourceUrl?: string;
}): Promise<{ written: boolean; score: number; reason?: string }> {
	const scored = scoreEvidence(input.evidence);

	if (scored.band === null) {
		return {
			written: false,
			score: scored.score,
			reason: "Nothing here is sourced well enough to put on the record.",
		};
	}

	const data = {
		narrative: input.narrative.trim(),
		sections: input.sections as JsonValue,
		score: scored.score,
		sourceUrl: input.sourceUrl ?? null,
		sessionId: currentFocus().sessionId,
		refreshedAt: new Date(),
	};

	await requireRow(
		db
			.insert(contactBrief)
			.values({ contactId: input.contactId, ...data })
			.onConflictDoUpdate({ target: contactBrief.contactId, set: data })
			.returning(),
	);

	return { written: true, score: scored.score };
}

function humanOwns({
	field,
	column,
	contact,
	hasAgentFact,
}: {
	field: FactField;
	column: FactColumn | null;
	contact: FactSubject;
	hasAgentFact: boolean;
}): boolean {
	if (field === "name") {
		return !isDerivedName(contact.email, contact.firstName, contact.lastName);
	}

	if (!column || hasAgentFact) return false;

	return Boolean(contact[column]);
}

function isEmpty({
	field,
	column,
	contact,
	hasAgentFact,
}: {
	field: FactField;
	column: FactColumn | null;
	contact: FactSubject;
	hasAgentFact: boolean;
}): boolean {
	if (hasAgentFact) return false;
	if (field === "name") return true;
	if (!column) return true;

	return !contact[column];
}

const HOST_ALIASES = new Map([
	["twitter.com", "x.com"],
	["mobile.twitter.com", "x.com"],
]);

export function sameValue(a: string, b: string): boolean {
	return canonicalValue(a) === canonicalValue(b);
}

export function canonicalValue(value: string): string {
	const text = value.trim().replace(/\s+/g, " ").toLowerCase();
	const url = asWebUrl(text);

	if (!url) return text;

	const host = url.host.replace(/^www\./, "");
	const path = url.pathname.replace(/\/+$/, "");

	return `${HOST_ALIASES.get(host) ?? host}${path}`;
}

function asWebUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}
