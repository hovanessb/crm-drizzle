import {
	agentAction,
	agentAuditEvent,
	agentDefinition,
	agentRun,
	agentRunEvent,
	agentTrigger,
	agentVersion,
	db,
	inArray,
	or,
	requireRow,
	startsWith,
	whereEq,
} from "@crm/db";

export async function removeAgent(agentId: string): Promise<void> {
	await db
		.delete(agentRunEvent)
		.where(
			inArray(
				agentRunEvent.runId,
				db
					.select({ id: agentRun.id })
					.from(agentRun)
					.where(whereEq(agentRun.agentId, agentId)),
			),
		);
	await db.delete(agentAction).where(whereEq(agentAction.agentId, agentId));
	await db
		.delete(agentAuditEvent)
		.where(whereEq(agentAuditEvent.agentId, agentId));
	await db.delete(agentRun).where(whereEq(agentRun.agentId, agentId));
	await db.delete(agentTrigger).where(whereEq(agentTrigger.agentId, agentId));
	await requireRow(
		db
			.update(agentDefinition)
			.set({ currentVersionId: null })
			.where(whereEq(agentDefinition.id, agentId))
			.returning(),
	);
	await db.delete(agentVersion).where(whereEq(agentVersion.agentId, agentId));
	await requireRow(
		db
			.delete(agentDefinition)
			.where(whereEq(agentDefinition.id, agentId))
			.returning(),
	);
}

export async function removeAgentsNamed(prefix: string): Promise<string[]> {
	const stale = await db
		.select({ id: agentDefinition.id, name: agentDefinition.name })
		.from(agentDefinition)
		.where(startsWith(agentDefinition.name, prefix));

	for (const agent of stale) await removeAgent(agent.id);

	return stale.map((agent) => agent.name);
}

export async function removeEventRuns(
	taskIds: readonly string[],
): Promise<number> {
	if (taskIds.length === 0) return 0;

	const runs = await db
		.select({ id: agentRun.id })
		.from(agentRun)
		.where(
			or(
				...taskIds.map((taskId) =>
					startsWith(agentRun.idempotencyKey, `event:${taskId}:`),
				),
			),
		);
	const runIds = runs.map((run) => run.id);
	if (runIds.length === 0) return 0;

	await db.delete(agentRunEvent).where(inArray(agentRunEvent.runId, runIds));
	await db.delete(agentAction).where(inArray(agentAction.runId, runIds));
	await db
		.delete(agentAuditEvent)
		.where(inArray(agentAuditEvent.requestId, runIds));
	await db.delete(agentRun).where(inArray(agentRun.id, runIds));

	return runIds.length;
}

export function reasonOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
