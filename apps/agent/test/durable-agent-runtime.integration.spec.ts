import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	activity,
	agentAction,
	agentAuditEvent,
	agentConversation,
	agentConversationAttachment,
	agentConversationSubmission,
	agentDefinition,
	agentEvent,
	agentRun,
	agentRunEvent,
	agentTrigger,
	agentVersion,
	and,
	asc,
	company,
	db,
	eq,
	inArray,
	type NewAgentConversation,
	type NewAgentConversationAttachment,
	type NewAgentConversationSubmission,
	requireRow,
	sql,
	startsWith,
	user,
	whereEq,
} from "@crm/db";
import type { SendFn } from "eve/channels";
import { z } from "zod";
import audit from "../agent/hooks/audit";
import {
	builderToken,
	dispatchAgentRun,
	dispatchBuilderSubmission,
	failRun,
	pendingAgentRunIds,
	pendingBuilderSubmissionIds,
	queueDueAgentRuns,
	queueEventAgentRuns,
} from "../agent/lib/custom-agent-dispatch";
import {
	createRunActivity,
	finishRun,
	runResultOf,
	stageRunResult,
} from "../agent/lib/run-runtime";

const attachmentBytes = z.object({ data: z.instanceof(Uint8Array) });

const suffix = crypto.randomUUID();
const userId = `durable-runtime-user-${suffix}`;
const domain = `durable-${suffix}.example.test`;
let agentId = "";
let versionId = "";
let companyId = "";
let otherCompanyId = "";
let triggerId = "";
const builderConversationIds: string[] = [];

beforeAll(async () => {
	await requireRow(
		db
			.insert(user)
			.values({
				id: userId,
				name: "Durable Runtime Test",
				email: `${userId}@example.test`,
			})
			.returning(),
	);
	const [created, otherCreated] = await Promise.all([
		requireRow(
			db
				.insert(company)
				.values({ name: "Durable Runtime Company", domain })
				.returning({ id: company.id }),
		),
		requireRow(
			db
				.insert(company)
				.values({ name: "Out of Scope Company", domain: `other-${domain}` })
				.returning({ id: company.id }),
		),
	]);
	companyId = created.id;
	otherCompanyId = otherCreated.id;

	const agent = await requireRow(
		db
			.insert(agentDefinition)
			.values({
				name: "Durable runtime",
				status: "LIVE",
				createdById: userId,
			})
			.returning({ id: agentDefinition.id }),
	);
	agentId = agent.id;
	const version = await requireRow(
		db
			.insert(agentVersion)
			.values({
				agentId,
				number: 1,
				status: "DEPLOYED",
				instructions: "Create one approved CRM activity.",
				manifest: {
					triggers: [
						{
							type: "SCHEDULE",
							name: "Every hour",
							summary: "Run every hour",
							config: {
								nextRunAt: new Date().toISOString(),
								intervalMinutes: 60,
							},
						},
					],
					dataScope: {
						mode: "SELECTED",
						summary: "Only the selected durable runtime company",
						resources: [
							{
								kind: "company",
								id: companyId,
								label: "Durable Runtime Company",
							},
						],
					},
					actions: [
						{
							type: "crm.activity.create",
							provider: "crm",
							summary: "Create a CRM note",
							activityTypes: ["NOTE"],
						},
						{
							type: "run.summary",
							provider: "crm",
							summary: "Summarize the run",
						},
					],
				},
				modelId: "test/model",
				sandboxPolicy: {},
				createdById: userId,
				approvedAt: new Date(),
				deployedAt: new Date(),
			})
			.returning({ id: agentVersion.id }),
	);
	versionId = version.id;
	await requireRow(
		db
			.update(agentDefinition)
			.set({ currentVersionId: versionId })
			.where(whereEq(agentDefinition.id, agentId))
			.returning(),
	);
	const trigger = await requireRow(
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
				nextRunAt: new Date(Date.now() - 60_000),
			})
			.returning({ id: agentTrigger.id }),
	);
	triggerId = trigger.id;
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
				whereEq(agentRun.agentId, agentId),
				inArray(agentRun.status, ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"]),
			),
		);
});

