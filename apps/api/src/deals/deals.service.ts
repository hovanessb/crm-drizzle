import {
	ActivityType,
	activity,
	agentTask,
	and,
	asc,
	company,
	contact,
	contains,
	type Db,
	type DealStage,
	deal,
	dealContact,
	desc,
	eq,
	gte,
	hasValues,
	inArray,
	isForeignKeyViolation,
	isNull,
	lt,
	lte,
	type NewDeal,
	notInArray,
	or,
	type SQL,
	sum,
	user,
} from "@crm/db";
import { normalizeCurrency } from "@crm/db/currency";
import {
	CLOSED_DEAL_STAGES,
	isClosedStage,
	LOSING_DEAL_STAGES,
	OPEN_DEAL_STAGES,
} from "@crm/db/deal-stage";
import type { FieldDefinitionWithOptions } from "@crm/db/fields";
import {
	BadRequestException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ARCHIVE } from "../archive/archive-config";
import {
	ActivityStampService,
	type StampTargets,
} from "../crm/activity-stamp.service";
import { type BulkResult, requireOwner, runBulk } from "../crm/bulk";
import { blankToNull, decimalFromCents, toCents } from "../crm/values";
import { ConversionService } from "../currency/conversion.service";
import { InjectDatabase } from "../database/database.constants";
import { FieldsService } from "../fields/fields.service";
import {
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
	ClosingWindow,
	DealAttachContactInput,
	DealBulkOwnerInput,
	DealBulkStageInput,
	DealContactRoleInput,
	DealCreateInput,
	DealDetachContactInput,
	DealListInput,
	DealUpdateInput,
	SetStageInput,
} from "./deals.contracts";
import { CLOSING_WINDOWS } from "./deals.contracts";

const OWNER_COLUMNS = {
	id: true,
	name: true,
	email: true,
	image: true,
} as const;

const COMPANY_COLUMNS = {
	id: true,
	name: true,
	domain: true,
	iconUrl: true,
	iconDarkUrl: true,
	iconTone: true,
	logoUrl: true,
} as const;

const CONTACT_COLUMNS = {
	id: true,
	firstName: true,
	lastName: true,
	email: true,
	title: true,
	imageUrl: true,
} as const;

const OWNER_FIELDS = {
	id: user.id,
	name: user.name,
	email: user.email,
	image: user.image,
};

const COMPANY_FIELDS = {
	id: company.id,
	name: company.name,
	domain: company.domain,
	iconUrl: company.iconUrl,
	iconDarkUrl: company.iconDarkUrl,
	iconTone: company.iconTone,
	logoUrl: company.logoUrl,
};

const CONTACT_FIELDS = {
	id: contact.id,
	firstName: contact.firstName,
	lastName: contact.lastName,
	email: contact.email,
	title: contact.title,
	imageUrl: contact.imageUrl,
};

const LOSING = new Set<DealStage>(LOSING_DEAL_STAGES);

const SORTABLE: OrderByColumns<SQL[]> = {
	name: (dir) => [sortBy(deal.name, dir)],
	company: (dir) => [sortBy(company.name, dir), asc(deal.name)],
	stage: (dir) => [sortBy(deal.stage, dir), asc(deal.expectedCloseDate)],
	amount: (dir) => [sortNullsLast(deal.baseAmount, dir)],
	expectedCloseDate: (dir) => [sortBy(deal.expectedCloseDate, dir)],
	createdAt: (dir) => [sortBy(deal.createdAt, dir)],
	owner: (dir) => [sortBy(user.name, dir), asc(deal.name)],
	lastActivity: (dir) => [sortNullsLast(deal.lastActivityAt, dir)],
	archivedAt: (dir) => [sortNullsLast(deal.archivedAt, dir)],
};

@Injectable()
export class DealsService {
	private readonly logger = new Logger(DealsService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
		private readonly stamp: ActivityStampService,
		private readonly conversion: ConversionService,
		private readonly fields: FieldsService,
	) {}

