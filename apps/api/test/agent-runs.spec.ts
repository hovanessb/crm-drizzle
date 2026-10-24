import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_WORKSPACE_NAME, WORKSPACE_ID } from "@crm/auth/organization";
import {
	agentAction,
	agentAuditEvent,
	agentDefinition,
	agentRun,
	agentRunEvent,
	agentVersion,
	and,
	asc,
	Decimal,
	db,
	eq,
	inArray,
	member,
	organization,
	user,
} from "@crm/db";
import { workspaceSlug } from "@crm/db/workspace";
import { AgentAccessService } from "../src/agent/agent-access.service";
import { AgentRunsService } from "../src/agent/agent-runs.service";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { one } from "./rows";

const suffix = crypto.randomUUID();
const userId = `agent-run-user-${suffix}`;
const outsiderId = `agent-run-outsider-${suffix}`;
const memberId = `agent-run-member-${suffix}`;
let agentId = "";
let versionId = "";
let pokeCount = 0;
let cancelPokes: string[] = [];
const trigger = {
	deployedAgentRunQueued() {
		pokeCount += 1;
	},
	deployedAgentRunCancelled(runId: string) {
		cancelPokes.push(runId);
	},
} as AgentTriggerService;
const service = new AgentRunsService(db, new AgentAccessService(db), trigger);

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
	await db.insert(user).values([
		{
			id: userId,
			name: "Agent Run Test",
			email: `${userId}@example.test`,
		},
		{
			id: outsiderId,
			name: "Agent Run Outsider",
			email: `${outsiderId}@example.test`,
		},
	]);
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
			.values({ name: "Run safely", status: "LIVE", createdById: userId })
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
				instructions: "Run once.",
				manifest: {},
				modelId: "test/model",
				sandboxPolicy: {},
				createdById: userId,
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
});

afterAll(async () => {
	const agentIds = (
		await db
			.select({ id: agentDefinition.id })
			.from(agentDefinition)
			.where(eq(agentDefinition.createdById, userId))
	).map((agent) => agent.id);
	if (agentIds.length > 0) {
		await db
			.delete(agentRunEvent)
			.where(
				inArray(
					agentRunEvent.runId,
					db
						.select({ id: agentRun.id })
						.from(agentRun)
						.where(inArray(agentRun.agentId, agentIds)),
				),
			);
		await db.delete(agentAction).where(inArray(agentAction.agentId, agentIds));
		await db
			.delete(agentAuditEvent)
			.where(inArray(agentAuditEvent.agentId, agentIds));
		await db.delete(agentRun).where(inArray(agentRun.agentId, agentIds));
		await db
			.update(agentDefinition)
			.set({ currentVersionId: null })
			.where(inArray(agentDefinition.id, agentIds));
		await db
			.delete(agentVersion)
			.where(inArray(agentVersion.agentId, agentIds));
		await db
			.delete(agentDefinition)
			.where(inArray(agentDefinition.id, agentIds));
	}
	await db.delete(member).where(eq(member.id, memberId));
	await db.delete(user).where(inArray(user.id, [userId, outsiderId]));
});

