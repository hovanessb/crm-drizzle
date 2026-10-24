import {
	activity,
	agentTask,
	and,
	asc,
	company,
	contact,
	contains,
	type Db,
	deal,
	desc,
	EnrichmentStatus,
	eq,
	hasValues,
	inArray,
	isNull,
	isUniqueViolation,
	lte,
	type NewCompany,
	or,
	RecordSource,
	type SQL,
	user,
} from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import type { FieldDefinitionWithOptions } from "@crm/db/fields";
import { lockIdempotencyKey, lockIdempotencyKeys } from "@crm/db/idempotency";
import {
	COMPANY_IMPORT,
	type CompanyImportInput,
} from "@crm/validation/company-import";
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { AgentQueueService } from "../agent/agent-queue.service";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ARCHIVE } from "../archive/archive-config";
import {
	ActivityStampService,
	type StampTargets,
} from "../crm/activity-stamp.service";
import { type BulkResult, requireOwner, runBulk } from "../crm/bulk";
import { blankToNull, toCents } from "../crm/values";
import { ConversionService } from "../currency/conversion.service";
import { InjectDatabase } from "../database/database.constants";
import { FieldsService } from "../fields/fields.service";
import {
	activityFacetCounts,
	activityFilter,
	archivedFilter,
	countsByKey,
	FACET_UNASSIGNED,
	groupCounts,
	type ListResult,
	type OrderByColumns,
	ownerFilter,
	paginate,
	resolveOrderBy,
	sortBy,
	sortNullsLast,
} from "../trpc/list-input";
import type {
	CompanyBulkOwnerInput,
	CompanyCreateInput,
	CompanyListInput,
	CompanyRow,
	CompanyUpdateInput,
} from "./companies.contracts";
import { normalizeDomain } from "./domain";
import { FaviconService } from "./favicon.service";

const OWNER_COLUMNS = {
	id: true,
	name: true,
	email: true,
	image: true,
} as const;

const OWNER_FIELDS = {
	id: user.id,
	name: user.name,
	email: user.email,
	image: user.image,
};

@Injectable()
class CompanyCounts {
	constructor(@InjectDatabase() private readonly db: Db) {}

	contacts() {
		return this.db.$count(contact, eq(contact.companyId, company.id));
	}

	deals() {
		return this.db.$count(deal, eq(deal.companyId, company.id));
	}

	openDeals() {
		return this.db.$count(
			deal,
			and(
				eq(deal.companyId, company.id),
				inArray(deal.stage, [...OPEN_DEAL_STAGES]),
			),
		);
	}
}

function sortable(counts: CompanyCounts): OrderByColumns<SQL> {
	return {
		name: (dir) => sortBy(company.name, dir),
		domain: (dir) => sortBy(company.domain, dir),
		industry: (dir) => sortBy(company.industry, dir),
		createdAt: (dir) => sortBy(company.createdAt, dir),
		contacts: (dir) => sortBy(counts.contacts(), dir),
		deals: (dir) => sortBy(counts.deals(), dir),
		owner: (dir) => sortBy(user.name, dir),
		lastActivity: (dir) => sortNullsLast(company.lastActivityAt, dir),
		archivedAt: (dir) => sortNullsLast(company.archivedAt, dir),
	};
}

@Injectable()
export class CompaniesService {
	private readonly logger = new Logger(CompaniesService.name);