	async list(input: DealListInput) {
		const filterableFields = await this.fields.filterableFieldsFor("DEAL");
		const where = this.buildWhere(input, filterableFields);
		const { skip, take } = paginate(input);

		const openWhere = and(where, inArray(deal.stage, [...OPEN_DEAL_STAGES]));
		const base = await this.conversion.reportingCurrency();

		const [rows, total, facetCounts, openValue, unconverted] =
			await Promise.all([
				this.db
					.select({
						id: deal.id,
						name: deal.name,
						stage: deal.stage,
						amount: deal.amount,
						currency: deal.currency,
						baseAmount: deal.baseAmount,
						expectedCloseDate: deal.expectedCloseDate,
						closedAt: deal.closedAt,
						company: COMPANY_FIELDS,
						owner: OWNER_FIELDS,
						lastActivityAt: deal.lastActivityAt,
						createdAt: deal.createdAt,
						archivedAt: deal.archivedAt,
					})
					.from(deal)
					.innerJoin(company, eq(company.id, deal.companyId))
					.innerJoin(user, eq(user.id, deal.ownerId))
					.where(where)
					.orderBy(...resolveOrderBy(input, SORTABLE, [desc(deal.createdAt)]))
					.limit(take)
					.offset(skip),
				this.db.$count(deal, where),
				this.facetCounts(input, filterableFields),
				this.db
					.select({ baseAmount: sum(deal.baseAmount).mapWith(deal.baseAmount) })
					.from(deal)
					.where(and(openWhere, this.conversion.countedWhere(base)))
					.then(([row]) => row?.baseAmount ?? null),
				this.conversion.unconverted(openWhere),
			]);

		const tableFields = await this.fields.tableValuesFor(
			"DEAL",
			rows.map((row) => row.id),
		);

		return {
			rows: rows.map(
				({
					amount,
					baseAmount,
					expectedCloseDate,
					closedAt,
					lastActivityAt,
					createdAt,
					archivedAt,
					...row
				}) => ({
					...row,
					amountCents: toCents(amount),
					baseAmountCents: toCents(baseAmount),
					expectedCloseDate: expectedCloseDate?.toISOString() ?? null,
					closedAt: closedAt?.toISOString() ?? null,
					lastActivityAt: lastActivityAt?.toISOString() ?? null,
					createdAt: createdAt.toISOString(),
					archivedAt: archivedAt?.toISOString() ?? null,
					fields: tableFields.get(row.id) ?? {},
				}),
			),
			total,
			facetCounts,
			openValueCents: toCents(openValue),
			reportingCurrency: base,
			unconverted,
		} satisfies ListResult<unknown> & {
			openValueCents: number | null;
			reportingCurrency: string;
			unconverted: { count: number; currencies: string[] };
		};
	}

	async byId(id: string) {
		const record = await this.db.query.deal.findFirst({
			where: eq(deal.id, id),
			columns: {
				id: true,
				name: true,
				description: true,
				stage: true,
				stageChangedAt: true,
				amount: true,
				currency: true,
				baseAmount: true,
				fxRate: true,
				fxRateAt: true,
				expectedCloseDate: true,
				closedAt: true,
				closedReason: true,
				createdAt: true,
				archivedAt: true,
			},
			with: {
				company: { columns: { ...COMPANY_COLUMNS, industry: true } },
				owner: { columns: OWNER_COLUMNS },
				contacts: {
					columns: { role: true },
					with: { contact: { columns: CONTACT_COLUMNS } },
				},
			},
		});

		if (!record) {
			throw new NotFoundException(`No deal with id ${id}.`);
		}

		const {
			contacts,
			amount,
			baseAmount,
			fxRate,
			fxRateAt,
			archivedAt,
			...rest
		} = record;

		return {
			...rest,
			fields: await this.fields.valuesFor("DEAL", id),
			amountCents: toCents(amount),
			baseAmountCents: toCents(baseAmount),
			reportingCurrency: await this.conversion.reportingCurrency(),
			fxRate: fxRate?.toNumber() ?? null,
			fxRateAt: fxRateAt?.toISOString() ?? null,
			stageChangedAt: record.stageChangedAt.toISOString(),
			expectedCloseDate: record.expectedCloseDate?.toISOString() ?? null,
			closedAt: record.closedAt?.toISOString() ?? null,
			createdAt: record.createdAt.toISOString(),
			archivedAt: archivedAt?.toISOString() ?? null,
			contacts: contacts
				.map(({ role, contact: person }) => ({ ...person, role }))
				.toSorted((left, right) =>
					left.firstName.localeCompare(right.firstName),
				),
		};
	}