afterEach(async () => {
	if (!agentId) return;
	await db
		.update(agentRun)
		.set({
			status: "CANCELLED",
			errorCode: "TEST_CLEANUP",
			errorMessage: "Settled between tests.",
			finishedAt: new Date(),
		})
		.where(
			and(
				eq(agentRun.agentId, agentId),
				inArray(agentRun.status, ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"]),
			),
		);
});

describe("manual agent runs", () => {
	it("returns ordered, transport-safe run and activity history", async () => {
		const clientRequestId = crypto.randomUUID();
		const { id: runId } = await service.runNow(
			{ id: agentId, clientRequestId },
			userId,
		);
		const startedAt = new Date("2026-08-05T12:00:00.000Z");
		const completedAt = new Date("2026-08-05T12:00:02.000Z");
		await one(
			db
				.update(agentRun)
				.set({
					status: "SUCCEEDED",
					summary: "Prepared the account brief",
					modelId: "test/model",
					inputTokens: 120,
					outputTokens: 80,
					costUsd: new Decimal("0.012345"),
					startedAt,
					finishedAt: completedAt,
				})
				.where(eq(agentRun.id, runId))
				.returning(),
		);
		await one(
			db
				.insert(agentRunEvent)
				.values({
					runId,
					sequence: 1,
					type: "run.completed",
					data: { summary: "Prepared the account brief" },
					emittedAt: completedAt,
				})
				.returning(),
		);
		await one(
			db
				.insert(agentAction)
				.values({
					agentId,
					runId,
					type: "timeline.note.created",
					provider: "crm",
					targetType: "company",
					targetId: "company-1",
					targetLabel: "Acme",
					summary: "Added a meeting brief",
					status: "SUCCEEDED",
					idempotencyKey: `action-${clientRequestId}`,
					plannedAt: startedAt,
					startedAt,
					completedAt,
				})
				.returning(),
		);

		const [runs, activity] = await Promise.all([
			service.list(agentId, 1, userId),
			service.activity(agentId, 1, userId),
		]);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			id: runId,
			status: "SUCCEEDED",
			costUsd: "0.012345",
			startedAt: startedAt.toISOString(),
			finishedAt: completedAt.toISOString(),
			events: [
				{ sequence: 0, type: "run.queued", emittedAt: expect.any(String) },
				{
					sequence: 1,
					type: "run.completed",
					emittedAt: completedAt.toISOString(),
				},
			],
			actions: [
				{
					type: "timeline.note.created",
					plannedAt: startedAt.toISOString(),
					startedAt: startedAt.toISOString(),
					completedAt: completedAt.toISOString(),
				},
			],
		});
		expect(runs[0]?.createdAt).toBe(
			new Date(runs[0]?.createdAt ?? "").toISOString(),
		);
		expect(activity).toHaveLength(1);
		expect(activity[0]).toMatchObject({
			type: "run.requested",
			requestId: clientRequestId,
			emittedAt: expect.any(String),
			actorUser: { id: userId },
			version: { id: versionId, number: 1 },
		});
	});

	it("rejects a manual run while an agent is not live", async () => {
		const beforePokeCount = pokeCount;
		const draft = await one(
			db
				.insert(agentDefinition)
				.values({
					name: "Draft run guard",
					status: "DRAFT",
					createdById: userId,
				})
				.returning({ id: agentDefinition.id }),
		);

		let runError: unknown;
		try {
			await service.runNow(
				{ id: draft.id, clientRequestId: crypto.randomUUID() },
				userId,
			);
		} catch (error) {
			runError = error;
		}
		expect((runError as Error).message).toBe("This agent is not live yet.");
		expect(pokeCount).toBe(beforePokeCount);
	});

	it("deduplicates concurrent requests and keeps the run and audit atomic", async () => {
		const beforePokeCount = pokeCount;
		const clientRequestId = crypto.randomUUID();
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				service.runNow({ id: agentId, clientRequestId }, userId),
			),
		);

		expect(new Set(results.map((result) => result.id)).size).toBe(1);
		expect(
			await db.$count(agentRun, eq(agentRun.idempotencyKey, clientRequestId)),
		).toBe(1);
		expect(
			await db.$count(
				agentAuditEvent,
				and(
					eq(agentAuditEvent.agentId, agentId),
					eq(agentAuditEvent.type, "run.requested"),
					eq(agentAuditEvent.requestId, clientRequestId),
				),
			),
		).toBe(1);
		expect(pokeCount).toBe(beforePokeCount + 4);
	});

	it("rejects a second manual run while the first is active", async () => {
		const first = await service.runNow(
			{ id: agentId, clientRequestId: crypto.randomUUID() },
			userId,
		);

		let error: Error | null = null;
		try {
			await service.runNow(
				{ id: agentId, clientRequestId: crypto.randomUUID() },
				userId,
			);
		} catch (caught) {
			error = caught as Error;
		}

		expect(error?.message).toBe(
			"This agent already has an active run. Stop it or wait for it to finish.",
		);
		expect(
			await db.$count(
				agentRun,
				and(
					eq(agentRun.agentId, agentId),
					inArray(agentRun.status, [
						"QUEUED",
						"RUNNING",
						"WAITING_FOR_APPROVAL",
					]),
				),
			),
		).toBe(1);
		expect(
			await one(
				db.select().from(agentRun).where(eq(agentRun.id, first.id)).limit(1),
			),
		).toMatchObject({ status: "QUEUED" });
	});

	it("checks workspace membership before replaying an existing request", async () => {
		const clientRequestId = crypto.randomUUID();
		await service.runNow({ id: agentId, clientRequestId }, userId);

		let error: Error | null = null;
		try {
			await service.runNow({ id: agentId, clientRequestId }, outsiderId);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error?.message).toBe("You are not a member of this workspace.");
	});

	it("retries a failed run against the version that run executed", async () => {
		const first = await service.runNow(
			{ id: agentId, clientRequestId: crypto.randomUUID() },
			userId,
		);
		await one(
			db
				.update(agentRun)
				.set({
					status: "FAILED",
					errorCode: "TEST_FAILURE",
					errorMessage: "Broke before the retry.",
					finishedAt: new Date(),
				})
				.where(eq(agentRun.id, first.id))
				.returning(),
		);
		const redeployed = await one(
			db
				.insert(agentVersion)
				.values({
					agentId,
					number: 2,
					status: "DEPLOYED",
					instructions: "Run differently.",
					manifest: {},
					modelId: "test/model",
					sandboxPolicy: {},
					createdById: userId,
				})
				.returning({ id: agentVersion.id }),
		);
		await one(
			db
				.update(agentDefinition)
				.set({ currentVersionId: redeployed.id })
				.where(eq(agentDefinition.id, agentId))
				.returning(),
		);

		const clientRequestId = crypto.randomUUID();
		try {
			const retried = await service.retryRun(
				{ id: agentId, runId: first.id, clientRequestId },
				userId,
			);

			expect(
				await one(
					db
						.select({ versionId: agentRun.versionId })
						.from(agentRun)
						.where(eq(agentRun.id, retried.id))
						.limit(1),
				),
			).toEqual({ versionId });
			expect(
				await one(
					db
						.select({ versionId: agentAuditEvent.versionId })
						.from(agentAuditEvent)
						.where(
							and(
								eq(agentAuditEvent.agentId, agentId),
								eq(agentAuditEvent.type, "run.requested"),
								eq(agentAuditEvent.requestId, clientRequestId),
							),
						)
						.limit(1),
				),
			).toEqual({ versionId });
		} finally {
			await one(
				db
					.update(agentDefinition)
					.set({ currentVersionId: versionId })
					.where(eq(agentDefinition.id, agentId))
					.returning(),
			);
		}
	});

	it("allows only one agent to claim a globally reused request id", async () => {
		const otherAgent = await one(
			db
				.insert(agentDefinition)
				.values({
					name: "Other live agent",
					status: "LIVE",
					createdById: userId,
				})
				.returning({ id: agentDefinition.id }),
		);
		const otherVersion = await one(
			db
				.insert(agentVersion)
				.values({
					agentId: otherAgent.id,
					number: 1,
					status: "DEPLOYED",
					instructions: "Run once.",
					manifest: {},
					modelId: "test/model",
					sandboxPolicy: {},
					createdById: userId,
				})
				.returning({ id: agentVersion.id }),
		);
		await one(
			db
				.update(agentDefinition)
				.set({ currentVersionId: otherVersion.id })
				.where(eq(agentDefinition.id, otherAgent.id))
				.returning(),
		);
		const clientRequestId = crypto.randomUUID();

		const attempts = await Promise.allSettled([
			service.runNow({ id: agentId, clientRequestId }, userId),
			service.runNow({ id: otherAgent.id, clientRequestId }, userId),
		]);
		expect(
			attempts.filter((attempt) => attempt.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			attempts.filter((attempt) => attempt.status === "rejected"),
		).toHaveLength(1);
		expect(
			await db.$count(agentRun, eq(agentRun.idempotencyKey, clientRequestId)),
		).toBe(1);
	});
});