afterAll(async () => {
	if (builderConversationIds.length > 0) {
		await db
			.delete(agentConversation)
			.where(inArray(agentConversation.id, builderConversationIds));
	}
	if (agentId) {
		await db
			.delete(agentEvent)
			.where(startsWith(agentEvent.sessionId, `durable-session-${suffix}`));
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
			.delete(activity)
			.where(sql`${activity.meta} #>> '{agentId}' = ${agentId}`);
		await db
			.delete(agentAuditEvent)
			.where(whereEq(agentAuditEvent.agentId, agentId));
		await db.delete(agentRun).where(whereEq(agentRun.agentId, agentId));
		await db.delete(agentTrigger).where(whereEq(agentTrigger.agentId, agentId));
		await db
			.update(agentDefinition)
			.set({ currentVersionId: null })
			.where(whereEq(agentDefinition.id, agentId));
		await db.delete(agentVersion).where(whereEq(agentVersion.agentId, agentId));
		await db
			.delete(agentDefinition)
			.where(whereEq(agentDefinition.id, agentId));
	}
	await db
		.delete(company)
		.where(inArray(company.id, [companyId, otherCompanyId]));
	await db.delete(user).where(whereEq(user.id, userId));
});

async function builderConversation(
	conversation: NewAgentConversation,
	submission: Omit<NewAgentConversationSubmission, "conversationId">,
	attachment?: Omit<NewAgentConversationAttachment, "submissionId">,
) {
	const created = await requireRow(
		db
			.insert(agentConversation)
			.values(conversation)
			.returning({ id: agentConversation.id }),
	);
	const submitted = await requireRow(
		db
			.insert(agentConversationSubmission)
			.values({ ...submission, conversationId: created.id })
			.returning({ id: agentConversationSubmission.id }),
	);
	if (attachment) {
		await db
			.insert(agentConversationAttachment)
			.values({ ...attachment, submissionId: submitted.id });
	}
	return { id: created.id, submissions: [submitted] };
}

async function createRun(
	status: "QUEUED" | "RUNNING" = "RUNNING",
	startedAt: Date | null = new Date(),
	sessionId: string | null = null,
	triggerType: "MANUAL" | "EVENT" = "MANUAL",
) {
	const run = await requireRow(
		db
			.insert(agentRun)
			.values({
				agentId,
				versionId,
				triggerType,
				status,
				startedAt,
				sessionId,
				idempotencyKey: `durable-run-${crypto.randomUUID()}`,
				correlationId: crypto.randomUUID(),
			})
			.returning({ id: agentRun.id }),
	);
	await db
		.insert(agentRunEvent)
		.values({ runId: run.id, sequence: 0, type: "run.queued", data: {} });
	return run;
}

async function satisfyRequiredActivity(runId: string, callId: string) {
	return createRunActivity(runId, callId, {
		type: "NOTE",
		targetKind: "company",
		targetId: companyId,
		subject: "Runtime test",
		body: "Completed the required action.",
	});
}

