import {
	agentTask,
	and,
	asc,
	company,
	contact,
	type Db,
	desc,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
} from "@crm/db";
import { ENRICHMENT_PAGE, pageSize } from "@crm/validation/enrichment-queue";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import {
	type EnrichmentQueueState,
	enrichmentDueLabel,
	enrichmentQueueLine,
	enrichmentQueueState,
} from "./enrichment-copy";

type EnrichmentQueueSubject =
	| {
			kind: "contact";
			id: string;
			name: string;
			email: string | null;
			imageUrl: string | null;
	  }
	| {
			kind: "company";
			id: string;
			name: string;
			logoUrl: string | null;
			logoDarkUrl: string | null;
			logoTone: string | null;
	  };

type EnrichmentQueueRow = {
	id: string;
	state: EnrichmentQueueState;
	line: string;
	startedAt: string | null;
	subject: EnrichmentQueueSubject;
};

type EnrichmentScheduledRow = {
	id: string;
	due: string;
	subject: EnrichmentQueueSubject;
};

export type EnrichmentQueue = {
	rows: EnrichmentQueueRow[];
	total: number;
	scheduled: EnrichmentScheduledRow[];
	scheduledTotal: number;
};

const TASK_FIELDS = {
	id: agentTask.id,
	contactId: agentTask.contactId,
	companyId: agentTask.companyId,
	kind: agentTask.kind,
	attempts: agentTask.attempts,
	leasedUntil: agentTask.leasedUntil,
	startedAt: agentTask.startedAt,
	dueAt: agentTask.dueAt,
};

type QueuedTask = {
	id: string;
	contactId: string | null;
	companyId: string | null;
	kind: string;
	attempts: number;
	leasedUntil: Date | null;
	startedAt: Date | null;
	dueAt: Date;
};

@Injectable()
export class EnrichmentService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async queue(limit: number = ENRICHMENT_PAGE): Promise<EnrichmentQueue> {
		const take = pageSize(limit);
		const now = new Date();

		const named = and(
			isNull(agentTask.finishedAt),
			or(isNotNull(agentTask.contactId), isNotNull(agentTask.companyId)),
		);

		const dueWhere = and(named, lte(agentTask.dueAt, now));

		const scheduledWhere = and(named, gt(agentTask.dueAt, now));

		const [tasks, total, booked, scheduledTotal] = await Promise.all([
			this.db
				.select(TASK_FIELDS)
				.from(agentTask)
				.where(dueWhere)
				.orderBy(desc(agentTask.priority), asc(agentTask.dueAt))
				.limit(take),
			this.db.$count(agentTask, dueWhere),
			this.db
				.select(TASK_FIELDS)
				.from(agentTask)
				.where(scheduledWhere)
				.orderBy(asc(agentTask.dueAt))
				.limit(take),
			this.db.$count(agentTask, scheduledWhere),
		]);

		const everyTask: QueuedTask[] = [...tasks, ...booked];
		const contactIds = unique(everyTask.map((task) => task.contactId));
		const companyIds = unique(everyTask.map((task) => task.companyId));

		const [contacts, companies] = await Promise.all([
			contactIds.length === 0
				? []
				: this.db
						.select({
							id: contact.id,
							firstName: contact.firstName,
							lastName: contact.lastName,
							email: contact.email,
							imageUrl: contact.imageUrl,
						})
						.from(contact)
						.where(inArray(contact.id, contactIds)),
			companyIds.length === 0
				? []
				: this.db
						.select({
							id: company.id,
							name: company.name,
							iconUrl: company.iconUrl,
							logoUrl: company.logoUrl,
							iconDarkUrl: company.iconDarkUrl,
							logoDarkUrl: company.logoDarkUrl,
							iconTone: company.iconTone,
						})
						.from(company)
						.where(inArray(company.id, companyIds)),
		]);

		const contactById = new Map(
			contacts.map((contact) => [
				contact.id,
				{
					kind: "contact" as const,
					id: contact.id,
					name:
						[contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
						contact.email ||
						"Unnamed contact",
					email: contact.email,
					imageUrl: contact.imageUrl,
				},
			]),
		);

		const companyById = new Map(
			companies.map((company) => [
				company.id,
				{
					kind: "company" as const,
					id: company.id,
					name: company.name,
					logoUrl: company.iconUrl ?? company.logoUrl,
					logoDarkUrl: company.iconDarkUrl ?? company.logoDarkUrl,
					logoTone: company.iconTone,
				},
			]),
		);

		const subjectOf = (task: QueuedTask): EnrichmentQueueSubject | undefined =>
			task.contactId
				? contactById.get(task.contactId)
				: task.companyId
					? companyById.get(task.companyId)
					: undefined;

		const rows: EnrichmentQueueRow[] = [];

		for (const task of tasks) {
			const subject = subjectOf(task);
			if (!subject) continue;

			const state = enrichmentQueueState(task.attempts, task.leasedUntil, now);

			rows.push({
				id: task.id,
				state,
				line: enrichmentQueueLine(state, task.kind),
				startedAt: task.startedAt?.toISOString() ?? null,
				subject,
			});
		}

		const scheduled: EnrichmentScheduledRow[] = [];

		for (const task of booked) {
			const subject = subjectOf(task);
			if (!subject) continue;

			scheduled.push({
				id: task.id,
				due: enrichmentDueLabel(task.dueAt, now),
				subject,
			});
		}

		return { rows, total, scheduled, scheduledTotal };
	}
}

function unique(ids: readonly (string | null)[]): string[] {
	return [...new Set(ids.filter((id): id is string => id !== null))];
}
