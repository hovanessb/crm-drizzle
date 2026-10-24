import { and, eq, gt, isNull, or } from "drizzle-orm";
import { PRIORITY } from "./agent-tasks";
import { db } from "./client";
import { lockIdempotencyKey } from "./idempotency";
import { agentTask } from "./schema/schema";

const MINUTE_MS = 60_000;

export const SLACK_INVENTORY = {
	kind: "slack-people-match",
	lock: "slack-inventory",
	priority: PRIORITY.slackPeople,
	budget: 1,
	throttleMs: 15 * MINUTE_MS,
} as const;

export async function queueSlackInventorySync(reason: string): Promise<void> {
	const since = new Date(Date.now() - SLACK_INVENTORY.throttleMs);

	try {
		await db.transaction(async (tx) => {
			await lockIdempotencyKey(tx, SLACK_INVENTORY.lock);

			const [recent] = await tx
				.select({ id: agentTask.id })
				.from(agentTask)
				.where(
					and(
						eq(agentTask.kind, SLACK_INVENTORY.kind),
						or(isNull(agentTask.finishedAt), gt(agentTask.createdAt, since)),
					),
				)
				.limit(1);
			if (recent) return;

			await tx.insert(agentTask).values({
				kind: SLACK_INVENTORY.kind,
				reason,
				priority: SLACK_INVENTORY.priority,
				budget: SLACK_INVENTORY.budget,
				dueAt: new Date(),
			});
		});
	} catch {
		return;
	}
}