	async create(input: DealCreateInput) {
		const stage = input.stage ?? "DEMO_BOOKED";
		const closed = isClosedStage(stage);
		const now = new Date();

		const currency = normalizeCurrency(
			input.currency ?? (await this.conversion.reportingCurrency()),
		);
		const fx = await this.conversion.dealFields(
			decimalFromCents(input.amountCents),
			currency,
		);

		try {
			const created = await this.agent.withCrmEvents(async (tx, emit) => {
				const [inserted] = await tx
					.insert(deal)
					.values({
						name: input.name.trim(),
						companyId: input.companyId,
						ownerId: input.ownerId,
						stage,
						stageChangedAt: now,
						closedAt: closed ? now : null,
						amount: decimalFromCents(input.amountCents),
						currency,
						...fx,
						expectedCloseDate: parseDate(input.expectedCloseDate),
					})
					.returning({
						id: deal.id,
						name: deal.name,
						companyId: deal.companyId,
					});
				if (!inserted) throw new Error("The deal insert returned no row.");
				const created = inserted;
				await emit({
					type: "deal.created",
					record: { kind: "deal", id: created.id },
					occurredAt: now,
					data: { companyId: created.companyId, stage },
				});
				if (closed) {
					await emit({
						type: "deal.closed",
						record: { kind: "deal", id: created.id },
						occurredAt: now,
						data: { companyId: created.companyId, from: null, to: stage },
					});
				}
				return created;
			});

			this.logger.log({ message: "Deal created", dealId: created.id, stage });

			void this.fields.queueBackfillForNewRecord("DEAL", created.id);

			return created;
		} catch (error) {
			throw this.translateRelations(error);
		}
	}

	async update(id: string, input: DealUpdateInput) {
		const data: Partial<NewDeal> = {};

		if (input.name !== undefined) data.name = input.name.trim();
		if (input.description !== undefined) {
			data.description =
				input.description === null ? null : blankToNull(input.description);
		}
		if (input.companyId !== undefined) data.companyId = input.companyId;
		if (input.ownerId !== undefined) data.ownerId = input.ownerId;
		if (input.amountCents !== undefined) {
			data.amount = decimalFromCents(input.amountCents);
		}
		if (input.currency !== undefined) {
			data.currency = normalizeCurrency(input.currency);
		}
		if (input.expectedCloseDate !== undefined) {
			data.expectedCloseDate = parseDate(input.expectedCloseDate);
		}

		if (input.amountCents !== undefined || input.currency !== undefined) {
			const [current] = await this.db
				.select({ amount: deal.amount, currency: deal.currency })
				.from(deal)
				.where(eq(deal.id, id))
				.limit(1);

			if (!current) {
				throw new NotFoundException(`No deal with id ${id}.`);
			}

			const amount =
				input.amountCents !== undefined
					? decimalFromCents(input.amountCents)
					: current.amount;
			const currency =
				input.currency !== undefined
					? normalizeCurrency(input.currency)
					: normalizeCurrency(current.currency);

			Object.assign(data, await this.conversion.dealFields(amount, currency));
		}

		try {
			return await this.db.transaction(async (tx) => {
				if (input.fields) {
					await this.fields.applyValues(tx, "DEAL", id, input.fields);
				}

				const fields = { id: deal.id, name: deal.name };
				const [updated] = hasValues(data)
					? await tx
							.update(deal)
							.set(data)
							.where(eq(deal.id, id))
							.returning(fields)
					: await tx.select(fields).from(deal).where(eq(deal.id, id)).limit(1);
				if (!updated) throw new NotFoundException(`No deal with id ${id}.`);
				return updated;
			});
		} catch (error) {
			throw this.translate(error, id);
		}
	}

	async archive(id: string): Promise<{ id: string; name: string }> {
		const name = await this.setArchivedAt(id, new Date());
		this.logger.log({ message: "Deal archived", dealId: id });
		return { id, name };
	}

	async restore(id: string): Promise<{ id: string; name: string }> {
		const name = await this.setArchivedAt(id, null);
		this.logger.log({ message: "Deal restored", dealId: id });
		return { id, name };
	}

