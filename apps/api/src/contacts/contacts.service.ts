import {
	activity,
	agentEvent,
	agentTask,
	and,
	asc,
	type ContactBriefSections,
	calendarAttendee,
	calendarEvent,
	company,
	contact,
	contactFact,
	contains,
	count,
	type Db,
	desc,
	type Executor,
	emailMessage,
	emailThread,
	eq,
	equalsInsensitive,
	exists,
	type FactEvidence,
	FactStatus,
	gt,
	hasValues,
	inArray,
	isNull,
	isUniqueViolation,
	lte,
	type NewContact,
	ne,
	or,
	type RecordSource,
	type SQL,
	sql,
	sum,
	suppressedContact,
	user,
} from "@crm/db";
import type { FieldDefinitionWithOptions } from "@crm/db/fields";
import {
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { AgentQueueService } from "../agent/agent-queue.service";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ARCHIVE } from "../archive/archive-config";
import { CompanyDirectoryService } from "../companies/company-directory.service";
import {
	ActivityStampService,
	type StampTargets,
} from "../crm/activity-stamp.service";
import { type BulkResult, requireOwner, runBulk } from "../crm/bulk";
import { blankToNull, normalizeEmail, toCents } from "../crm/values";
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
	splitSentinel,
} from "../trpc/list-input";
import type {
	ContactBulkCompanyInput,
	ContactBulkOwnerInput,
	ContactCreateInput,
	ContactListInput,
	ContactRow,
	ContactUpdateInput,
	FactDecisionInput,
} from "./contacts.contracts";

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

const NO_COMPANY = "none";

type FactColumn =
	| "title"
	| "seniority"
	| "function"
	| "linkedinUrl"
	| "twitterUrl"
	| "githubUrl";

type FactColumns = Record<string, FactColumn | undefined>;

const FACT_COLUMNS: FactColumns = {
	title: "title",
	seniority: "seniority",
	function: "function",
	linkedinUrl: "linkedinUrl",
	twitterUrl: "twitterUrl",
	githubUrl: "githubUrl",
};

const _by = (column: Parameters<typeof asc>[0], dir: "asc" | "desc") =>
	dir === "asc" ? asc(column) : desc(column);

const _nullsLast = (column: Parameters<typeof asc>[0], dir: "asc" | "desc") =>
	dir === "asc"
		? sql`${column} asc nulls last`
		: sql`${column} desc nulls last`;

const SORTABLE: OrderByColumns<SQL[]> = {
	name: (dir) => [
		sortBy(contact.lastName, dir),
		sortBy(contact.firstName, dir),
	],
	email: (dir) => [sortBy(contact.email, dir)],
	title: (dir) => [sortBy(contact.title, dir), asc(contact.lastName)],
	company: (dir) => [sortBy(company.name, dir), asc(contact.lastName)],
	createdAt: (dir) => [sortBy(contact.createdAt, dir)],
	owner: (dir) => [sortBy(user.name, dir), asc(contact.lastName)],
	lastActivity: (dir) => [sortNullsLast(contact.lastActivityAt, dir)],
	archivedAt: (dir) => [sortNullsLast(contact.archivedAt, dir)],
};

@Injectable()
export class ContactsService {
	private readonly logger = new Logger(ContactsService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly companies: CompanyDirectoryService,
		private readonly agent: AgentTriggerService,
		private readonly queue: AgentQueueService,
		private readonly stamp: ActivityStampService,
		private readonly fields: FieldsService,
	) {}