describe("cancelling a run", () => {
	async function queuedRun() {
		const { id } = await service.runNow(
			{ id: agentId, clientRequestId: crypto.randomUUID() },
			userId,
		);
		cancelPokes = [];
		return id;
	}

	it("settles a queued run and asks the agent to drop the turn", async () => {
		const runId = await queuedRun();

		const result = await service.cancelRun({ id: agentId, runId }, userId);

		expect(result).toMatchObject({ id: runId, status: "CANCELLED" });
		expect(result.cancelled).toBe(true);
		expect(cancelPokes).toEqual([runId]);

		const run = await one(
			db
				.select({
					status: agentRun.status,
					errorCode: agentRun.errorCode,
					finishedAt: agentRun.finishedAt,
				})
				.from(agentRun)
				.where(eq(agentRun.id, runId))
				.limit(1),
		);
		expect(run.status).toBe("CANCELLED");
		expect(run.errorCode).toBe("CANCELLED_BY_USER");
		expect(run.finishedAt).not.toBeNull();
	});

	it("records one terminal event and one audit event", async () => {
		const runId = await queuedRun();
		await service.cancelRun({ id: agentId, runId }, userId);

		const events = await db
			.select({ id: agentRunEvent.id })
			.from(agentRunEvent)
			.where(
				and(
					eq(agentRunEvent.runId, runId),
					eq(agentRunEvent.type, "run.cancelled"),
				),
			);
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe(`run-terminal:${runId}:cancelled`);

		expect(
			await db.$count(
				agentAuditEvent,
				and(
					eq(agentAuditEvent.agentId, agentId),
					eq(agentAuditEvent.type, "run.cancelled"),
					eq(agentAuditEvent.requestId, runId),
				),
			),
		).toBe(1);
	});

	it("cancels outstanding actions so nothing is left running", async () => {
		const runId = await queuedRun();
		await db.insert(agentAction).values([
			{
				agentId,
				runId,
				type: "crm.activity.create",
				provider: "crm",
				summary: "Planned note",
				status: "PLANNED",
				idempotencyKey: `${runId}:planned`,
				requestHash: "planned",
			},
			{
				agentId,
				runId,
				type: "slack.message.post",
				provider: "slack",
				summary: "Already posted",
				status: "SUCCEEDED",
				idempotencyKey: `${runId}:done`,
				requestHash: "done",
			},
		]);

		await service.cancelRun({ id: agentId, runId }, userId);

		const actions = await db
			.select({ status: agentAction.status })
			.from(agentAction)
			.where(eq(agentAction.runId, runId))
			.orderBy(asc(agentAction.idempotencyKey));
		expect(actions.map((action) => action.status)).toEqual([
			"SUCCEEDED",
			"CANCELLED",
		]);
	});

	it("is idempotent and never pokes twice", async () => {
		const runId = await queuedRun();
		await service.cancelRun({ id: agentId, runId }, userId);
		cancelPokes = [];

		const again = await service.cancelRun({ id: agentId, runId }, userId);

		expect(again.cancelled).toBe(false);
		expect(again.status).toBe("CANCELLED");
		expect(cancelPokes).toEqual([]);
		expect(
			await db.$count(
				agentRunEvent,
				and(
					eq(agentRunEvent.runId, runId),
					eq(agentRunEvent.type, "run.cancelled"),
				),
			),
		).toBe(1);
	});

	it("leaves a finished run alone", async () => {
		const runId = await queuedRun();
		await one(
			db
				.update(agentRun)
				.set({ status: "SUCCEEDED", finishedAt: new Date() })
				.where(eq(agentRun.id, runId))
				.returning(),
		);

		const result = await service.cancelRun({ id: agentId, runId }, userId);

		expect(result).toMatchObject({ status: "SUCCEEDED", cancelled: false });
		expect(cancelPokes).toEqual([]);
	});

	it("refuses a run id that belongs to another agent", async () => {
		const runId = await queuedRun();
		const other = await one(
			db
				.insert(agentDefinition)
				.values({ name: "Unrelated", status: "LIVE", createdById: userId })
				.returning({ id: agentDefinition.id }),
		);

		let error: Error | null = null;
		try {
			await service.cancelRun({ id: other.id, runId }, userId);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error?.message).toBe(`No run with id ${runId}.`);
	});

	it("refuses a caller who is not a workspace member", async () => {
		const runId = await queuedRun();

		let error: Error | null = null;
		try {
			await service.cancelRun({ id: agentId, runId }, outsiderId);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error?.message).toBe("You are not a member of this workspace.");
	});

	it("reports cancellable runs to the caller who may stop them", async () => {
		const runId = await queuedRun();

		const history = await service.list(agentId, 50, userId);
		const row = history.find((run) => run.id === runId);
		expect(row?.canCancel).toBe(true);

		await service.cancelRun({ id: agentId, runId }, userId);
		const settled = await service.list(agentId, 50, userId);
		expect(settled.find((run) => run.id === runId)?.canCancel).toBe(false);
	});

	it("asks the agent again until the cancellation lands", async () => {
		const runId = await queuedRun();
		await one(
			db
				.update(agentRun)
				.set({ status: "RUNNING", startedAt: new Date() })
				.where(eq(agentRun.id, runId))
				.returning(),
		);
		await service.cancelRun({ id: agentId, runId }, userId);

		const trigger = new AgentTriggerService(db);
		const asked: string[] = [];
		const asksForRun = () => asked.filter((id) => id === runId).length;
		let status = 502;
		const realFetch = globalThis.fetch;
		const realSecret = process.env.AGENT_BRIDGE_SECRET;
		process.env.AGENT_BRIDGE_SECRET = "run-cancel-test";
		globalThis.fetch = (async (
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			const body = JSON.parse(String(init?.body)) as { runId: string };
			asked.push(body.runId);
			return new Response(null, { status });
		}) as typeof fetch;

		try {
			await trigger.redeliverCancellations();
			expect(asksForRun()).toBe(1);

			status = 202;
			await trigger.redeliverCancellations();
			expect(asksForRun()).toBe(2);

			await trigger.redeliverCancellations();
			expect(asksForRun()).toBe(2);
		} finally {
			globalThis.fetch = realFetch;
			if (realSecret === undefined) {
				delete process.env.AGENT_BRIDGE_SECRET;
			} else {
				process.env.AGENT_BRIDGE_SECRET = realSecret;
			}
		}
	});
});