	private async setArchivedAt(
		id: string,
		archivedAt: Date | null,
	): Promise<string> {
		const [row] = await this.db
			.update(deal)
			.set({ archivedAt })
			.where(eq(deal.id, id))
			.returning({ name: deal.name });

		if (!row) throw new NotFoundException(`No deal with id ${id}.`);

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
					.select({ archivedAt: deal.archivedAt })
					.from(deal)
					.where(eq(deal.id, id))
					.for("update");

				if (!row) {
					if (guard) return null;
					throw new NotFoundException(`No deal with id ${id}.`);
				}
				if (
					guard &&
					(!row.archivedAt || row.archivedAt > guard.archivedBefore)
				) {
					return null;
				}

				const targets = await this.stamp.targetsOf(eq(activity.dealId, id), tx);
				await tx.delete(agentTask).where(eq(agentTask.dealId, id));

				const [removed] = await tx
					.delete(deal)
					.where(eq(deal.id, id))
					.returning({ name: deal.name });
				if (!removed) throw new NotFoundException(`No deal with id ${id}.`);

				return { targets, name: removed.name };
			});
		} catch (error) {
			throw this.translate(error, id);
		}

		if (!deleted) return null;

		await this.stamp.recomputeAfterDelete(deleted.targets, { dealId: id });

		this.logger.log({
			message: "Deal purged",
			dealId: id,
			name: deleted.name,
		});

		return { id, name: deleted.name };
	}

	async purgeExpired(before: Date): Promise<BulkResult> {
		const expired = await this.db
			.select({ id: deal.id })
			.from(deal)
			.where(lte(deal.archivedAt, before))
			.limit(ARCHIVE.prune.maxBatch);

		return runBulk(
			expired.map((row) => row.id),
			(id) => this.purge(id, { archivedBefore: before }),
		);
	}

	async setStage(input: SetStageInput, actingUserId: string) {
		const closedReason = input.closedReason?.trim();
		const closed = isClosedStage(input.stage);
		const transition = await this.agent.withCrmEvents(async (tx, emit) => {
			const [current] = await tx
				.select({ id: deal.id, stage: deal.stage, companyId: deal.companyId })
				.from(deal)
				.where(eq(deal.id, input.id))
				.for("update");

			if (!current) {
				throw new NotFoundException(`No deal with id ${input.id}.`);
			}

			if (current.stage === input.stage) {
				return {
					changed: false as const,
					deal: current,
					updated: { id: current.id, stage: current.stage },
					now: null,
				};
			}
			if (LOSING.has(input.stage) && !closedReason) {
				throw new BadRequestException(
					"Say why it was lost — a closed-lost deal with no reason teaches nobody anything.",
				);
			}

			const now = new Date();
			const [updated] = await tx
				.update(deal)
				.set({
					stage: input.stage,
					stageChangedAt: now,
					closedAt: closed ? now : null,
					closedReason: closed ? (closedReason ?? null) : null,
				})
				.where(eq(deal.id, input.id))
				.returning({ id: deal.id, stage: deal.stage });
			if (!updated) throw new NotFoundException(`No deal with id ${input.id}.`);
			const record = current;
			await tx.insert(activity).values({
				type: ActivityType.STAGE_CHANGE,
				subject: "Stage changed",
				body: closedReason ?? null,
				occurredAt: now,
				companyId: record.companyId,
				dealId: record.id,
				createdById: actingUserId,
				meta: { from: record.stage, to: input.stage },
			});
			await emit({
				type: "deal.stage.changed",
				record: { kind: "deal", id: record.id },
				occurredAt: now,
				data: {
					companyId: record.companyId,
					from: record.stage,
					to: input.stage,
				},
			});
			if (!isClosedStage(record.stage) && closed) {
				await emit({
					type: "deal.closed",
					record: { kind: "deal", id: record.id },
					occurredAt: now,
					data: {
						companyId: record.companyId,
						from: record.stage,
						to: input.stage,
					},
				});
			}
			if (isClosedStage(record.stage) && !closed) {
				await emit({
					type: "deal.opened",
					record: { kind: "deal", id: record.id },
					occurredAt: now,
					data: {
						companyId: record.companyId,
						from: record.stage,
						to: input.stage,
					},
				});
			}

			return { changed: true as const, deal: record, updated, now };
		});

		if (!transition.changed) {
			return { ...transition.updated, changed: false };
		}

		const { deal: changed, updated, now } = transition;

		await this.stamp.touch(
			{ companyId: changed.companyId, dealId: changed.id },
			now,
		);

		this.logger.log({
			message: "Deal stage changed",
			dealId: changed.id,
			from: changed.stage,
			to: input.stage,
		});

		return { ...updated, changed: true };
	}

	async contactOptions(dealId: string) {
		const record = await this.db.query.deal.findFirst({
			where: eq(deal.id, dealId),
			columns: { companyId: true },
			with: { contacts: { columns: { contactId: true } } },
		});

		if (!record) {
			throw new NotFoundException(`No deal with id ${dealId}.`);
		}

		const attached = record.contacts.map((row) => row.contactId);

		return this.db
			.select(CONTACT_FIELDS)
			.from(contact)
			.where(
				and(
					eq(contact.companyId, record.companyId),
					attached.length > 0 ? notInArray(contact.id, attached) : undefined,
				),
			)
			.orderBy(asc(contact.firstName), asc(contact.lastName))
			.limit(100);
	}

	async attachContact(input: DealAttachContactInput) {
		const owningCompany = await this.companyOf(input.dealId);
		const [person] = await this.db
			.select({ companyId: contact.companyId })
			.from(contact)
			.where(eq(contact.id, input.contactId))
			.limit(1);

		if (!person) {
			throw new NotFoundException(`No contact with id ${input.contactId}.`);
		}

		if (person.companyId !== owningCompany.id) {
			throw new BadRequestException(
				`That contact does not work at ${owningCompany.name}.`,
			);
		}

		const role = roleOrNull(input.role ?? null);

		const insert = this.db
			.insert(dealContact)
			.values({ dealId: input.dealId, contactId: input.contactId, role });
		const target = [dealContact.dealId, dealContact.contactId];
		await (role === null
			? insert.onConflictDoNothing({ target })
			: insert.onConflictDoUpdate({ target, set: { role } }));

		this.logger.log({
			message: "Contact attached to deal",
			dealId: input.dealId,
			contactId: input.contactId,
		});

		return { dealId: input.dealId, contactId: input.contactId };
	}

	async detachContact(input: DealDetachContactInput) {
		const removed = await this.db
			.delete(dealContact)
			.where(
				and(
					eq(dealContact.dealId, input.dealId),
					eq(dealContact.contactId, input.contactId),
				),
			)
			.returning({ dealId: dealContact.dealId });

		if (removed.length === 0) {
			throw new NotFoundException("That contact is not on this deal.");
		}

		this.logger.log({
			message: "Contact detached from deal",
			dealId: input.dealId,
			contactId: input.contactId,
		});

		return { dealId: input.dealId, contactId: input.contactId };
	}

	async setContactRole(input: DealContactRoleInput) {
		const role = roleOrNull(input.role);

		const changed = await this.db
			.update(dealContact)
			.set({ role })
			.where(
				and(
					eq(dealContact.dealId, input.dealId),
					eq(dealContact.contactId, input.contactId),
				),
			)
			.returning({ dealId: dealContact.dealId });

		if (changed.length === 0) {
			throw new NotFoundException("That contact is not on this deal.");
		}

		return { dealId: input.dealId, contactId: input.contactId, role };
	}

	async bulkAssignOwner(input: DealBulkOwnerInput): Promise<BulkResult> {
		await requireOwner(this.db, input.ownerId);

		const ids = [...new Set(input.ids)];
		const count = (
			await this.db
				.update(deal)
				.set({ ownerId: input.ownerId })
				.where(inArray(deal.id, ids))
				.returning({ id: deal.id })
		).length;

		this.logger.log({
			message: "Deals reassigned",
			count,
			ownerId: input.ownerId,
		});

		return {
			requested: ids.length,
			succeeded: count,
			skipped: 0,
			failed: ids.length - count,
			message: null,
		};
	}

	async bulkSetStage(
		input: DealBulkStageInput,
		actingUserId: string,
	): Promise<BulkResult> {
		const closedReason = input.closedReason?.trim();

		if (LOSING.has(input.stage) && !closedReason) {
			throw new BadRequestException(
				"Say why they were lost — a closed-lost deal with no reason teaches nobody anything.",
			);
		}

		return runBulk(input.ids, (id) =>
			this.setStage({ id, stage: input.stage, closedReason }, actingUserId),
		);
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

	private async companyOf(dealId: string) {
		const [row] = await this.db
			.select({ id: company.id, name: company.name })
			.from(deal)
			.innerJoin(company, eq(company.id, deal.companyId))
			.where(eq(deal.id, dealId))
			.limit(1);

		if (!row) {
			throw new NotFoundException(`No deal with id ${dealId}.`);
		}

		return row;
	}

	private searchFilter(q: string): SQL | undefined {
		const term = q.trim();
		if (!term) return undefined;

		return or(
			contains(deal.name, term, { insensitive: true }),
			inArray(
				deal.companyId,
				this.db
					.select({ id: company.id })
					.from(company)
					.where(contains(company.name, term, { insensitive: true })),
			),
		);
	}

	private buildWhere(
		input: DealListInput,
		filterableFields: FieldDefinitionWithOptions[],
	): SQL | undefined {
		const conditions: (SQL | undefined)[] = [
			this.searchFilter(input.q),
			archivedFilter(deal.archivedAt, input.archived),
			...this.fields.fieldFilters("DEAL", filterableFields, input.fields),
			ownerFilter(deal.ownerId, input.owner),
		];

		if (input.status === "open") {
			conditions.push(inArray(deal.stage, [...OPEN_DEAL_STAGES]));
		} else if (input.status === "closed") {
			conditions.push(inArray(deal.stage, [...CLOSED_DEAL_STAGES]));
		}

		if (input.stage.length > 0) {
			conditions.push(inArray(deal.stage, input.stage as DealStage[]));
		}

		if (input.closing.length > 0) {
			conditions.push(
				or(
					...input.closing.map((window) =>
						closingFilter(window as ClosingWindow),
					),
				),
			);
		}

		return and(...conditions);
	}

	private async facetCounts(
		input: DealListInput,
		filterableFields: FieldDefinitionWithOptions[],
	) {
		const where = and(
			this.searchFilter(input.q),
			archivedFilter(deal.archivedAt, input.archived),
		);

		const [owners, stages, fieldFacets, ...closingCounts] = await Promise.all([
			groupCounts(this.db, deal, deal.ownerId, where),
			groupCounts(this.db, deal, deal.stage, where),
			this.fields.filterFacetCounts("DEAL", where, filterableFields),
			...CLOSING_WINDOWS.map((window) =>
				this.db.$count(deal, and(where, closingFilter(window))),
			),
		]);

		const stageCounts = countsByKey(stages, "value");
		const openCount = OPEN_DEAL_STAGES.reduce(
			(total, stage) => total + (stageCounts[stage] ?? 0),
			0,
		);
		const closedCount = CLOSED_DEAL_STAGES.reduce(
			(total, stage) => total + (stageCounts[stage] ?? 0),
			0,
		);

		return {
			status: { open: openCount, closed: closedCount },
			owner: countsByKey(owners, "value", FACET_UNASSIGNED),
			stage: stageCounts,
			closing: Object.fromEntries(
				CLOSING_WINDOWS.map((window, index) => [
					window,
					closingCounts[index] ?? 0,
				]),
			),
			...Object.fromEntries(
				Object.entries(fieldFacets).map(([key, counts]) => [
					`field:${key}`,
					counts,
				]),
			),
		};
	}

	private translate(cause: unknown, _id: string): never {
		return this.translateRelations(cause);
	}

	private translateRelations(cause: unknown): never {
		if (isForeignKeyViolation(cause)) {
			throw new BadRequestException(
				"That company or owner does not exist any more.",
			);
		}
		throw cause;
	}
}

function closingFilter(window: ClosingWindow): SQL | undefined {
	const now = new Date();
	const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	const startOfMonthAfter = new Date(now.getFullYear(), now.getMonth() + 2, 1);

	switch (window) {
		case "overdue":
			return and(
				lt(deal.expectedCloseDate, now),
				inArray(deal.stage, [...OPEN_DEAL_STAGES]),
			);
		case "this-month":
			return and(
				gte(deal.expectedCloseDate, startOfMonth),
				lt(deal.expectedCloseDate, startOfNextMonth),
			);
		case "next-month":
			return and(
				gte(deal.expectedCloseDate, startOfNextMonth),
				lt(deal.expectedCloseDate, startOfMonthAfter),
			);
		case "later":
			return gte(deal.expectedCloseDate, startOfMonthAfter);
		case "none":
			return isNull(deal.expectedCloseDate);
	}
}

function roleOrNull(value: string | null): string | null {
	return value === null ? null : blankToNull(value);
}

function parseDate(value: string | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new BadRequestException(`"${value}" is not a date.`);
	}
	return date;
}