	async list(input: ContactListInput): Promise<ListResult<ContactRow>> {
		const filterableFields = await this.fields.filterableFieldsFor("CONTACT");
		const where = this.buildWhere(input, filterableFields);
		const { skip, take } = paginate(input);

		const [rows, total, facetCounts] = await Promise.all([
			this.db
				.select({
					id: contact.id,
					firstName: contact.firstName,
					lastName: contact.lastName,
					email: contact.email,
					title: contact.title,
					imageUrl: contact.imageUrl,
					source: contact.source,
					company: COMPANY_FIELDS,
					owner: OWNER_FIELDS,
					lastActivityAt: contact.lastActivityAt,
					createdAt: contact.createdAt,
					archivedAt: contact.archivedAt,
				})
				.from(contact)
				.leftJoin(company, eq(company.id, contact.companyId))
				.leftJoin(user, eq(user.id, contact.ownerId))
				.where(where)
				.orderBy(...resolveOrderBy(input, SORTABLE, [desc(contact.createdAt)]))
				.limit(take)
				.offset(skip),
			this.db.$count(contact, where),
			this.facetCounts(input, filterableFields),
		]);

		const tableFields = await this.fields.tableValuesFor(
			"CONTACT",
			rows.map((row) => row.id),
		);

		return {
			rows: rows.map((row) => ({
				...row,
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
		const record = await this.db.query.contact.findFirst({
			where: eq(contact.id, id),
			columns: {
				id: true,
				firstName: true,
				lastName: true,
				email: true,
				phone: true,
				title: true,
				linkedinUrl: true,
				twitterUrl: true,
				githubUrl: true,
				imageUrl: true,
				enrichmentStatus: true,
				enrichmentError: true,
				createdAt: true,
				archivedAt: true,
			},
			with: {
				brief: {
					columns: {
						narrative: true,
						sections: true,
						score: true,
						sourceUrl: true,
						refreshedAt: true,
					},
				},
				facts: {
					where: inArray(contactFact.status, [
						FactStatus.APPLIED,
						FactStatus.PROPOSED,
					]),
					orderBy: [desc(contactFact.observedAt)],
					columns: {
						id: true,
						field: true,
						value: true,
						score: true,
						band: true,
						evidence: true,
						method: true,
						sourceUrl: true,
						status: true,
						observedAt: true,
					},
				},
				company: {
					columns: {
						...COMPANY_COLUMNS,
						industry: true,
						primaryContactId: true,
					},
				},
				owner: { columns: OWNER_COLUMNS },
				deals: {
					columns: { role: true },
					with: {
						deal: {
							columns: {
								id: true,
								name: true,
								stage: true,
								amount: true,
								currency: true,
								expectedCloseDate: true,
							},
							with: { owner: { columns: OWNER_COLUMNS } },
						},
					},
				},
			},
		});

		if (!record) {
			throw new NotFoundException(`No contact with id ${id}.`);
		}

		const relationship = await this.relationship(
			id,
			record.company?.id ?? null,
		);

		const {
			deals,
			createdAt,
			archivedAt,
			brief,
			facts,
			company: owningCompany,
			...rest
		} = record;

		return {
			...rest,
			company: owningCompany,
			fields: await this.fields.valuesFor("CONTACT", id),
			queued: await this.queue.isQueued({ contactId: id }),
			createdAt: createdAt.toISOString(),
			archivedAt: archivedAt?.toISOString() ?? null,
			brief: brief
				? {
						...brief,
						sections: brief.sections as ContactBriefSections,
						refreshedAt: brief.refreshedAt.toISOString(),
					}
				: null,
			facts: facts.map((fact) => ({
				...fact,
				evidence: fact.evidence as FactEvidence[],
				observedAt: fact.observedAt.toISOString(),
			})),
			relationship,
			isPrimaryContact: owningCompany?.primaryContactId === record.id,
			deals: deals.map(({ role, deal }) => ({
				...deal,
				role,
				amount: undefined,
				amountCents: toCents(deal.amount),
				expectedCloseDate: deal.expectedCloseDate?.toISOString() ?? null,
			})),
		};
	}

	async create(input: ContactCreateInput) {
		const email = normalizeEmail(input.email ?? "");

		if (email) {
			const [existing] = await this.db
				.select({
					id: contact.id,
					firstName: contact.firstName,
					lastName: contact.lastName,
				})
				.from(contact)
				.where(
					and(
						equalsInsensitive(contact.email, email),
						isNull(contact.archivedAt),
					),
				)
				.limit(1);
			if (existing) {
				throw new ConflictException(
					`${[existing.firstName, existing.lastName].filter(Boolean).join(" ")} already uses ${email}.`,
				);
			}
		}

		const companyId =
			input.companyId ??
			(email
				? await this.companies.companyForEmail(email, {
						ownerId: input.ownerId,
					})
				: null);

		const created = await this.agent.withCrmEvents(async (tx, emit) => {
			await this.allowAgain(tx, email);

			const [inserted] = await tx
				.insert(contact)
				.values({
					firstName: input.firstName.trim(),
					lastName: blankToNull(input.lastName ?? ""),
					email,
					phone: blankToNull(input.phone ?? ""),
					title: blankToNull(input.title ?? ""),
					companyId,
					ownerId: input.ownerId ?? null,
				})
				.returning({
					id: contact.id,
					firstName: contact.firstName,
					lastName: contact.lastName,
					email: contact.email,
					companyId: contact.companyId,
					createdAt: contact.createdAt,
				})
				.catch((cause: unknown) => this.translate(cause, ""));
			if (!inserted) throw new Error("The contact insert returned no row.");
			const created = inserted;
			await emit({
				type: "contact.created",
				record: { kind: "contact", id: created.id },
				occurredAt: created.createdAt,
				data: {
					firstName: created.firstName,
					lastName: created.lastName,
					email: created.email,
					companyId: created.companyId,
				},
			});
			return created;
		});

		this.logger.log({ message: "Contact created", contactId: created.id });

		await this.agent.contactCreated(
			created.id,
			"Added by a rep, with nothing on the record yet",
		);
		this.fields
			.queueBackfillForNewRecord("CONTACT", created.id)
			.catch((error: Error) => {
				this.logger.error(
					{
						message: "Contact backfill queueing failed",
						contactId: created.id,
					},
					error.stack,
				);
			});

		return {
			id: created.id,
			firstName: created.firstName,
			lastName: created.lastName,
		};
	}

	async archive(id: string): Promise<{ id: string; name: string }> {
		const name = await this.setArchivedAt(id, new Date());
		this.logger.log({ message: "Contact archived", contactId: id });
		return { id, name };
	}

	async restore(id: string): Promise<{ id: string; name: string }> {
		const name = await this.setArchivedAt(id, null);
		this.logger.log({ message: "Contact restored", contactId: id });
		return { id, name };
	}

	private async setArchivedAt(
		id: string,
		archivedAt: Date | null,
	): Promise<string> {
		const [row] = await this.db
			.update(contact)
			.set({ archivedAt })
			.where(eq(contact.id, id))
			.returning({ firstName: contact.firstName, lastName: contact.lastName })
			.catch((cause: unknown) => this.translate(cause, id));

		if (!row) throw new NotFoundException(`No contact with id ${id}.`);

		return nameOf(row);
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
		let deleted: {
			targets: StampTargets;
			name: string;
			suppressed: boolean;
		} | null;

		try {
			deleted = await this.db.transaction(async (tx) => {
				const [row] = await tx
					.select({ archivedAt: contact.archivedAt })
					.from(contact)
					.where(eq(contact.id, id))
					.for("update");

				if (!row) {
					if (guard) return null;
					throw new NotFoundException(`No contact with id ${id}.`);
				}
				if (
					guard &&
					(!row.archivedAt || row.archivedAt > guard.archivedBefore)
				) {
					return null;
				}

				const targets = await this.stamp.targetsOf(
					eq(activity.contactId, id),
					tx,
				);

				await tx.delete(agentTask).where(eq(agentTask.contactId, id));
				await tx.delete(agentEvent).where(eq(agentEvent.contactId, id));

				const [removed] = await tx
					.delete(contact)
					.where(eq(contact.id, id))
					.returning({
						firstName: contact.firstName,
						lastName: contact.lastName,
						email: contact.email,
					});
				if (!removed) throw new NotFoundException(`No contact with id ${id}.`);

				const name = nameOf(removed);
				const suppress = normalizeEmail(removed.email ?? "");

				if (suppress) {
					await tx
						.insert(suppressedContact)
						.values({
							email: suppress,
							reason: `Deleted from the CRM (${name})`,
						})
						.onConflictDoNothing({ target: suppressedContact.email });
				}

				return { targets, name, suppressed: suppress !== null };
			});
		} catch (error) {
			throw this.translate(error, id);
		}

		if (!deleted) return null;

		await this.stamp.recomputeAfterDelete(deleted.targets, { contactId: id });

		this.logger.log({
			message: "Contact purged",
			contactId: id,
			suppressed: deleted.suppressed,
		});

		return { id, name: deleted.name };
	}

	async purgeExpired(before: Date): Promise<BulkResult> {
		const expired = await this.db
			.select({ id: contact.id })
			.from(contact)
			.where(lte(contact.archivedAt, before))
			.limit(ARCHIVE.prune.maxBatch);

		return runBulk(
			expired.map((row) => row.id),
			(id) => this.purge(id, { archivedBefore: before }),
		);
	}

	async update(id: string, input: ContactUpdateInput) {
		const data: Partial<NewContact> = {};

		if (input.firstName !== undefined) data.firstName = input.firstName.trim();
		if (input.lastName !== undefined)
			data.lastName = blankToNull(input.lastName);
		const email =
			input.email === undefined ? null : normalizeEmail(input.email);
		if (input.email !== undefined) data.email = email;
		if (input.phone !== undefined) data.phone = blankToNull(input.phone);
		if (input.title !== undefined) data.title = blankToNull(input.title);
		if (input.linkedinUrl !== undefined) {
			data.linkedinUrl = blankToNull(input.linkedinUrl);
		}
		if (input.twitterUrl !== undefined) {
			data.twitterUrl = blankToNull(input.twitterUrl);
		}
		if (input.githubUrl !== undefined) {
			data.githubUrl = blankToNull(input.githubUrl);
		}
		if (input.companyId !== undefined) data.companyId = input.companyId || null;
		if (input.ownerId !== undefined) data.ownerId = input.ownerId || null;

		try {
			return await this.db.transaction(async (tx) => {
				if (input.fields) {
					await this.fields.applyValues(tx, "CONTACT", id, input.fields);
				}

				const fields = {
					id: contact.id,
					firstName: contact.firstName,
					lastName: contact.lastName,
				};
				const [updated] = hasValues(data)
					? await tx
							.update(contact)
							.set(data)
							.where(eq(contact.id, id))
							.returning(fields)
					: await tx
							.select(fields)
							.from(contact)
							.where(eq(contact.id, id))
							.limit(1);
				if (!updated) throw new NotFoundException(`No contact with id ${id}.`);

				if (email !== null) {
					await this.allowAgain(tx, email);
				}

				return updated;
			});
		} catch (error) {
			throw this.translate(error, id);
		}
	}

	async bulkAssignOwner(input: ContactBulkOwnerInput): Promise<BulkResult> {
		const ownerId = input.ownerId || null;

		await requireOwner(this.db, ownerId);

		const ids = [...new Set(input.ids)];
		const count = (
			await this.db
				.update(contact)
				.set({ ownerId })
				.where(inArray(contact.id, ids))
				.returning({ id: contact.id })
		).length;

		this.logger.log({
			message: "Contacts reassigned",
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

	async bulkSetCompany(input: ContactBulkCompanyInput): Promise<BulkResult> {
		const companyId = input.companyId || null;

		if (companyId) {
			const [found] = await this.db
				.select({ id: company.id })
				.from(company)
				.where(eq(company.id, companyId))
				.limit(1);
			if (!found) {
				throw new NotFoundException(`No company with id ${companyId}.`);
			}
		}

		const ids = [...new Set(input.ids)];
		const count = (
			await this.db
				.update(contact)
				.set({ companyId })
				.where(inArray(contact.id, ids))
				.returning({ id: contact.id })
		).length;

		this.logger.log({
			message: "Contacts moved",
			count,
			companyId,
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

	private async allowAgain(tx: Executor, email: string | null): Promise<void> {
		if (!email) return;
		await tx
			.delete(suppressedContact)
			.where(equalsInsensitive(suppressedContact.email, email));
	}

	private async relationship(contactId: string, companyId: string | null) {
		const now = new Date();

		const involved = or(
			eq(calendarEvent.contactId, contactId),
			exists(
				this.db
					.select({ id: calendarAttendee.id })
					.from(calendarAttendee)
					.where(
						and(
							eq(calendarAttendee.eventId, calendarEvent.id),
							eq(calendarAttendee.contactId, contactId),
						),
					),
			),
		);

		const [[threads], [lastReply], meetings, [nextMeeting], colleagues] =
			await Promise.all([
				this.db
					.select({
						messages: sum(emailThread.messageCount).mapWith(Number),
						threads: count(),
					})
					.from(emailThread)
					.where(eq(emailThread.contactId, contactId)),
				this.db
					.select({ sentAt: emailMessage.sentAt })
					.from(emailMessage)
					.innerJoin(emailThread, eq(emailThread.id, emailMessage.threadId))
					.where(
						and(
							eq(emailThread.contactId, contactId),
							eq(emailMessage.direction, "INBOUND"),
						),
					)
					.orderBy(desc(emailMessage.sentAt))
					.limit(1),
				this.db.$count(calendarEvent, involved),
				this.db
					.select({
						title: calendarEvent.title,
						startsAt: calendarEvent.startsAt,
					})
					.from(calendarEvent)
					.where(and(gt(calendarEvent.startsAt, now), involved))
					.orderBy(asc(calendarEvent.startsAt))
					.limit(1),
				companyId
					? this.db
							.select({
								id: contact.id,
								firstName: contact.firstName,
								lastName: contact.lastName,
								title: contact.title,
							})
							.from(contact)
							.where(
								and(
									eq(contact.companyId, companyId),
									ne(contact.id, contactId),
								),
							)
							.orderBy(sql`${contact.lastActivityAt} desc nulls last`)
							.limit(4)
					: Promise.resolve([]),
			]);

		return {
			emails: threads?.messages ?? 0,
			threads: threads?.threads ?? 0,
			lastReplyAt: lastReply?.sentAt.toISOString() ?? null,
			meetings,
			nextMeeting: nextMeeting
				? {
						title: nextMeeting.title,
						startsAt: nextMeeting.startsAt.toISOString(),
					}
				: null,
			colleagues: colleagues.map((colleague) => ({
				id: colleague.id,
				name: [colleague.firstName, colleague.lastName]
					.filter(Boolean)
					.join(" "),
				title: colleague.title,
			})),
		};
	}

	async enrich(id: string): Promise<{ id: string; queued: boolean }> {
		const [record] = await this.db
			.select({
				id: contact.id,
				imageUrl: contact.imageUrl,
				linkedinUrl: contact.linkedinUrl,
				updatedAt: contact.updatedAt,
			})
			.from(contact)
			.where(eq(contact.id, id))
			.limit(1);

		if (!record) {
			throw new NotFoundException(`No contact with id ${id}.`);
		}

		const queued = await this.agent.contactCreated(
			id,
			record.linkedinUrl && !record.imageUrl
				? "A rep asked for a fresh look — they have a LinkedIn profile on file but no picture"
				: "A rep asked for a fresh look",
			true,
		);

		if (queued) {
			await this.db
				.update(contact)
				.set({ enrichmentStatus: "PENDING", enrichmentError: null })
				.where(
					and(eq(contact.id, id), eq(contact.updatedAt, record.updatedAt)),
				);
		}

		return { id, queued };
	}

	async decideFact(
		input: FactDecisionInput,
		userId: string,
	): Promise<{ contactId: string; field: string; applied: boolean }> {
		const [fact] = await this.db
			.select({
				id: contactFact.id,
				contactId: contactFact.contactId,
				field: contactFact.field,
				value: contactFact.value,
				status: contactFact.status,
			})
			.from(contactFact)
			.where(eq(contactFact.id, input.factId))
			.limit(1);

		if (!fact) {
			throw new NotFoundException(`No fact with id ${input.factId}.`);
		}

		if (fact.status !== FactStatus.PROPOSED) {
			throw new ConflictException("That suggestion has already been settled.");
		}

		const accepted = input.decision === "accept";
		const column = FACT_COLUMNS[fact.field];

		await this.db.transaction(async (tx) => {
			if (accepted) {
				await tx
					.update(contactFact)
					.set({ status: FactStatus.SUPERSEDED, supersededAt: new Date() })
					.where(
						and(
							eq(contactFact.contactId, fact.contactId),
							eq(contactFact.field, fact.field),
							ne(contactFact.id, fact.id),
							inArray(contactFact.status, [
								FactStatus.APPLIED,
								FactStatus.PROPOSED,
							]),
						),
					);
			}

			await tx
				.update(contactFact)
				.set({
					status: accepted ? FactStatus.APPLIED : FactStatus.DISMISSED,
					decidedById: userId,
					decidedAt: new Date(),
				})
				.where(eq(contactFact.id, fact.id));

			if (accepted && column) {
				await this.updateContactOrThrow(tx, fact.contactId, {
					[column]: fact.value,
				});
			}

			if (accepted && fact.field === "name") {
				const [firstName, ...rest] = fact.value.trim().split(/\s+/);
				if (firstName) {
					await this.updateContactOrThrow(tx, fact.contactId, {
						firstName,
						lastName: rest.length > 0 ? rest.join(" ") : null,
					});
				}
			}
		});

		this.logger.log({
			message: "Fact decided",
			factId: fact.id,
			contactId: fact.contactId,
			field: fact.field,
			decision: input.decision,
		});

		return { contactId: fact.contactId, field: fact.field, applied: accepted };
	}

	private searchFilter(q: string): SQL | undefined {
		const term = q.trim();
		if (!term) return undefined;

		return or(
			contains(contact.firstName, term, { insensitive: true }),
			contains(contact.lastName, term, { insensitive: true }),
			contains(contact.email, term, { insensitive: true }),
			inArray(
				contact.companyId,
				this.db
					.select({ id: company.id })
					.from(company)
					.where(contains(company.name, term, { insensitive: true })),
			),
		);
	}

	private companyFilter(values: string[]): SQL | undefined {
		if (values.length === 0) return undefined;

		const { ids, includesSentinel } = splitSentinel(values, NO_COMPANY);
		if (includesSentinel && ids.length === 0) return isNull(contact.companyId);
		if (!includesSentinel) return inArray(contact.companyId, ids);
		return or(inArray(contact.companyId, ids), isNull(contact.companyId));
	}

	private buildWhere(
		input: ContactListInput,
		filterableFields: FieldDefinitionWithOptions[],
	): SQL | undefined {
		const conditions: (SQL | undefined)[] = [
			this.searchFilter(input.q),
			archivedFilter(contact.archivedAt, input.archived),
			...this.fields.fieldFilters("CONTACT", filterableFields, input.fields),
			ownerFilter(contact.ownerId, input.owner),
			this.companyFilter(input.company),
		];

		if (input.source.length > 0) {
			conditions.push(inArray(contact.source, input.source as RecordSource[]));
		}
		if (input.title.length > 0)
			conditions.push(inArray(contact.title, input.title));
		if (input.seniority.length > 0) {
			conditions.push(inArray(contact.seniority, input.seniority));
		}
		if (input.persona.length > 0)
			conditions.push(inArray(contact.function, input.persona));

		conditions.push(activityFilter(contact.lastActivityAt, input.activity));

		return and(...conditions);
	}

	private async facetCounts(
		input: ContactListInput,
		filterableFields: FieldDefinitionWithOptions[],
	) {
		const where = and(
			this.searchFilter(input.q),
			archivedFilter(contact.archivedAt, input.archived),
		);

		const [
			owners,
			companies,
			sources,
			titles,
			seniorities,
			personas,
			activity,
			fieldFacets,
		] = await Promise.all([
			groupCounts(this.db, contact, contact.ownerId, where),
			groupCounts(this.db, contact, contact.companyId, where),
			groupCounts(this.db, contact, contact.source, where),
			groupCounts(this.db, contact, contact.title, where),
			groupCounts(this.db, contact, contact.seniority, where),
			groupCounts(this.db, contact, contact.function, where),
			activityFacetCounts(contact.lastActivityAt, (activityWhere) =>
				this.db.$count(contact, and(where, activityWhere)),
			),
			this.fields.filterFacetCounts("CONTACT", where, filterableFields),
		]);

		return {
			owner: countsByKey(owners, "value", FACET_UNASSIGNED),
			company: countsByKey(companies, "value", NO_COMPANY),
			source: countsByKey(sources, "value"),
			title: countsByKey(titles, "value"),
			seniority: countsByKey(seniorities, "value"),
			persona: countsByKey(personas, "value"),
			activity,
			...Object.fromEntries(
				Object.entries(fieldFacets).map(([key, counts]) => [
					`field:${key}`,
					counts,
				]),
			),
		};
	}

	private async updateContactOrThrow(
		tx: Executor,
		id: string,
		data: Partial<NewContact>,
	): Promise<void> {
		const [updated] = hasValues(data)
			? await tx
					.update(contact)
					.set(data)
					.where(eq(contact.id, id))
					.returning({ id: contact.id })
			: await tx
					.select({ id: contact.id })
					.from(contact)
					.where(eq(contact.id, id))
					.limit(1);
		if (!updated) throw new NotFoundException(`No contact with id ${id}.`);
	}

	private translate(cause: unknown, _id: string): never {
		if (isUniqueViolation(cause)) {
			throw new ConflictException(
				"Another contact already uses that email address.",
			);
		}
		throw cause;
	}
}

function nameOf(contact: {
	firstName: string;
	lastName: string | null;
}): string {
	return [contact.firstName, contact.lastName].filter(Boolean).join(" ");
}
