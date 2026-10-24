import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_WORKSPACE_NAME, WORKSPACE_ID } from "@crm/auth/organization";
import {
	agentAction,
	agentAuditEvent,
	agentDefinition,
	agentRun,
	agentRunEvent,
	agentTrigger,
	agentVersion,
	and,
	db,
	eq,
	inArray,
	member,
	organization,
	user,
} from "@crm/db";
import { workspaceSlug } from "@crm/db/workspace";
import { AgentAccessService } from "../src/agent/agent-access.service";
import { AgentDefinitionsService } from "../src/agent/agent-definitions.service";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { first, one } from "./rows";

const suffix = crypto.randomUUID();
const userId = `agent-delete-user-${suffix}`;
const memberId = `agent-delete-member-${suffix}`;
const idempotencyPrefix = `agent-delete-${suffix}`;

const access = new AgentAccessService(db);
const agents = new AgentDefinitionsService(
	db,
	access,
	new AgentTriggerService(db),
);

let agentId: string;
let versionId: string;
let triggerId: string;
let queuedRunId: string;
let waitingRunId: string;
let runningRunId: string;
let deliveryRunId: string;

async function clean() {
	if (agentId) {
		await db
			.delete(agentRunEvent)
			.where(
				inArray(
					agentRunEvent.runId,
					db
						.select({ id: agentRun.id })
						.from(agentRun)
						.where(eq(agentRun.agentId, agentId)),
				),
			);
		await db.delete(agentAction).where(eq(agentAction.agentId, agentId));
		await db
			.delete(agentAuditEvent)
			.where(eq(agentAuditEvent.agentId, agentId));
		await db.delete(agentRun).where(eq(agentRun.agentId, agentId));
		await db.delete(agentTrigger).where(eq(agentTrigger.agentId, agentId));
		await db
			.update(agentDefinition)
			.set({ currentVersionId: null })
			.where(eq(agentDefinition.id, agentId));
		await db.delete(agentVersion).where(eq(agentVersion.agentId, agentId));
		await db.delete(agentDefinition).where(eq(agentDefinition.id, agentId));
	}

	await db.delete(member).where(eq(member.id, memberId));
	await db.delete(user).where(eq(user.id, userId));
}

beforeAll(async () => {
	await db
		.insert(organization)
		.values({
			id: WORKSPACE_ID,
			name: DEFAULT_WORKSPACE_NAME,
			slug: workspaceSlug(DEFAULT_WORKSPACE_NAME),
			createdAt: new Date(),
		})
		.onConflictDoNothing();
	await one(
		db
			.insert(user)
			.values({
				id: userId,
				name: "Agent Delete Test",
				email: `${userId}@example.test`,
			})
			.returning(),
	);
	await one(
		db
			.insert(member)
			.values({
				id: memberId,
				organizationId: WORKSPACE_ID,
				userId,
				role: "member",
				createdAt: new Date(),
			})
			.returning(),
	);

	const agent = await one(
		db
			.insert(agentDefinition)
			.values({
				name: "Delete me",
				status: "PAUSED",
				createdById: userId,
			})
			.returning({ id: agentDefinition.id }),
	);
	agentId = agent.id;

	const version = await one(
		db
			.insert(agentVersion)
			.values({
				agentId,
				number: 1,
				status: "DEPLOYED",
				instructions: "Test deletion behavior.",
				manifest: {},
				modelId: "test/model",
				sandboxPolicy: {},
				createdById: userId,
				approvedAt: new Date(),
				deployedAt: new Date(),
			})
			.returning({ id: agentVersion.id }),
	);
	versionId = version.id;
	await one(
		db
			.update(agentDefinition)
			.set({ currentVersionId: versionId })
			.where(eq(agentDefinition.id, agentId))
			.returning(),
	);

	const trigger = await one(
		db
			.insert(agentTrigger)
			.values({
				agentId,
				versionId,
				type: "SCHEDULE",
				name: "Every hour",
				config: { intervalMinutes: 60 },
				createdById: userId,
				enabled: true,
				nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
			})
			.returning({ id: agentTrigger.id }),
	);
	triggerId = trigger.id;

	const [queued, waiting, running, delivery] = await Promise.all([
		one(
			db
				.insert(agentRun)
				.values({
					agentId,
					versionId,
					triggerId,
					triggerType: "SCHEDULE",
					status: "QUEUED",
					idempotencyKey: `${idempotencyPrefix}-queued`,
					correlationId: `${idempotencyPrefix}-queued`,
				})
				.returning({ id: agentRun.id }),
		),
		one(
			db
				.insert(agentRun)
				.values({
					agentId,
					versionId,
					triggerType: "MANUAL",
					status: "WAITING_FOR_APPROVAL",
					idempotencyKey: `${idempotencyPrefix}-waiting`,
					correlationId: `${idempotencyPrefix}-waiting`,
				})
				.returning({ id: agentRun.id }),
		),
		one(
			db
				.insert(agentRun)
				.values({
					agentId,
					versionId,
					triggerType: "MANUAL",
					status: "RUNNING",
					idempotencyKey: `${idempotencyPrefix}-running`,
					correlationId: `${idempotencyPrefix}-running`,
					startedAt: new Date(),
					sessionId: `${idempotencyPrefix}-active-session`,
				})
				.returning({ id: agentRun.id }),
		),
		one(
			db
				.insert(agentRun)
				.values({
					agentId,
					versionId,
					triggerType: "MANUAL",
					status: "RUNNING",
					idempotencyKey: `${idempotencyPrefix}-delivery`,
					correlationId: `${idempotencyPrefix}-delivery`,
					startedAt: new Date(),
				})
				.returning({ id: agentRun.id }),
		),
	]);
	queuedRunId = queued.id;
	waitingRunId = waiting.id;
	runningRunId = running.id;
	deliveryRunId = delivery.id;
});