describe("durable custom-agent runtime", () => {
	it("queues one run per matching event trigger and event occurrence", async () => {
		const trigger = await requireRow(
			db
				.insert(agentTrigger)
				.values({
					agentId,
					versionId,
					type: "EVENT",
					name: "When a deal closes",
					config: { event: "deal.closed" },
					createdById: userId,
					enabled: true,
				})
				.returning({ id: agentTrigger.id }),
		);
		const occurredAt = new Date().toISOString();
		const task = {
			id: `event-task-${suffix}`,
			contactId: null,
			companyId: null,
			dealId: `event-deal-${suffix}`,
			payload: {
				type: "deal.closed",
				record: { kind: "deal", id: `event-deal-${suffix}` },
				occurredAt,
				data: { from: "NEGOTIATION", to: "CLOSED_WON" },
			},
		};

		await Promise.all([
			queueEventAgentRuns(task),
			queueEventAgentRuns(task),
			queueEventAgentRuns(task),
		]);

		const runs = await db
			.select({
				triggerType: agentRun.triggerType,
				status: agentRun.status,
				input: agentRun.input,
			})
			.from(agentRun)
			.where(whereEq(agentRun.triggerId, trigger.id));
		expect(runs).toEqual([
			{
				triggerType: "EVENT",
				status: "QUEUED",
				input: {
					event: {
						type: "deal.closed",
						occurredAt,
						data: { from: "NEGOTIATION", to: "CLOSED_WON" },
					},
					record: { kind: "deal", id: `event-deal-${suffix}` },
				},
			},
		]);
	});

	it("advances a due trigger only when its run is committed", async () => {
		const now = new Date();
		const results = await Promise.all(
			Array.from({ length: 4 }, () => queueDueAgentRuns(now)),
		);

		expect(results.reduce((total, count) => total + count, 0)).toBe(1);
		const [trigger, scheduledRuns] = await Promise.all([
			requireRow(
				db
					.select()
					.from(agentTrigger)
					.where(whereEq(agentTrigger.id, triggerId))
					.limit(1),
			),
			db
				.select({
					id: agentRun.id,
					status: agentRun.status,
					input: agentRun.input,
				})
				.from(agentRun)
				.where(whereEq(agentRun.triggerId, triggerId)),
		]);
		expect(trigger.lastRunAt).not.toBeNull();
		expect(trigger.nextRunAt?.getTime()).toBeGreaterThan(now.getTime());
		expect(scheduledRuns).toHaveLength(1);
		expect(scheduledRuns[0]?.status).toBe("QUEUED");
	});

	it("recovers only sessionless runs with an expired delivery lease", async () => {
		const stale = new Date(Date.now() - 10 * 60_000);
		const [recoverable, active] = await Promise.all([
			createRun("RUNNING", stale),
			createRun("RUNNING", stale, `durable-session-${suffix}-already-started`),
		]);

		const pending = await pendingAgentRunIds();
		const [recovered, untouched] = await Promise.all([
			requireRow(
				db
					.select()
					.from(agentRun)
					.where(whereEq(agentRun.id, recoverable.id))
					.limit(1),
			),
			requireRow(
				db
					.select()
					.from(agentRun)
					.where(whereEq(agentRun.id, active.id))
					.limit(1),
			),
		]);
		expect(pending).not.toContain(recoverable.id);
		expect(recovered).toMatchObject({ status: "QUEUED", startedAt: null });
		expect(
			await db.$count(
				agentRunEvent,
				and(
					whereEq(agentRunEvent.runId, recoverable.id),
					eq(agentRunEvent.type, "run.delivery_recovered"),
				),
			),
		).toBe(1);
		expect(untouched.status).toBe("RUNNING");
	});

	it("claims one live run delivery and persists its Eve session", async () => {
		const run = await createRun("QUEUED", null);
		let deliveries = 0;
		const sessionId = `durable-session-${suffix}-agent-dispatch`;
		const send = (async () => {
			deliveries += 1;
			return { id: sessionId };
		}) as unknown as SendFn;

		const attempts = await Promise.allSettled([
			dispatchAgentRun(run.id, send),
			dispatchAgentRun(run.id, send),
		]);
		const persisted = await requireRow(
			db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
		);
		expect(
			attempts.filter((attempt) => attempt.status === "fulfilled"),
		).toHaveLength(1);
		expect(deliveries).toBe(1);
		expect(persisted).toMatchObject({
			status: "RUNNING",
			sessionId,
			modelId: "test/model",
		});
	});

	it("runs only one turn per agent while leaving later work queued", async () => {
		const [first, second] = await Promise.all([
			createRun("QUEUED", null),
			createRun("QUEUED", null),
		]);
		const deliveries: string[] = [];
		const send = (async (message: string) => {
			deliveries.push(message);
			return { id: `durable-session-${suffix}-serialized` };
		}) as unknown as SendFn;

		const results = await Promise.allSettled([
			dispatchAgentRun(first.id, send),
			dispatchAgentRun(second.id, send),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(deliveries).toHaveLength(1);
		expect(
			(
				await db
					.select({ status: agentRun.status })
					.from(agentRun)
					.where(inArray(agentRun.id, [first.id, second.id]))
			)
				.map((run) => run.status)
				.sort(),
		).toEqual(["QUEUED", "RUNNING"]);
	});

	it("restores a builder continuation when a delivery lease expires", async () => {
		const conversation = await builderConversation(
			{
				kind: "BUILDER",
				userId,
				sessionId: `durable-session-${suffix}-builder`,
				continuationToken: null,
			},
			{
				submittedById: userId,
				clientRequestId: crypto.randomUUID(),
				message: { text: "Continue building" },
				status: "SENDING",
				attemptCount: 1,
				sentAt: new Date(Date.now() - 10 * 60_000),
			},
		);
		builderConversationIds.push(conversation.id);

		await pendingBuilderSubmissionIds();
		const [submission, restored] = await Promise.all([
			requireRow(
				db
					.select()
					.from(agentConversationSubmission)
					.where(
						whereEq(
							agentConversationSubmission.id,
							conversation.submissions[0]?.id,
						),
					)
					.limit(1),
			),
			requireRow(
				db
					.select()
					.from(agentConversation)
					.where(whereEq(agentConversation.id, conversation.id))
					.limit(1),
			),
		]);
		expect(submission.status).toBe("PENDING");
		expect(restored.continuationToken).toBe(builderToken(conversation.id));
	});

	it("keeps concurrent builder dispatches in conversation order", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({ kind: "BUILDER", userId })
				.returning({ id: agentConversation.id }),
		);
		builderConversationIds.push(conversation.id);
		const firstCreatedAt = new Date();
		const [first, second] = await Promise.all([
			requireRow(
				db
					.insert(agentConversationSubmission)
					.values({
						conversationId: conversation.id,
						submittedById: userId,
						clientRequestId: crypto.randomUUID(),
						message: { text: "First" },
						createdAt: firstCreatedAt,
					})
					.returning({ id: agentConversationSubmission.id }),
			),
			requireRow(
				db
					.insert(agentConversationSubmission)
					.values({
						conversationId: conversation.id,
						submittedById: userId,
						clientRequestId: crypto.randomUUID(),
						message: { text: "Second" },
						createdAt: new Date(firstCreatedAt.getTime() + 1),
					})
					.returning({ id: agentConversationSubmission.id }),
			),
		]);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let deliveries = 0;
		const send = (async () => {
			deliveries += 1;
			started.resolve();
			await release.promise;
			return { id: `durable-session-${suffix}-builder-dispatch` };
		}) as unknown as SendFn;

		const firstDispatch = dispatchBuilderSubmission(first.id, send);
		await started.promise;
		let secondError: Error | null = null;
		try {
			await dispatchBuilderSubmission(second.id, send);
		} catch (error) {
			secondError = error as Error;
		}
		release.resolve();
		await firstDispatch;

		const submissions = await db
			.select({
				id: agentConversationSubmission.id,
				status: agentConversationSubmission.status,
			})
			.from(agentConversationSubmission)
			.where(inArray(agentConversationSubmission.id, [first.id, second.id]))
			.orderBy(
				asc(agentConversationSubmission.createdAt),
				asc(agentConversationSubmission.id),
			);
		expect(deliveries).toBe(1);
		expect(secondError?.message).toContain(
			"already claimed or is out of order",
		);
		expect(submissions).toEqual([
			{ id: first.id, status: "ACCEPTED" },
			{ id: second.id, status: "PENDING" },
		]);
	});

	it("loads persisted attachment bytes into the Eve builder turn", async () => {
		const content = Buffer.from("durable attachment");
		const conversation = await builderConversation(
			{ kind: "BUILDER", userId, permissionMode: "AUTO" },
			{
				submittedById: userId,
				clientRequestId: crypto.randomUUID(),
				message: {
					text: "Read the attachment",
					resources: [],
					attachments: [
						{
							name: "brief.txt",
							type: "text/plain",
							size: content.byteLength,
						},
					],
				},
			},
			{
				position: 0,
				name: "brief.txt",
				mediaType: "text/plain",
				size: content.byteLength,
				content,
			},
		);
		builderConversationIds.push(conversation.id);
		let delivered: Parameters<SendFn>[0] | null = null;
		let deliveredOptions: Parameters<SendFn>[1] | null = null;
		const send = (async (
			input: Parameters<SendFn>[0],
			options: Parameters<SendFn>[1],
		) => {
			delivered = input;
			deliveredOptions = options;
			return { id: `durable-session-${suffix}-attachment` };
		}) as unknown as SendFn;

		await dispatchBuilderSubmission(
			conversation.submissions[0]?.id ?? "",
			send,
		);
		const parts = Array.isArray(delivered) ? delivered : [];
		expect(parts).toHaveLength(2);
		expect(parts[1]).toMatchObject({
			type: "file",
			mediaType: "text/plain",
			filename: "brief.txt",
		});
		expect(Buffer.from(attachmentBytes.parse(parts[1]).data)).toEqual(content);
		expect(deliveredOptions).toMatchObject({
			auth: {
				authenticator: "crm-builder",
				attributes: { permissionMode: "auto" },
			},
		});
	});

	it("ingests a replayed Eve event and its usage exactly once", async () => {
		const run = await createRun();
		const eventId = `evt_${suffix}_usage`;
		type AuditHandler = (
			event: {
				type: string;
				data: object;
				meta: { id: string; at: string };
			},
			ctx: {
				session: {
					id: string;
					auth: {
						current: { attributes: Record<string, string> };
						initiator: null;
					};
				};
			},
		) => Promise<void>;
		const handler = audit.events["*"] as unknown as AuditHandler;
		const event = {
			type: "step.completed",
			data: { usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.01 } },
			meta: { id: eventId, at: new Date().toISOString() },
		};
		const context = {
			session: {
				id: `durable-session-${suffix}-usage`,
				auth: {
					current: {
						attributes: { purpose: "team-agent", runId: run.id },
					},
					initiator: null,
				},
			},
		};

		await handler(event, context);
		await handler(event, context);

		const persisted = await requireRow(
			db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
		);
		expect(persisted).toMatchObject({
			inputTokens: 5,
			outputTokens: 3,
			nextEventSequence: 1,
		});
		expect(Number(persisted.costUsd)).toBe(0.01);
		expect(
			await db.$count(agentRunEvent, whereEq(agentRunEvent.id, eventId)),
		).toBe(1);
		expect(await db.$count(agentEvent, whereEq(agentEvent.id, eventId))).toBe(
			1,
		);
	});

	it("keeps a nested subagent session from replacing the root run session", async () => {
		const rootSessionId = `durable-session-${suffix}-root`;
		const run = await createRun("RUNNING", new Date(), rootSessionId);
		type AuditHandler = (
			event: {
				type: string;
				data: object;
				meta: { id: string; at: string };
			},
			ctx: {
				session: {
					id: string;
					parent?: unknown;
					auth: {
						current: { attributes: Record<string, string> };
						initiator: null;
					};
				};
			},
		) => Promise<void>;
		const handler = audit.events["*"] as unknown as AuditHandler;

		await handler(
			{
				type: "session.started",
				data: {},
				meta: {
					id: `evt_${suffix}_nested_started`,
					at: new Date().toISOString(),
				},
			},
			{
				session: {
					id: `durable-session-${suffix}-nested`,
					parent: { id: rootSessionId },
					auth: {
						current: {
							attributes: { purpose: "team-agent", runId: run.id },
						},
						initiator: null,
					},
				},
			},
		);

		expect(
			await requireRow(
				db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
			),
		).toMatchObject({ sessionId: rootSessionId });
	});

	it("lets the first terminal state win without duplicate terminal logs", async () => {
		const [completed, failed] = await Promise.all([createRun(), createRun()]);
		await satisfyRequiredActivity(completed.id, "terminal-success");
		await finishRun(completed.id, { summary: "Completed safely" });
		await failRun(completed.id, "LATE_FAILURE", "This arrived late");
		await failRun(failed.id, "FIRST_FAILURE", "Failed safely");
		let lateCompletionError: Error | null = null;
		try {
			await finishRun(failed.id, {
				summary: "This must not overwrite failure",
			});
		} catch (error) {
			lateCompletionError = error as Error;
		}
		await failRun(failed.id, "SECOND_FAILURE", "This arrived late");

		const [completedRow, failedRow] = await Promise.all([
			requireRow(
				db
					.select()
					.from(agentRun)
					.where(whereEq(agentRun.id, completed.id))
					.limit(1),
			),
			requireRow(
				db
					.select()
					.from(agentRun)
					.where(whereEq(agentRun.id, failed.id))
					.limit(1),
			),
		]);
		expect(completedRow).toMatchObject({
			status: "SUCCEEDED",
			summary: "Completed safely",
		});
		expect(failedRow).toMatchObject({
			status: "FAILED",
			errorCode: "FIRST_FAILURE",
			errorMessage: "Failed safely",
		});
		expect(lateCompletionError?.message).toContain("already ended with FAILED");
		expect(
			await db.$count(
				agentRunEvent,
				and(
					inArray(agentRunEvent.runId, [completed.id, failed.id]),
					inArray(agentRunEvent.type, ["run.completed", "run.failed"]),
				),
			),
		).toBe(2);
	});

	it("stages tool output before the session owns terminal completion", async () => {
		const run = await createRun();
		await stageRunResult(run.id, {
			summary: "Staged safely",
			result: { noted: 2 },
		});
		const staged = await requireRow(
			db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
		);
		expect(staged).toMatchObject({
			status: "RUNNING",
			summary: "Staged safely",
			result: { noted: 2 },
		});
		expect(
			await db.$count(
				agentRunEvent,
				and(
					whereEq(agentRunEvent.runId, run.id),
					eq(agentRunEvent.type, "run.completed"),
				),
			),
		).toBe(0);

		await satisfyRequiredActivity(run.id, "staged-success");
		await finishRun(run.id, {
			summary: staged.summary ?? "Staged safely",
			result: runResultOf(staged.result),
		});
		expect(
			await requireRow(
				db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
			),
		).toMatchObject({ status: "SUCCEEDED", summary: "Staged safely" });
	});

	it("fails a run that never performs its declared external action", async () => {
		const run = await createRun();
		const finished = await finishRun(run.id, {
			summary: "Claimed completion without acting",
		});

		expect(finished).toEqual({ id: run.id, status: "FAILED" });
		expect(
			await requireRow(
				db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
			),
		).toMatchObject({
			status: "FAILED",
			errorCode: "ACTION_NOT_PERFORMED",
		});
		expect(
			await requireRow(
				db
					.select()
					.from(agentAction)
					.where(
						whereEq(
							agentAction.idempotencyKey,
							`run:${run.id}:required:crm.activity.create`,
						),
					)
					.limit(1),
			),
		).toMatchObject({
			status: "FAILED",
			errorCode: "ACTION_NOT_PERFORMED",
		});
	});

	it("refuses a self-reported no-action ending on a manual run", async () => {
		const run = await createRun();
		let stageError: Error | null = null;
		try {
			await stageRunResult(run.id, {
				summary: "Nothing to do",
				noActionNeeded: { reason: "The condition was not met." },
			});
		} catch (error) {
			stageError = error as Error;
		}
		expect(stageError?.message).toContain(
			"manual run cannot end with no action needed",
		);

		const finished = await finishRun(run.id, {
			summary: "Nothing to do",
			result: { noActionNeeded: "The condition was not met." },
		});
		expect(finished).toEqual({ id: run.id, status: "FAILED" });
		expect(
			await requireRow(
				db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
			),
		).toMatchObject({ status: "FAILED", errorCode: "ACTION_NOT_PERFORMED" });
		expect(
			await db.$count(
				agentRunEvent,
				and(
					whereEq(agentRunEvent.runId, run.id),
					eq(agentRunEvent.type, "run.completed"),
				),
			),
		).toBe(0);
	});

	it("accepts a no-action ending on an event run whose condition was not met", async () => {
		const run = await createRun("RUNNING", new Date(), null, "EVENT");
		await stageRunResult(run.id, {
			summary: "The deal was already closed",
			noActionNeeded: { reason: "The condition was not met." },
		});
		const staged = await requireRow(
			db.select().from(agentRun).where(whereEq(agentRun.id, run.id)).limit(1),
		);
		expect(staged.result).toMatchObject({
			noActionNeeded: "The condition was not met.",
		});

		const finished = await finishRun(run.id, {
			summary: staged.summary ?? "The deal was already closed",
			result: runResultOf(staged.result),
		});
		expect(finished).toEqual({ id: run.id, status: "SUCCEEDED" });
		expect(
			await db.$count(agentAction, whereEq(agentAction.runId, run.id)),
		).toBe(0);
	});

	it("claims an approved CRM action once and rejects scope before target access", async () => {
		const run = await createRun();
		const input = {
			type: "NOTE" as const,
			targetKind: "company" as const,
			targetId: companyId,
			subject: "Durable note",
			body: "Created exactly once.",
		};
		const attempts = await Promise.allSettled(
			Array.from({ length: 4 }, () =>
				createRunActivity(run.id, "shared-call", input),
			),
		);
		expect(
			attempts.filter((attempt) => attempt.status === "fulfilled").length,
		).toBeGreaterThanOrEqual(1);
		const replay = await createRunActivity(run.id, "shared-call", input);
		expect(replay.replayed).toBe(true);
		let reusedCallError: Error | null = null;
		try {
			await createRunActivity(run.id, "shared-call", {
				...input,
				body: "Different input must not replay the earlier action.",
			});
		} catch (error) {
			reusedCallError = error as Error;
		}
		expect(reusedCallError?.message).toContain("already used for other input");
		expect(
			await db.$count(
				agentAction,
				and(
					whereEq(agentAction.runId, run.id),
					whereEq(agentAction.idempotencyKey, `${run.id}:shared-call`),
				),
			),
		).toBe(1);
		expect(
			await db.$count(
				activity,
				sql`${activity.meta} #>> '{runId}' = ${run.id}`,
			),
		).toBe(1);

		let scopeError: Error | null = null;
		try {
			await createRunActivity(run.id, "out-of-scope", {
				...input,
				targetId: otherCompanyId,
			});
		} catch (error) {
			scopeError = error as Error;
		}
		expect(scopeError?.message).toContain("outside this agent version");
		expect(
			await db.$count(
				agentAction,
				whereEq(agentAction.idempotencyKey, `${run.id}:out-of-scope`),
			),
		).toBe(0);

		let activityTypeError: Error | null = null;
		try {
			await createRunActivity(run.id, "unapproved-task", {
				...input,
				type: "TASK",
				subject: "This type was not approved",
			});
		} catch (error) {
			activityTypeError = error as Error;
		}
		expect(activityTypeError?.message).toContain(
			"does not allow CRM task activities",
		);
		expect(
			await db.$count(
				agentAction,
				whereEq(agentAction.idempotencyKey, `${run.id}:unapproved-task`),
			),
		).toBe(0);
	});
});
