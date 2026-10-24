import {
	agentTask,
	and,
	db,
	desc,
	firstRow,
	isNull,
	type JsonValue,
	queryRows,
	requireRow,
	sql,
	whereEq,
} from "@crm/db";
import { MAX_ATTEMPTS, RETIRED_OUTCOME } from "@crm/db/agent-tasks";
import { DISPATCH } from "./dispatch-config";

export type LeasedTask = {
	id: string;
	contactId: string | null;
	companyId: string | null;
	dealId: string | null;
	kind: string;
	reason: string;
	payload: JsonValue | null;
	budget: number;
	attempts: number;
	priority: number;
	dueAt: Date;
};

export type TaskSubject = {
	id: string;
	contactId: string | null;
	companyId: string | null;
	dealId: string | null;
	kind: string;
};

const LEASE_MS = DISPATCH.task.leaseMs;

export async function claimDue(
	limit: number,
	kinds: { only: readonly string[] } | { except: readonly string[] },
	leaseMs = LEASE_MS,
): Promise<LeasedTask[]> {
	const now = new Date();
	const until = new Date(now.getTime() + leaseMs);

	const list = "only" in kinds ? [...kinds.only] : [...kinds.except];
	if ("only" in kinds && list.length === 0) return [];

	const onlyMode = "only" in kinds;

	const claimed = await queryRows<LeasedTask>(
		db,
		sql`
		UPDATE "agentTask" AS t
		SET "leasedUntil" = ${until},
			"startedAt" = COALESCE(t."startedAt", ${now}),
			"attempts" = t."attempts" + 1
		FROM (
			SELECT t2.id FROM "agentTask" AS t2
			WHERE t2."finishedAt" IS NULL
				AND t2."dueAt" <= ${now}
				AND (t2."leasedUntil" IS NULL OR t2."leasedUntil" < ${now})
				AND t2."attempts" < ${MAX_ATTEMPTS}
				AND CASE
					WHEN ${onlyMode}::boolean THEN t2.kind = ANY(${sql.param(list)}::text[])
					ELSE t2.kind <> ALL(${sql.param(list)}::text[])
				END
			ORDER BY t2."priority" DESC, t2."dueAt" ASC
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		) AS due
		WHERE t.id = due.id
		RETURNING t.id, t."contactId", t."companyId", t."dealId", t.kind, t.reason, t.payload,
			t.budget, t.attempts, t.priority, t."dueAt";
	`,
	);

	return claimed.sort(
		(a, b) => b.priority - a.priority || a.dueAt.getTime() - b.dueAt.getTime(),
	);
}

export async function retireExhausted(
	limit: number = DISPATCH.reconcile.retire,
): Promise<TaskSubject[]> {
	const now = new Date();

	return queryRows<TaskSubject>(
		db,
		sql`
		UPDATE "agentTask" AS t
		SET "finishedAt" = ${now},
			"outcome" = ${RETIRED_OUTCOME}
		WHERE t.id IN (
			SELECT c.id
			FROM "agentTask" AS c
			WHERE c."finishedAt" IS NULL
				AND c."attempts" >= ${MAX_ATTEMPTS}
				AND (c."leasedUntil" IS NULL OR c."leasedUntil" < ${now})
			ORDER BY c."dueAt" ASC
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		)
		RETURNING t.id, t."contactId", t."companyId", t."dealId", t.kind;
	`,
	);
}

export async function completeTask(
	taskId: string,
	outcome: string,
	sessionId?: string,
): Promise<TaskSubject | null> {
	const { rowCount: count } = await db
		.update(agentTask)
		.set({
			finishedAt: new Date(),
			outcome: outcome.slice(0, 500),
			sessionId: sessionId || undefined,
		})
		.where(and(whereEq(agentTask.id, taskId), isNull(agentTask.finishedAt)));

	if (count === 0) return null;

	return firstRow(
		db
			.select({
				id: agentTask.id,
				contactId: agentTask.contactId,
				companyId: agentTask.companyId,
				dealId: agentTask.dealId,
				kind: agentTask.kind,
			})
			.from(agentTask)
			.where(whereEq(agentTask.id, taskId))
			.limit(1),
	);
}

export async function taskSubject(taskId: string): Promise<TaskSubject | null> {
	return firstRow(
		db
			.select({
				id: agentTask.id,
				contactId: agentTask.contactId,
				companyId: agentTask.companyId,
				dealId: agentTask.dealId,
				kind: agentTask.kind,
			})
			.from(agentTask)
			.where(whereEq(agentTask.id, taskId))
			.limit(1),
	);
}

export async function noteSession(
	taskId: string,
	sessionId: string,
): Promise<void> {
	await db
		.update(agentTask)
		.set({ sessionId })
		.where(and(whereEq(agentTask.id, taskId), isNull(agentTask.finishedAt)));
}

export async function scheduleTask(input: {
	contactId?: string | null;
	companyId?: string | null;
	dealId?: string | null;
	kind: string;
	reason: string;
	payload?: JsonValue | null;
	dueAt: Date;
	priority?: number;
	budget?: number;
}): Promise<{ id: string }> {
	const existing = await firstRow(
		db
			.select({ id: agentTask.id })
			.from(agentTask)
			.where(
				and(
					whereEq(agentTask.kind, input.kind),
					isNull(agentTask.finishedAt),
					whereEq(agentTask.contactId, input.contactId ?? undefined),
					whereEq(agentTask.companyId, input.companyId ?? undefined),
					whereEq(agentTask.dealId, input.dealId ?? undefined),
				),
			)
			.limit(1),
	);

	if (existing) {
		await requireRow(
			db
				.update(agentTask)
				.set({ dueAt: input.dueAt, reason: input.reason })
				.where(whereEq(agentTask.id, existing.id))
				.returning(),
		);
		return existing;
	}

	return requireRow(
		db
			.insert(agentTask)
			.values({
				contactId: input.contactId ?? null,
				companyId: input.companyId ?? null,
				dealId: input.dealId ?? null,
				kind: input.kind,
				reason: input.reason,
				payload: input.payload ?? undefined,
				dueAt: input.dueAt,
				priority: input.priority ?? 0,
				budget: input.budget ?? 4,
			})
			.returning({ id: agentTask.id }),
	);
}

export async function lastDecision(contactId: string) {
	return firstRow(
		db
			.select({
				kind: agentTask.kind,
				reason: agentTask.reason,
				dueAt: agentTask.dueAt,
				finishedAt: agentTask.finishedAt,
				outcome: agentTask.outcome,
			})
			.from(agentTask)
			.where(whereEq(agentTask.contactId, contactId))
			.orderBy(desc(agentTask.createdAt))
			.limit(1),
	);
}