	private readonly counts: CompanyCounts;

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
		private readonly queue: AgentQueueService,
		private readonly favicon: FaviconService,
		private readonly stamp: ActivityStampService,
		private readonly conversion: ConversionService,
		private readonly fields: FieldsService,
	) {
		this.counts = new CompanyCounts(db);
	}

	async list(input: CompanyListInput): Promise<ListResult<CompanyRow>> {
		const filterableFields = await this.fields.filterableFieldsFor("COMPANY");
		const where = this.buildWhere(input, filterableFields);
		const { skip, take } = paginate(input);

		const [rows, total, facetCounts] = await Promise.all([
			this.db
				.select({
					id: company.id,
					name: company.name,
					domain: company.domain,
					iconUrl: company.iconUrl,
					iconDarkUrl: company.iconDarkUrl,
					iconTone: company.iconTone,
					logoUrl: company.logoUrl,
					brandColor: company.brandColor,
					industry: company.industry,
					enrichmentStatus: company.enrichmentStatus,
					source: company.source,
					owner: OWNER_FIELDS,
					contactCount: this.counts.contacts(),
					openDealCount: this.counts.openDeals(),
					lastActivityAt: company.lastActivityAt,
					createdAt: company.createdAt,
					archivedAt: company.archivedAt,
				})
				.from(company)
				.leftJoin(user, eq(user.id, company.ownerId))
				.where(where)
				.orderBy(
					resolveOrderBy(input, sortable(this.counts), desc(company.createdAt)),
				)
				.limit(take)
				.offset(skip),
			this.db.$count(company, where),
			this.facetCounts(input, filterableFields),
		]);

		const ids = rows.map((row) => row.id);
		const [queued, tableFields] = await Promise.all([
			this.queue.queuedCompanies(ids),
			this.fields.tableValuesFor("COMPANY", ids),
		]);

		return {
			rows: rows.map((row) => ({
				id: row.id,
				name: row.name,
				domain: row.domain,
				iconUrl: row.iconUrl,
				iconDarkUrl: row.iconDarkUrl,
				iconTone: row.iconTone,
				logoUrl: row.logoUrl,
				brandColor: row.brandColor,
				industry: row.industry,
				enrichmentStatus: row.enrichmentStatus,
				queued: queued.has(row.id),
				source: row.source,
				owner: row.owner,
				contactCount: row.contactCount,
				openDealCount: row.openDealCount,
				lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
				createdAt: row.createdAt.toISOString(),
				archivedAt: row.archivedAt?.toISOString() ?? null,
				fields: tableFields.get(row.id) ?? {},
			})),
			total,
			facetCounts,
		};
	}

	async byId(id: string) {
		const record = await this.db.query.company.findFirst({
			where: eq(company.id, id),
			columns: {
				id: true,
				name: true,
				domain: true,
				website: true,
				description: true,
				logoUrl: true,
				logoDarkUrl: true,
				iconUrl: true,
				iconDarkUrl: true,
				iconTone: true,
				brandColor: true,
				industry: true,
				subIndustry: true,
				city: true,
				stateCode: true,
				country: true,
				countryCode: true,
				phone: true,
				email: true,
				linkedinUrl: true,
				twitterUrl: true,
				githubUrl: true,
				pricingUrl: true,
				careersUrl: true,
				enrichmentStatus: true,
				enrichedAt: true,
				enrichmentError: true,
				source: true,
				createdAt: true,
				archivedAt: true,
			},
			with: {
				owner: { columns: OWNER_COLUMNS },
				primaryContact: {
					columns: {
						id: true,
						firstName: true,
						lastName: true,
						email: true,
						phone: true,
						title: true,
					},
				},
				contacts: {
					orderBy: [asc(contact.lastName), asc(contact.firstName)],
					columns: {
						id: true,
						firstName: true,
						lastName: true,
						email: true,
						title: true,
						imageUrl: true,
					},
					with: { owner: { columns: OWNER_COLUMNS } },
				},
				deals: {
					orderBy: [asc(deal.stage), asc(deal.expectedCloseDate)],
					columns: {
						id: true,
						name: true,
						stage: true,
						amount: true,
						currency: true,
						baseAmount: true,
						expectedCloseDate: true,
					},
					with: { owner: { columns: OWNER_COLUMNS } },
				},
			},
		});

		if (!record) {
			throw new NotFoundException(`No company with id ${id}.`);
		}

		const {
			deals,
			primaryContact,
			enrichedAt,
			createdAt,
			archivedAt,
			...rest
		} = record;

		return {
			...rest,
			fields: await this.fields.valuesFor("COMPANY", id),
			queued: await this.queue.isQueued({ companyId: id }),
			createdAt: createdAt.toISOString(),
			archivedAt: archivedAt?.toISOString() ?? null,
			enrichedAt: enrichedAt?.toISOString() ?? null,
			primaryContactId: primaryContact?.id ?? null,
			primaryContact,
			reportingCurrency: await this.conversion.reportingCurrency(),
			deals: deals.map((deal) => ({
				...deal,
				amount: undefined,
				baseAmount: undefined,
				amountCents: toCents(deal.amount),
				baseAmountCents: toCents(deal.baseAmount),
				expectedCloseDate: deal.expectedCloseDate?.toISOString() ?? null,
			})),
		};
	}

	async options(q: string) {
		return this.db
			.select({
				id: company.id,
				name: company.name,
				domain: company.domain,
				iconUrl: company.iconUrl,
			})
			.from(company)
			.where(this.searchFilter(q))
			.orderBy(asc(company.name))
			.limit(100);
	}

	async create(input: CompanyCreateInput) {
		const domain = normalizeDomain(input.domain);

		const created = await this.agent.withCrmEvents(async (tx, emit) => {
			if (domain) {
				await lockIdempotencyKey(tx, `company-directory:${domain}`);
				const [existing] = await tx
					.select({ name: company.name })
					.from(company)
					.where(and(eq(company.domain, domain), isNull(company.archivedAt)))
					.limit(1);
				if (existing) {
					throw new ConflictException(
						`${existing.name} already uses the domain ${domain}.`,
					);
				}
			}

			const [inserted] = await tx
				.insert(company)
				.values({
					name: input.name.trim(),
					domain,
					website: domain ? `https://${domain}` : null,
					ownerId: input.ownerId ?? null,
				})
				.returning({
					id: company.id,
					name: company.name,
					domain: company.domain,
					createdAt: company.createdAt,
				});
			if (!inserted) throw new Error("The company insert returned no row.");
			const created = inserted;
			await emit({
				type: "company.created",
				record: { kind: "company", id: created.id },
				occurredAt: created.createdAt,
				data: { name: created.name, domain: created.domain },
			});
			return created;
		});

		this.logger.log({
			message: "Company created",
			companyId: created.id,
			domain: created.domain,
		});

		await this.agent.companyCreated(created.id);

		void this.favicon.backfill(created.id, created.domain);
		void this.fields.queueBackfillForNewRecord("COMPANY", created.id);

		return { id: created.id, name: created.name, domain: created.domain };
	}

	async import(input: CompanyImportInput) {
		const skips: Array<{ row: number; reason: string }> = [];
		const candidates = input.rows.flatMap((row, index) => {
			const rowNumber = index + 2;
			const name = row.name.trim();
			if (!name) {
				skips.push({ row: rowNumber, reason: "A company needs a name." });
				return [];
			}

			const website = row.website?.trim() ?? "";
			const domain = normalizeDomain(website);
			if (website && !domain) {
				skips.push({
					row: rowNumber,
					reason: `"${website}" is not a valid domain.`,
				});
				return [];
			}

			return [
				{
					row: rowNumber,
					name,
					domain,
					phone: blankToNull(row.phone ?? ""),
					city: blankToNull(row.city ?? ""),
					stateCode: blankToNull(row.stateCode ?? ""),
					industry: blankToNull(row.industry ?? ""),
					subIndustry: blankToNull(row.subIndustry ?? ""),
					description: blankToNull(row.description ?? ""),
				},
			];
		});

		const created = await this.agent.withCrmEvents(async (tx, emit) => {
			const domains = [
				...new Set(
					candidates.flatMap((candidate) =>
						candidate.domain ? [candidate.domain] : [],
					),
				),
			].toSorted();
			await lockIdempotencyKeys(
				tx,
				domains.map((domain) => `company-directory:${domain}`),
			);

			const existing = new Set(
				(domains.length > 0
					? await tx
							.select({ domain: company.domain })
							.from(company)
							.where(
								and(
									inArray(company.domain, domains),
									isNull(company.archivedAt),
								),
							)
					: ([] as { domain: string | null }[])
				).flatMap((row) => (row.domain ? [row.domain] : [])),
			);
			const accepted: typeof candidates = [];
			const seen = new Set<string>();
			for (const candidate of candidates) {
				if (candidate.domain && existing.has(candidate.domain)) {
					skips.push({
						row: candidate.row,
						reason: `${candidate.domain} already belongs to a company.`,
					});
					continue;
				}
				if (candidate.domain && seen.has(candidate.domain)) {
					skips.push({
						row: candidate.row,
						reason: `${candidate.domain} appears more than once in this file.`,
					});
					continue;
				}
				if (candidate.domain) seen.add(candidate.domain);
				accepted.push(candidate);
			}

			if (accepted.length === 0) return [];
			const rows = await tx
				.insert(company)
				.values(
					accepted.map(({ row: _row, ...candidate }) => ({
						...candidate,
						website: candidate.domain ? `https://${candidate.domain}` : null,
						source: RecordSource.IMPORT,
						enrichmentStatus: EnrichmentStatus.PENDING,
					})),
				)
				.returning({
					id: company.id,
					name: company.name,
					domain: company.domain,
					createdAt: company.createdAt,
				});

			for (const row of rows) {
				await emit({
					type: "company.created",
					record: { kind: "company", id: row.id },
					occurredAt: row.createdAt,
					data: { name: row.name, domain: row.domain },
				});
			}
			return rows;
		});

		const ids = created.map((company) => company.id);
		await Promise.all([
			this.agent.companiesCreated(ids, "Imported from CSV"),
			this.fields.queueBackfillForNewRecords("COMPANY", ids),
		]);
		void this.backfillFavicons(created);

		this.logger.log({
			message: "Companies imported",
			created: created.length,
			skipped: skips.length,
		});

		return {
			created: created.length,
			skipped: skips.length,
			skips: skips.toSorted((left, right) => left.row - right.row),
		};
	}

	async update(id: string, input: CompanyUpdateInput) {
		const data: Partial<NewCompany> = {};

		if (input.name !== undefined) data.name = input.name.trim();
		if (input.website !== undefined) data.website = blankToNull(input.website);
		if (input.description !== undefined) {
			data.description = blankToNull(input.description);
		}
		if (input.industry !== undefined)
			data.industry = blankToNull(input.industry);
		if (input.city !== undefined) data.city = blankToNull(input.city);
		if (input.stateCode !== undefined) {
			data.stateCode = blankToNull(input.stateCode);
		}
		if (input.country !== undefined) data.country = blankToNull(input.country);
		if (input.phone !== undefined) data.phone = blankToNull(input.phone);
		if (input.email !== undefined) data.email = blankToNull(input.email);
		if (input.linkedinUrl !== undefined) {
			data.linkedinUrl = blankToNull(input.linkedinUrl);
		}
		if (input.ownerId !== undefined) data.ownerId = input.ownerId || null;

		if (input.domain !== undefined) {
			const domain = normalizeDomain(input.domain);
			if (input.domain.trim() && !domain) {
				throw new BadRequestException(
					`"${input.domain}" is not a domain — try something like "stripe.com".`,
				);
			}
			data.domain = domain;
			const [current] = await this.db
				.select({ domain: company.domain })
				.from(company)
				.where(eq(company.id, id))
				.limit(1);
			if (current && current.domain !== domain) {
				data.enrichmentStatus = "PENDING";
				data.enrichmentError = null;
				data.iconUrl = null;
				data.iconDarkUrl = null;
				data.iconTone = null;
			}
		}

		try {
			const updated = await this.db.transaction(async (tx) => {
				if (input.fields) {
					await this.fields.applyValues(tx, "COMPANY", id, input.fields);
				}

				const fields = {
					id: company.id,
					name: company.name,
					domain: company.domain,
				};
				const [row] = hasValues(data)
					? await tx
							.update(company)
							.set(data)
							.where(eq(company.id, id))
							.returning(fields)
					: await tx
							.select(fields)
							.from(company)
							.where(eq(company.id, id))
							.limit(1);
				if (!row) throw new NotFoundException(`No company with id ${id}.`);
				return row;
			});

			if (data.enrichmentStatus === "PENDING") {
				await this.agent.companyCreated(
					id,
					"Domain changed — anything we knew was about a different company",
				);
				void this.favicon.backfill(id, updated.domain);
			}

			return updated;
		} catch (error) {
			throw this.translate(error, id);
		}
	}

	async archive(id: string): Promise<{ id: string; name: string }> {
		const name = await this.setArchivedAt(id, new Date());
		this.logger.log({ message: "Company archived", companyId: id });
		return { id, name };
	}

	async restore(id: string): Promise<{ id: string; name: string }> {
		const name = await this.setArchivedAt(id, null);
		this.logger.log({ message: "Company restored", companyId: id });
		return { id, name };
	}

	private async setArchivedAt(
		id: string,
		archivedAt: Date | null,
	): Promise<string> {
		const [row] = await this.db
			.update(company)
			.set({ archivedAt })
			.where(eq(company.id, id))
			.returning({ name: company.name })
			.catch((cause: unknown) => this.translate(cause, id));

		if (!row) throw new NotFoundException(`No company with id ${id}.`);

		return row.name;
	}

	async purge(id: string): Promise<{ id: string; name: string }>;
	async purge(
		id: string,
		guard: { archivedBefore: Date },
	): Promise<{ id: string; name: string } | null>;
	async purge(
		id: string,
		guard?: { archivedBefore: Date },
	): Promise<{ id: string; name: string } | null> {
		let deleted: { targets: StampTargets; name: string } | null;

		try {
			deleted = await this.db.transaction(async (tx) => {
				const [row] = await tx
					.select({ archivedAt: company.archivedAt })
					.from(company)
					.where(eq(company.id, id))
					.for("update");

				if (!row) {
					if (guard) return null;
					throw new NotFoundException(`No company with id ${id}.`);
				}
				if (
					guard &&
					(!row.archivedAt || row.archivedAt > guard.archivedBefore)
				) {
					return null;
				}

				const dealIds = tx
					.select({ id: deal.id })
					.from(deal)
					.where(eq(deal.companyId, id));

				const targets = await this.stamp.targetsOf(
					or(eq(activity.companyId, id), inArray(activity.dealId, dealIds)),
					tx,
				);

				await tx
					.delete(agentTask)
					.where(
						or(eq(agentTask.companyId, id), inArray(agentTask.dealId, dealIds)),
					);

				const [removed] = await tx
					.delete(company)
					.where(eq(company.id, id))
					.returning({ name: company.name });
				if (!removed) throw new NotFoundException(`No company with id ${id}.`);

				return { targets, name: removed.name };
			});
		} catch (error) {
			throw this.translate(error, id);
		}

		if (!deleted) return null;

		await this.stamp.recomputeAfterDelete(deleted.targets, { companyId: id });

		this.logger.log({
			message: "Company purged",
			companyId: id,
			name: deleted.name,
		});

		return { id, name: deleted.name };
	}

	async purgeExpired(before: Date): Promise<BulkResult> {
		const expired = await this.db
			.select({ id: company.id })
			.from(company)
			.where(lte(company.archivedAt, before))
			.limit(ARCHIVE.prune.maxBatch);

		return runBulk(
			expired.map((row) => row.id),
			(id) => this.purge(id, { archivedBefore: before }),
		);
	}

	async bulkAssignOwner(input: CompanyBulkOwnerInput): Promise<BulkResult> {
		const ownerId = input.ownerId || null;

		await requireOwner(this.db, ownerId);

		const ids = [...new Set(input.ids)];
		const count = (
			await this.db
				.update(company)
				.set({ ownerId })
				.where(inArray(company.id, ids))
				.returning({ id: company.id })
		).length;

		this.logger.log({
			message: "Companies reassigned",
			count,
			ownerId,
		});

		return {
			requested: ids.length,
			succeeded: count,
			skipped: 0,
			failed: ids.length - count,
			message: null,
		};
	}

	async bulkEnrich(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.enrich(id));
	}

	async bulkArchive(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.archive(id));
	}

	async bulkRestore(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.restore(id));
	}

	async bulkPurge(ids: string[]): Promise<BulkResult> {
		return runBulk(ids, (id) => this.purge(id));
	}

	async enrich(id: string): Promise<{ id: string; queued: boolean }> {
		const [record] = await this.db
			.select({ id: company.id, updatedAt: company.updatedAt })
			.from(company)
			.where(eq(company.id, id))
			.limit(1);

		if (!record) {
			throw new NotFoundException(`No company with id ${id}.`);
		}

		const queued = await this.agent.companyRequested(
			id,
			"A rep asked for a fresh look",
		);

		if (queued) {
			await this.db
				.update(company)
				.set({ enrichmentStatus: "PENDING", enrichmentError: null })
				.where(
					and(eq(company.id, id), eq(company.updatedAt, record.updatedAt)),
				);
		}

		return { id, queued };
	}

	async research(id: string, actingUserId: string) {
		const [record] = await this.db
			.select({ id: company.id, domain: company.domain })
			.from(company)
			.where(eq(company.id, id))
			.limit(1);

		if (!record) {
			throw new NotFoundException(`No company with id ${id}.`);
		}

		if (!record.domain) {
			throw new BadRequestException(
				"There is nothing to read without a domain — add one first.",
			);
		}

		const queued = await this.agent.companyRequested(
			id,
			`Briefing requested by a rep (${actingUserId})`,
		);

		return { ok: true as const, queued };
	}

	async setPrimaryContact(companyId: string, contactId: string | null) {
		if (contactId) {
			const [person] = await this.db
				.select({ companyId: contact.companyId })
				.from(contact)
				.where(eq(contact.id, contactId))
				.limit(1);
			if (!person) {
				throw new NotFoundException(`No contact with id ${contactId}.`);
			}
			if (person.companyId !== companyId) {
				throw new BadRequestException(
					"That contact does not work at this company.",
				);
			}
		}

		const [row] = await this.db
			.update(company)
			.set({ primaryContactId: contactId })
			.where(eq(company.id, companyId))
			.returning({ id: company.id, primaryContactId: company.primaryContactId })
			.catch((cause: unknown) => this.translate(cause, companyId));

		if (!row) throw new NotFoundException(`No company with id ${companyId}.`);

		return row;
	}

	private searchFilter(q: string): SQL | undefined {
		const term = q.trim();
		if (!term) return undefined;

		return or(
			contains(company.name, term, { insensitive: true }),
			contains(company.domain, term, { insensitive: true }),
		);
	}

	private buildWhere(
		input: CompanyListInput,
		filterableFields: FieldDefinitionWithOptions[],
	): SQL | undefined {
		const conditions: (SQL | undefined)[] = [
			this.searchFilter(input.q),
			archivedFilter(company.archivedAt, input.archived),
			...this.fields.fieldFilters("COMPANY", filterableFields, input.fields),
			ownerFilter(company.ownerId, input.owner),
		];

		if (input.industry.length > 0) {
			conditions.push(inArray(company.industry, input.industry));
		}
		if (input.enrichment.length > 0) {
			conditions.push(
				inArray(
					company.enrichmentStatus,
					input.enrichment as EnrichmentStatus[],
				),
			);
		}
		if (input.source.length > 0) {
			conditions.push(inArray(company.source, input.source as RecordSource[]));
		}

		conditions.push(activityFilter(company.lastActivityAt, input.activity));

		return and(...conditions);
	}

	private async facetCounts(
		input: CompanyListInput,
		filterableFields: FieldDefinitionWithOptions[],
	) {
		const where = and(
			this.searchFilter(input.q),
			archivedFilter(company.archivedAt, input.archived),
		);

		const [owners, industries, enrichment, sources, activity, fieldFacets] =
			await Promise.all([
				groupCounts(this.db, company, company.ownerId, where),
				groupCounts(this.db, company, company.industry, where),
				groupCounts(this.db, company, company.enrichmentStatus, where),
				groupCounts(this.db, company, company.source, where),
				activityFacetCounts(company.lastActivityAt, (activityWhere) =>
					this.db.$count(company, and(where, activityWhere)),
				),
				this.fields.filterFacetCounts("COMPANY", where, filterableFields),
			]);

		return {
			owner: countsByKey(owners, "value", FACET_UNASSIGNED),
			industry: countsByKey(industries, "value"),
			enrichment: countsByKey(enrichment, "value"),
			source: countsByKey(sources, "value"),
			activity,
			...Object.fromEntries(
				Object.entries(fieldFacets).map(([key, counts]) => [
					`field:${key}`,
					counts,
				]),
			),
		};
	}

	private translate(cause: unknown, _id: string): never {
		if (isUniqueViolation(cause)) {
			throw new ConflictException("Another company already uses that domain.");
		}
		throw cause;
	}

	private async backfillFavicons(
		companies: Array<{ id: string; domain: string | null }>,
	): Promise<void> {
		const queue = companies[Symbol.iterator]();
		const width = Math.min(COMPANY_IMPORT.faviconConcurrency, companies.length);
		await Promise.all(
			Array.from({ length: width }, async () => {
				for (const company of queue) {
					await this.favicon.backfill(company.id, company.domain);
				}
			}),
		);
	}
}