afterAll(async () => {
	await clean();
});

describe("deleting an agent", () => {
	it("stops future work while preserving its audit history", async () => {
		const removed = await agents.remove(agentId, userId);

		expect(removed.status).toBe("DELETED");
		expect(removed.disabledTriggers).toBe(1);
		expect(removed.cancelledRuns).toBe(3);

		const [definition, trigger, runs, runEvents, auditEvent, listed] =
			await Promise.all([
				first(
					db
						.select()
						.from(agentDefinition)
						.where(eq(agentDefinition.id, agentId))
						.limit(1),
				),
				first(
					db
						.select()
						.from(agentTrigger)
						.where(eq(agentTrigger.id, triggerId))
						.limit(1),
				),
				db
					.select({
						id: agentRun.id,
						status: agentRun.status,
						errorCode: agentRun.errorCode,
						finishedAt: agentRun.finishedAt,
					})
					.from(agentRun)
					.where(
						inArray(agentRun.id, [
							queuedRunId,
							waitingRunId,
							runningRunId,
							deliveryRunId,
						]),
					),
				db
					.select({
						runId: agentRunEvent.runId,
						type: agentRunEvent.type,
						data: agentRunEvent.data,
					})
					.from(agentRunEvent)
					.where(
						inArray(agentRunEvent.runId, [
							queuedRunId,
							waitingRunId,
							deliveryRunId,
						]),
					),
				first(
					db
						.select()
						.from(agentAuditEvent)
						.where(
							and(
								eq(agentAuditEvent.agentId, agentId),
								eq(agentAuditEvent.type, "agent.deleted"),
							),
						)
						.limit(1),
				),
				agents.list(userId),
			]);

		expect(definition?.deletedAt).not.toBeNull();
		expect(trigger).toMatchObject({ enabled: false, nextRunAt: null });
		expect(
			runs.filter((run) =>
				[queuedRunId, waitingRunId, deliveryRunId].includes(run.id),
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: "CANCELLED",
					errorCode: "AGENT_DELETED",
					finishedAt: expect.any(Date),
				}),
				expect.objectContaining({
					status: "CANCELLED",
					errorCode: "AGENT_DELETED",
					finishedAt: expect.any(Date),
				}),
				expect.objectContaining({
					status: "CANCELLED",
					errorCode: "AGENT_DELETED",
					finishedAt: expect.any(Date),
				}),
			]),
		);
		expect(runs.find((run) => run.id === runningRunId)?.status).toBe("RUNNING");
		expect(runEvents).toHaveLength(3);
		expect(runEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "run.cancelled",
					data: { reason: "agent.deleted" },
				}),
			]),
		);
		expect(auditEvent?.after).toEqual({
			status: "DELETED",
			disabledTriggers: 1,
			cancelledRuns: 3,
		});
		expect(listed.some((agent) => agent.id === agentId)).toBe(false);

		let lookupError: unknown;
		try {
			await agents.byId(agentId, userId);
		} catch (error) {
			lookupError = error;
		}
		expect((lookupError as Error).message).toBe(`No agent with id ${agentId}.`);
	});
});
