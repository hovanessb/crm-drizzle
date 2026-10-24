import {
	agentTask,
	and,
	company,
	contact,
	db,
	EnrichmentStatus,
	eq,
	firstRow,
	inArray,
	isNull,
	lt,
	ne,
	or,
	type PgColumn,
	type SQL,
	whereEq,
} from "@crm/db";
import { ownsCompanyStatus, ownsContactStatus } from "@crm/db/agent-tasks";
import type { TaskSubject } from "./tasks";

type StatusGuard =
	| EnrichmentStatus
	| { not: EnrichmentStatus }
	| { in: EnrichmentStatus[] };

export type SettleGuard = {
	enrichmentStatus?: StatusGuard;
	OR?: Array<{
		enrichmentStatus: EnrichmentStatus;
		updatedAt?: { lt: Date };
	}>;
};

type OwnedColumns = {
	contactId: string | null;
	companyId: string | null;
};

export const UNLESS_COMPLETE = {
	enrichmentStatus: { not: EnrichmentStatus.COMPLETE },
} as const;

type GuardColumns = { enrichmentStatus: PgColumn; updatedAt: PgColumn };

const STATUSES = new Set<StatusGuard>(Object.values(EnrichmentStatus));

function isStatus(guard: StatusGuard): guard is EnrichmentStatus {
	return STATUSES.has(guard);
}

function statusSql(column: PgColumn, guard: StatusGuard): SQL {
	if (isStatus(guard)) return eq(column, guard);
	if ("not" in guard) return ne(column, guard.not);
	return inArray(column, guard.in);
}

export function guardSql(
	columns: GuardColumns,
	guard: SettleGuard,
): SQL | undefined {
	return and(
		guard.enrichmentStatus === undefined
			? undefined
			: statusSql(columns.enrichmentStatus, guard.enrichmentStatus),
		guard.OR === undefined
			? undefined
			: or(
					...guard.OR.map((branch) =>
						and(
							eq(columns.enrichmentStatus, branch.enrichmentStatus),
							branch.updatedAt === undefined
								? undefined
								: lt(columns.updatedAt, branch.updatedAt.lt),
						),
					),
				),
	);
}

function ownedColumns(subject: TaskSubject): OwnedColumns {
	return {
		contactId:
			subject.contactId && ownsContactStatus(subject.kind)
				? subject.contactId
				: null,
		companyId:
			subject.companyId && ownsCompanyStatus(subject.kind)
				? subject.companyId
				: null,
	};
}

export async function markRunning(subject: TaskSubject): Promise<void> {
	await write(ownedColumns(subject), EnrichmentStatus.RUNNING, null, {
		...UNLESS_COMPLETE,
	});
}

export async function settle(
	subject: TaskSubject,
	status: EnrichmentStatus,
	error?: string,
): Promise<void> {
	const owned = ownedColumns(subject);
	if (!owned.contactId && !owned.companyId) return;

	await write(owned, status, error ?? null, await settleable(subject, status));
}

async function write(
	owned: OwnedColumns,
	status: EnrichmentStatus,
	error: string | null,
	guard: SettleGuard,
): Promise<void> {
	if (!owned.contactId && !owned.companyId) return;

	const data = {
		enrichmentStatus: status,
		enrichmentError: error,
		enrichedAt: status === EnrichmentStatus.COMPLETE ? new Date() : undefined,
	};

	if (owned.contactId) {
		await db
			.update(contact)
			.set(data)
			.where(and(eq(contact.id, owned.contactId), guardSql(contact, guard)));
	}

	if (owned.companyId) {
		await db
			.update(company)
			.set(data)
			.where(and(eq(company.id, owned.companyId), guardSql(company, guard)));
	}
}

async function settleable(
	subject: TaskSubject,
	status: EnrichmentStatus,
): Promise<SettleGuard> {
	const running = { enrichmentStatus: EnrichmentStatus.RUNNING };

	if (status === EnrichmentStatus.COMPLETE) {
		const done = {
			enrichmentStatus: {
				in: [EnrichmentStatus.RUNNING, EnrichmentStatus.COMPLETE],
			},
		};

		const endedAt = await taskEndedAt(subject.id);
		if (!endedAt) return done;
		if (await hasOpenRequest(subject)) return done;

		return {
			OR: [
				running,
				{ enrichmentStatus: EnrichmentStatus.COMPLETE },
				{
					enrichmentStatus: EnrichmentStatus.PENDING,
					updatedAt: { lt: endedAt },
				},
			],
		};
	}

	if (status !== EnrichmentStatus.FAILED) return running;

	const endedAt = await taskEndedAt(subject.id);
	if (!endedAt) return running;
	if (await hasOpenRequest(subject)) return running;

	return {
		OR: [
			running,
			{
				enrichmentStatus: EnrichmentStatus.PENDING,
				updatedAt: { lt: endedAt },
			},
		],
	};
}

async function taskEndedAt(taskId: string): Promise<Date | null> {
	const task = await firstRow(
		db
			.select({ finishedAt: agentTask.finishedAt })
			.from(agentTask)
			.where(whereEq(agentTask.id, taskId))
			.limit(1),
	);

	return task?.finishedAt ?? null;
}

async function hasOpenRequest(subject: TaskSubject): Promise<boolean> {
	const owners: SQL[] = [];
	if (subject.contactId)
		owners.push(eq(agentTask.contactId, subject.contactId));
	if (subject.companyId)
		owners.push(eq(agentTask.companyId, subject.companyId));
	if (owners.length === 0) return false;

	const open = await firstRow(
		db
			.select({ id: agentTask.id })
			.from(agentTask)
			.where(
				and(
					ne(agentTask.id, subject.id),
					isNull(agentTask.finishedAt),
					or(...owners),
				),
			)
			.limit(1),
	);

	return open !== null;
}
