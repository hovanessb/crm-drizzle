import {
	agentAction,
	agentAuditEvent,
	agentConversation,
	agentConversationAttachment,
	agentConversationSubmission,
	agentDefinition,
	agentRun,
	agentRunEvent,
	agentTrigger,
	and,
	asc,
	db,
	type Executor,
	eq,
	firstRow,
	inArray,
	isNotNull,
	isNull,
	type JsonObject,
	type JsonValue,
	lt,
	lte,
	type NewAgentRun,
	ne,
	notExists,
	or,
	orNull,
	orThrow,
	queryRows,
	requireRow,
	sql,
	whereEq,
} from "@crm/db";
import { CRM_EVENT_CATALOG } from "@crm/db/crm-events";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { crmEventTask } from "@crm/validation/agent-events";
import { readAgentTriggerConfig } from "@crm/validation/agent-manifest";
import type { ChannelSendOptions, ChannelSource, Session } from "eve/channels";
import { z } from "zod";
import { DISPATCH } from "./dispatch-config";
import { DEPENDENCY_UNAVAILABLE, runDependencyFailure } from "./run-preflight";
import {
	isTerminalRunStatus,
	lockAgentRun,
	runTerminalEventId,
} from "./run-state";
import type { LeasedTask } from "./tasks";

const BUILDER_BATCH = DISPATCH.builder.batch;
const RUN_BATCH = DISPATCH.run.batch;
const MAX_BUILDER_ATTEMPTS = DISPATCH.builder.maxAttempts;
const BUILDER_LEASE_MS = DISPATCH.builder.leaseMs;
const RUN_DELIVERY_LEASE_MS = DISPATCH.run.deliveryLeaseMs;

type AgentMessage = Parameters<ChannelSource["send"]>[0];

type BuilderMessageParts = Extract<AgentMessage, readonly unknown[]>;

type BuilderInputResponse =
	| { readonly requestId: string; readonly optionId: string }
	| { readonly requestId: string; readonly text: string };

export type AgentInputResponseDelivery = {
	readonly inputResponses: readonly [BuilderInputResponse];
};

export type AgentDelivery = AgentMessage | AgentInputResponseDelivery;

export type AgentSendOptions = ChannelSendOptions & {
	readonly continuationToken: string;
};

export type SendFn = (
	delivery: AgentDelivery,
	options: AgentSendOptions,
) => Promise<Session>;

const trimmedText = z.string().trim().catch("");

const builderInputResponse = z
	.object({
		requestId: trimmedText,
		optionId: trimmedText,
		text: trimmedText,
	})
	.catch({ requestId: "", optionId: "", text: "" });

const builderSubmissionMessage = z
	.object({
		text: z.string().catch(""),
		resources: z
			.array(z.object({ label: z.string().catch("") }).catch({ label: "" }))
			.catch([]),
		inputResponse: builderInputResponse,
	})
	.catch({
		text: "",
		resources: [],
		inputResponse: { requestId: "", optionId: "", text: "" },
	});

export async function pendingBuilderSubmissionIds(): Promise<string[]> {
	await recoverBuilderSubmissions();
	const rows = await db
		.select({
			id: agentConversationSubmission.id,
			conversationId: agentConversationSubmission.conversationId,
		})
		.from(agentConversationSubmission)
		.where(
			and(
				eq(agentConversationSubmission.status, "PENDING"),
				inArray(
					agentConversationSubmission.conversationId,
					db
						.select({ id: agentConversation.id })
						.from(agentConversation)
						.where(
							and(
								eq(agentConversation.kind, "BUILDER"),
								or(
									isNull(agentConversation.sessionId),
									isNotNull(agentConversation.continuationToken),
								),
							),
						),
				),
			),
		)
		.orderBy(
			asc(agentConversationSubmission.createdAt),
			asc(agentConversationSubmission.id),
		)
		.limit(BUILDER_BATCH * 3);

	const seen = new Set<string>();
	return rows
		.flatMap((row) => {
			if (seen.has(row.conversationId)) return [];
			seen.add(row.conversationId);
			return [row.id];
		})
		.slice(0, BUILDER_BATCH);
}

export async function drainBuilder(send: SendFn): Promise<number> {
	const ids = await pendingBuilderSubmissionIds();
	await Promise.all(ids.map((id) => dispatchBuilderSubmission(id, send)));
	return ids.length;
}

export async function dispatchBuilderSubmission(
	submissionId: string,
	send: SendFn,
) {
	const submission = await db.transaction(async (tx) => {
		const seed = await firstRow(
			tx
				.select({ conversationId: agentConversationSubmission.conversationId })
				.from(agentConversationSubmission)
				.where(whereEq(agentConversationSubmission.id, submissionId))
				.limit(1),
		);
		if (!seed) throw new Error("Builder submission is unavailable.");

		const conversation = await lockBuilderConversation(tx, seed.conversationId);
		if (conversation?.kind !== "BUILDER") {
			throw new Error("Builder submission is unavailable.");
		}
		if (conversation.sessionId && !conversation.continuationToken) {
			throw new Error("Builder conversation is still processing a message.");
		}

		const [active, firstPending] = await Promise.all([
			firstRow(
				tx
					.select({ id: agentConversationSubmission.id })
					.from(agentConversationSubmission)
					.where(
						and(
							whereEq(
								agentConversationSubmission.conversationId,
								conversation.id,
							),
							eq(agentConversationSubmission.status, "SENDING"),
						),
					)
					.limit(1),
			),
			firstRow(
				tx
					.select({ id: agentConversationSubmission.id })
					.from(agentConversationSubmission)
					.where(
						and(
							whereEq(
								agentConversationSubmission.conversationId,
								conversation.id,
							),
							eq(agentConversationSubmission.status, "PENDING"),
						),
					)
					.orderBy(
						asc(agentConversationSubmission.createdAt),
						asc(agentConversationSubmission.id),
					)
					.limit(1),
			),
		]);
		if (active || firstPending?.id !== submissionId) {
			throw new Error(
				"Builder submission was already claimed or is out of order.",
			);
		}

		await requireRow(
			tx
				.update(agentConversationSubmission)
				.set({
					status: "SENDING",
					attemptCount: sql`${agentConversationSubmission.attemptCount} + 1`,
					sentAt: new Date(),
					errorCode: null,
					errorMessage: null,
				})
				.where(whereEq(agentConversationSubmission.id, submissionId))
				.returning(),
		);
		await requireRow(
			tx
				.update(agentConversation)
				.set({ continuationToken: null })
				.where(whereEq(agentConversation.id, conversation.id))
				.returning(),
		);

		return tx.query.agentConversationSubmission
			.findFirst({
				where: whereEq(agentConversationSubmission.id, submissionId),
				columns: {
					id: true,
					commandType: true,
					message: true,
					attemptCount: true,
				},
				with: {
					attachments: {
						orderBy: [asc(agentConversationAttachment.position)],
						columns: { name: true, mediaType: true, content: true },
					},
					conversation: {
						columns: {
							id: true,
							title: true,
							userId: true,
							kind: true,
							permissionMode: true,
						},
					},
				},
			})
			.then(orThrow);
	});
	const conversationId = submission.conversation.id;

	try {
		const session = await send(
			builderDeliveryMessage(
				submission.id,
				submission.message,
				submission.attachments,
			),
			{
				auth: {
					authenticator: "crm-builder",
					principalType: "user",
					principalId: submission.conversation.userId,
					attributes: {
						purpose: "builder",
						commandType: builderCommandType(
							submission.commandType,
							submission.message,
						),
						needsTitle: submission.conversation.title ? "false" : "true",
						conversationId,
						permissionMode: permissionModeAttribute(
							submission.conversation.permissionMode,
						),
						userId: submission.conversation.userId,
						submissionId: submission.id,
					},
				},
				continuationToken: builderToken(conversationId),
				title: submission.conversation.title ?? "Agent builder",
			},
		);

		await db.transaction(async (tx) => {
			const conversation = await lockBuilderConversation(tx, conversationId);
			if (!conversation) return;
			await requireRow(
				tx
					.update(agentConversationSubmission)
					.set({ status: "ACCEPTED", acceptedAt: new Date() })
					.where(whereEq(agentConversationSubmission.id, submission.id))
					.returning(),
			);
			await requireRow(
				tx
					.update(agentConversation)
					.set({
						sessionId: session.id,
					})
					.where(whereEq(agentConversation.id, conversationId))
					.returning(),
			);
		});

		return session;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const retry = submission.attemptCount < MAX_BUILDER_ATTEMPTS;
		await db.transaction(async (tx) => {
			const conversation = await lockBuilderConversation(tx, conversationId);
			if (!conversation) return;
			await requireRow(
				tx
					.update(agentConversationSubmission)
					.set({
						status: retry ? "PENDING" : "FAILED",
						errorCode: "DELIVERY_FAILED",
						errorMessage: message,
					})
					.where(whereEq(agentConversationSubmission.id, submission.id))
					.returning(),
			);
			await requireRow(
				tx
					.update(agentConversation)
					.set({ continuationToken: builderToken(conversationId) })
					.where(whereEq(agentConversation.id, conversationId))
					.returning(),
			);
		});
		throw error;
	}
}

export async function queueDueAgentRuns(now = new Date()): Promise<number> {
	const triggers = await db
		.select({
			id: agentTrigger.id,
			agentId: agentTrigger.agentId,
			versionId: agentTrigger.versionId,
			nextRunAt: agentTrigger.nextRunAt,
			config: agentTrigger.config,
		})
		.from(agentTrigger)
		.where(
			and(
				eq(agentTrigger.enabled, true),
				eq(agentTrigger.type, "SCHEDULE"),
				lte(agentTrigger.nextRunAt, now),
				inArray(
					agentTrigger.agentId,
					db
						.select({ id: agentDefinition.id })
						.from(agentDefinition)
						.where(eq(agentDefinition.status, "LIVE")),
				),
			),
		)
		.orderBy(asc(agentTrigger.nextRunAt), asc(agentTrigger.id))
		.limit(RUN_BATCH);

	let queued = 0;
	for (const trigger of triggers) {
		if (!trigger.nextRunAt) continue;
		const scheduledAt = trigger.nextRunAt;
		const intervalMinutes = readAgentTriggerConfig(
			trigger.config,
		).intervalMinutes;
		const nextRunAt = advance(scheduledAt, intervalMinutes, now);
		const idempotencyKey = `${trigger.id}:${scheduledAt.toISOString()}`;
		const claimed = await db.transaction(async (tx) => {
			const [agent] = await queryRows<{ id: string; status: string }>(
				tx,
				sql`
				SELECT id, status
				FROM "agentDefinition"
				WHERE id = ${trigger.agentId}
				FOR UPDATE
			`,
			);
			if (agent?.status !== "LIVE") return false;

			const updated = await tx
				.update(agentTrigger)
				.set({ nextRunAt, lastRunAt: scheduledAt })
				.where(
					and(
						whereEq(agentTrigger.id, trigger.id),
						whereEq(agentTrigger.nextRunAt, scheduledAt),
						eq(agentTrigger.enabled, true),
					),
				);
			if (updated.rowCount === 0) return false;

			await queueRun(
				tx,
				{
					agentId: trigger.agentId,
					versionId: trigger.versionId,
					triggerId: trigger.id,
					triggerType: "SCHEDULE",
					idempotencyKey,
					correlationId: crypto.randomUUID(),
					input: { scheduledFor: scheduledAt.toISOString() },
				},
				{},
			);
			return true;
		});
		if (claimed) queued += 1;
	}

	return queued;
}

export async function queueEventAgentRuns(
	task: Pick<
		LeasedTask,
		"id" | "contactId" | "companyId" | "dealId" | "payload"
	>,
): Promise<number> {
	const parsed = crmEventTask.safeParse(task.payload);
	if (!parsed.success) {
		throw new Error("The queued agent event is invalid.");
	}

	const { type: eventType, occurredAt, data } = parsed.data;
	const recordKind = CRM_EVENT_CATALOG[eventType].recordKind;
	const recordId = parsed.data.record.id;
	const occurredAtDate = new Date(occurredAt);
	const taskRecordId =
		recordKind === "contact"
			? task.contactId
			: recordKind === "company"
				? task.companyId
				: task.dealId;
	if (taskRecordId !== recordId) {
		throw new Error("The queued agent event is invalid.");
	}

	const triggers = await db
		.select({
			id: agentTrigger.id,
			agentId: agentTrigger.agentId,
			versionId: agentTrigger.versionId,
			config: agentTrigger.config,
		})
		.from(agentTrigger)
		.where(
			and(
				eq(agentTrigger.enabled, true),
				eq(agentTrigger.type, "EVENT"),
				inArray(
					agentTrigger.agentId,
					db
						.select({ id: agentDefinition.id })
						.from(agentDefinition)
						.where(eq(agentDefinition.status, "LIVE")),
				),
			),
		)
		.orderBy(asc(agentTrigger.id));

	let matched = 0;
	for (const trigger of triggers) {
		if (readAgentTriggerConfig(trigger.config).event !== eventType) continue;
		const idempotencyKey = `event:${task.id}:trigger:${trigger.id}`;

		const queued = await db.transaction(async (tx) => {
			await lockIdempotencyKey(tx, idempotencyKey);
			const eligible = await firstRow(
				tx
					.select({ id: agentTrigger.id })
					.from(agentTrigger)
					.where(
						and(
							whereEq(agentTrigger.id, trigger.id),
							eq(agentTrigger.enabled, true),
							eq(agentTrigger.type, "EVENT"),
							inArray(
								agentTrigger.agentId,
								db
									.select({ id: agentDefinition.id })
									.from(agentDefinition)
									.where(eq(agentDefinition.status, "LIVE")),
							),
						),
					)
					.limit(1),
			);
			if (!eligible) return false;

			await queueRun(
				tx,
				{
					agentId: trigger.agentId,
					versionId: trigger.versionId,
					triggerId: trigger.id,
					triggerType: "EVENT",
					idempotencyKey,
					correlationId: `trigger:${trigger.id}:event:${task.id}`,
					input: {
						event: { type: eventType, occurredAt, data },
						record: { kind: recordKind, id: recordId },
					},
				},
				{ eventType, taskId: task.id },
			);
			await tx
				.update(agentTrigger)
				.set({ lastRunAt: occurredAtDate })
				.where(
					and(
						whereEq(agentTrigger.id, trigger.id),
						eq(agentTrigger.enabled, true),
					),
				);
			return true;
		});
		if (queued) matched += 1;
	}

	return matched;
}

export async function pendingAgentRunIds(): Promise<string[]> {
	await recoverAgentRuns();
	const rows = await db
		.select({
			id: agentRun.id,
			agentId: agentRun.agentId,
			versionId: agentRun.versionId,
		})
		.from(agentRun)
		.where(
			and(
				eq(agentRun.status, "QUEUED"),
				inArray(
					agentRun.agentId,
					db
						.select({ id: agentDefinition.id })
						.from(agentDefinition)
						.where(
							and(
								eq(agentDefinition.status, "LIVE"),
								notExists(
									db
										.select({ id: agentRun.agentId })
										.from(agentRun)
										.where(
											and(
												eq(agentRun.agentId, agentDefinition.id),
												inArray(agentRun.status, [
													"RUNNING",
													"WAITING_FOR_APPROVAL",
												]),
											),
										),
								),
							),
						),
				),
			),
		)
		.orderBy(asc(agentRun.createdAt), asc(agentRun.id))
		.limit(RUN_BATCH * 4);

	const runnable: string[] = [];
	const selectedAgents = new Set<string>();
	for (const row of rows) {
		if (selectedAgents.has(row.agentId)) continue;
		const blocked = await runDependencyFailure(row.versionId);
		if (blocked) {
			await failRun(row.id, DEPENDENCY_UNAVAILABLE, blocked).catch(() => {});
			continue;
		}
		selectedAgents.add(row.agentId);
		runnable.push(row.id);
		if (runnable.length === RUN_BATCH) break;
	}

	return runnable;
}

export async function drainAgentRuns(send: SendFn): Promise<number> {
	await queueDueAgentRuns();

	let dispatched = 0;
	for (let pass = 0; pass < DISPATCH.run.maxPasses; pass += 1) {
		const ids = await pendingAgentRunIds();
		if (ids.length === 0) break;

		const outcomes = await Promise.all(
			ids.map((id) =>
				dispatchAgentRun(id, send).then(
					() => true,
					(error) => {
						console.error(
							`[agent] run ${id} could not be dispatched: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
						return false;
					},
				),
			),
		);
		dispatched += outcomes.filter(Boolean).length;
	}

	return dispatched;
}

export async function dispatchAgentRun(runId: string, send: SendFn) {
	const run = await db.query.agentRun
		.findFirst({
			where: whereEq(agentRun.id, runId),
			columns: {
				id: true,
				status: true,
				agentId: true,
				versionId: true,
				initiatedById: true,
			},
			with: {
				agent: { columns: { name: true, createdById: true, status: true } },
				version: { columns: { modelId: true } },
			},
		})
		.then(orNull);
	if (run?.status !== "QUEUED" || run.agent.status !== "LIVE") {
		throw new Error("Agent run was already claimed or is not live.");
	}

	const claim = await db.transaction(async (tx) => {
		const [agent] = await queryRows<{ id: string; status: string }>(
			tx,
			sql`
			SELECT id, status
			FROM "agentDefinition"
			WHERE id = ${run.agentId}
			FOR UPDATE
		`,
		);
		if (agent?.status !== "LIVE") return "unavailable" as const;

		const active = await firstRow(
			tx
				.select({ id: agentRun.id })
				.from(agentRun)
				.where(
					and(
						whereEq(agentRun.agentId, run.agentId),
						ne(agentRun.id, run.id),
						inArray(agentRun.status, ["RUNNING", "WAITING_FOR_APPROVAL"]),
					),
				)
				.limit(1),
		);
		if (active) return "deferred" as const;

		const updated = await tx
			.update(agentRun)
			.set({
				status: "RUNNING",
				startedAt: new Date(),
				modelId: run.version.modelId,
			})
			.where(and(whereEq(agentRun.id, runId), eq(agentRun.status, "QUEUED")));
		return updated.rowCount === 1
			? ("claimed" as const)
			: ("unavailable" as const);
	});
	if (claim === "deferred") {
		throw new Error(
			"This agent already has an active run; this run remains queued.",
		);
	}
	if (claim !== "claimed")
		throw new Error("Agent run was already claimed or is not live.");

	const principalId = run.initiatedById ?? run.agent.createdById;
	try {
		const session = await send(`Execute deployed agent run ${run.id}.`, {
			auth: {
				authenticator: run.initiatedById ? "crm-user" : "crm-schedule",
				principalType: run.initiatedById ? "user" : "runtime",
				principalId,
				attributes: {
					purpose: "team-agent",
					runId: run.id,
					agentId: run.agentId,
					versionId: run.versionId,
					userId: principalId,
				},
			},
			continuationToken: runToken(run.id),
			title: `${run.agent.name} run`,
		});

		await db
			.update(agentRun)
			.set({ sessionId: session.id })
			.where(and(whereEq(agentRun.id, run.id), eq(agentRun.status, "RUNNING")));
		return session;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await failRun(run.id, "DELIVERY_FAILED", message);
		throw error;
	}
}

export async function failRun(runId: string, code: string, message: string) {
	return db.transaction(async (tx) => {
		const run = await lockAgentRun(tx, runId);
		if (run.status === "FAILED") {
			return { id: run.id, status: "FAILED" as const };
		}
		if (run.status === "SUCCEEDED" || run.status === "CANCELLED") {
			return { id: run.id, status: run.status };
		}

		const sequence = run.nextEventSequence + 1;
		const finishedAt = new Date();
		await requireRow(
			tx
				.update(agentRun)
				.set({
					status: "FAILED",
					errorCode: code,
					errorMessage: message,
					finishedAt,
					nextEventSequence: sequence,
				})
				.where(whereEq(agentRun.id, runId))
				.returning(),
		);
		await requireRow(
			tx
				.insert(agentRunEvent)
				.values({
					id: runTerminalEventId(run.id, "failed"),
					runId: run.id,
					sequence,
					type: "run.failed",
					data: { code, message },
					emittedAt: finishedAt,
				})
				.returning(),
		);
		await requireRow(
			tx
				.insert(agentAuditEvent)
				.values({
					agentId: run.agentId,
					versionId: run.versionId,
					actorType: "AGENT",
					actorId: run.id,
					type: "run.failed",
					summary: message,
					requestId: run.id,
				})
				.onConflictDoUpdate({
					target: [
						agentAuditEvent.agentId,
						agentAuditEvent.type,
						agentAuditEvent.requestId,
					],
					set: { agentId: sql`excluded.${sql.identifier("agentId")}` },
				})
				.returning(),
		);

		return { id: run.id, status: "FAILED" as const };
	});
}

export async function cancelRun(runId: string, code: string, message: string) {
	return db.transaction(async (tx) => {
		const run = await lockAgentRun(tx, runId);
		if (isTerminalRunStatus(run.status)) {
			return { id: run.id, status: run.status, settled: false };
		}

		const sequence = run.nextEventSequence + 1;
		const finishedAt = new Date();
		await requireRow(
			tx
				.update(agentRun)
				.set({
					status: "CANCELLED",
					errorCode: code,
					errorMessage: message,
					finishedAt,
					nextEventSequence: sequence,
				})
				.where(whereEq(agentRun.id, runId))
				.returning(),
		);
		await tx
			.update(agentAction)
			.set({
				status: "CANCELLED",
				errorCode: code,
				errorMessage: message,
				completedAt: finishedAt,
			})
			.where(
				and(
					whereEq(agentAction.runId, run.id),
					inArray(agentAction.status, ["PLANNED", "RUNNING"]),
				),
			);
		await requireRow(
			tx
				.insert(agentRunEvent)
				.values({
					id: runTerminalEventId(run.id, "cancelled"),
					runId: run.id,
					sequence,
					type: "run.cancelled",
					data: { code, message },
					emittedAt: finishedAt,
				})
				.returning(),
		);
		await requireRow(
			tx
				.insert(agentAuditEvent)
				.values({
					agentId: run.agentId,
					versionId: run.versionId,
					actorType: "AGENT",
					actorId: run.id,
					type: "run.cancelled",
					summary: message,
					requestId: run.id,
				})
				.onConflictDoUpdate({
					target: [
						agentAuditEvent.agentId,
						agentAuditEvent.type,
						agentAuditEvent.requestId,
					],
					set: { agentId: sql`excluded.${sql.identifier("agentId")}` },
				})
				.returning(),
		);

		return { id: run.id, status: "CANCELLED" as const, settled: true };
	});
}

export function builderToken(conversationId: string): string {
	return `builder:${conversationId}`;
}

export function builderIdFromToken(token: string | undefined): string | null {
	return idFromToken(token, "builder:");
}

export function runToken(runId: string): string {
	return `run:${runId}`;
}

export function runIdFromToken(token: string | undefined): string | null {
	return idFromToken(token, "run:");
}

async function recoverBuilderSubmissions() {
	const stale = new Date(Date.now() - BUILDER_LEASE_MS);
	const rows = await db
		.select({
			id: agentConversationSubmission.id,
			conversationId: agentConversationSubmission.conversationId,
			attemptCount: agentConversationSubmission.attemptCount,
		})
		.from(agentConversationSubmission)
		.where(
			and(
				eq(agentConversationSubmission.status, "SENDING"),
				lt(agentConversationSubmission.sentAt, stale),
			),
		)
		.orderBy(
			asc(agentConversationSubmission.sentAt),
			asc(agentConversationSubmission.id),
		)
		.limit(BUILDER_BATCH * 3);

	for (const row of rows) {
		await db.transaction(async (tx) => {
			const conversation = await lockBuilderConversation(
				tx,
				row.conversationId,
			);
			if (conversation?.kind !== "BUILDER") return;
			const claimed = await tx
				.update(agentConversationSubmission)
				.set(
					row.attemptCount < MAX_BUILDER_ATTEMPTS
						? { status: "PENDING" }
						: {
								status: "FAILED",
								errorCode: "DELIVERY_EXHAUSTED",
								errorMessage:
									"The builder could not accept this message after three attempts.",
							},
				)
				.where(
					and(
						whereEq(agentConversationSubmission.id, row.id),
						eq(agentConversationSubmission.status, "SENDING"),
						lt(agentConversationSubmission.sentAt, stale),
					),
				);
			if (claimed.rowCount === 0) return;

			await tx
				.update(agentConversation)
				.set({ continuationToken: builderToken(row.conversationId) })
				.where(
					and(
						whereEq(agentConversation.id, row.conversationId),
						eq(agentConversation.kind, "BUILDER"),
					),
				);
		});
	}
}

export type LockedBuilderConversation = {
	id: string;
	kind: string;
	sessionId: string | null;
	continuationToken: string | null;
	streamIndex: number;
};

export async function lockBuilderConversation(
	tx: Executor,
	conversationId: string,
): Promise<LockedBuilderConversation | null> {
	const [conversation] = await queryRows<LockedBuilderConversation>(
		tx,
		sql`
		SELECT id, kind, "sessionId", "continuationToken", "streamIndex"
		FROM "agentConversation"
		WHERE id = ${conversationId}
		FOR UPDATE
	`,
	);
	return conversation ?? null;
}

export const RUN_TIMED_OUT = "RUN_TIMED_OUT";

async function timeOutOverrunningRuns() {
	const overrun = new Date(Date.now() - DISPATCH.run.executionTimeoutMs);
	const rows = await db
		.select({ id: agentRun.id })
		.from(agentRun)
		.where(
			and(
				eq(agentRun.status, "RUNNING"),
				isNotNull(agentRun.sessionId),
				lt(agentRun.startedAt, overrun),
			),
		)
		.orderBy(asc(agentRun.startedAt), asc(agentRun.id))
		.limit(RUN_BATCH * 3);

	const minutes = Math.round(DISPATCH.run.executionTimeoutMs / 60_000);
	for (const row of rows) {
		await failRun(
			row.id,
			RUN_TIMED_OUT,
			`This run passed ${minutes} minutes without finishing and was stopped.`,
		).catch(() => {});
	}
}

async function recoverAgentRuns() {
	await timeOutOverrunningRuns();

	const stale = new Date(Date.now() - RUN_DELIVERY_LEASE_MS);
	const rows = await db
		.select({ id: agentRun.id, agentId: agentRun.agentId })
		.from(agentRun)
		.where(
			and(
				eq(agentRun.status, "RUNNING"),
				isNull(agentRun.sessionId),
				lt(agentRun.startedAt, stale),
			),
		)
		.orderBy(asc(agentRun.startedAt), asc(agentRun.id))
		.limit(RUN_BATCH * 3);

	for (const row of rows) {
		await db.transaction(async (tx) => {
			const [agent] = await queryRows<{ status: string }>(
				tx,
				sql`
				SELECT status
				FROM "agentDefinition"
				WHERE id = ${row.agentId}
				FOR UPDATE
			`,
			);
			const run = await lockAgentRun(tx, row.id);
			if (
				run.status !== "RUNNING" ||
				run.sessionId !== null ||
				!run.startedAt ||
				run.startedAt >= stale
			) {
				return;
			}

			const sequence = run.nextEventSequence + 1;
			const cancelled = agent?.status !== "LIVE" && agent?.status !== "PAUSED";
			await requireRow(
				tx
					.update(agentRun)
					.set(
						cancelled
							? {
									status: "CANCELLED",
									errorCode: "AGENT_UNAVAILABLE",
									errorMessage:
										"The agent was unavailable when delivery recovery ran.",
									finishedAt: new Date(),
									nextEventSequence: sequence,
								}
							: {
									status: "QUEUED",
									startedAt: null,
									errorCode: null,
									errorMessage: null,
									finishedAt: null,
									nextEventSequence: sequence,
								},
					)
					.where(whereEq(agentRun.id, run.id))
					.returning(),
			);
			await requireRow(
				tx
					.insert(agentRunEvent)
					.values({
						id: `run-delivery-${cancelled ? "cancelled" : "recovered"}:${run.id}:${run.startedAt.toISOString()}`,
						runId: run.id,
						sequence,
						type: cancelled ? "run.cancelled" : "run.delivery_recovered",
						data: cancelled ? { reason: "agent.unavailable" } : {},
					})
					.returning(),
			);
		});
	}
}

export function builderDeliveryMessage(
	submissionId: string,
	value: JsonValue,
	attachments: readonly BuilderDeliveryAttachment[] = [],
): Parameters<SendFn>[0] {
	const message = builderSubmissionMessage.parse(value);
	const { requestId, optionId, text: responseText } = message.inputResponse;
	if (requestId && (optionId || responseText)) {
		return {
			inputResponses: [
				{
					requestId,
					...(optionId ? { optionId } : { text: responseText }),
				},
			],
		};
	}

	const labels = message.resources
		.map((resource) => resource.label)
		.filter(Boolean);
	const context = [
		`Submission id: ${submissionId}`,
		message.resources.length > 0
			? `Tagged resources: ${labels.join(", ")}`
			: null,
	]
		.filter(Boolean)
		.join("\n");
	const parts: BuilderMessageParts = [
		{ type: "text", text: `${context}\n\n${message.text}` },
	];

	for (const attachment of attachments) {
		parts.push({
			type: "file",
			data: attachment.content,
			mediaType: attachment.mediaType,
			filename: attachment.name,
		});
	}

	return parts;
}

export function builderCommandType(
	commandType: string,
	value: JsonValue,
): string {
	const { requestId, optionId, text } =
		builderSubmissionMessage.parse(value).inputResponse;
	return requestId && (optionId || text) ? "CREATE_AGENT" : commandType;
}

type BuilderDeliveryAttachment = {
	name: string;
	mediaType: string;
	content: Uint8Array;
};

function advance(from: Date, intervalMinutes: number, now: Date): Date {
	const intervalMs = intervalMinutes * 60_000;
	const missed = Math.max(
		1,
		Math.floor((now.getTime() - from.getTime()) / intervalMs) + 1,
	);
	return new Date(from.getTime() + missed * intervalMs);
}

function idFromToken(token: string | undefined, marker: string): string | null {
	if (!token) return null;
	const index = token.lastIndexOf(marker);
	if (index === -1) return null;
	const id = token.slice(index + marker.length);
	return id || null;
}

function permissionModeAttribute(mode: string): string {
	if (mode === "AUTO") return "auto";
	if (mode === "BYPASS") return "bypass";
	return "manual";
}

async function queueRun(
	tx: Executor,
	run: NewAgentRun,
	data: JsonObject,
): Promise<void> {
	const [created] = await tx
		.insert(agentRun)
		.values(run)
		.onConflictDoNothing({ target: agentRun.idempotencyKey })
		.returning({ id: agentRun.id });
	if (!created) return;
	await tx
		.insert(agentRunEvent)
		.values({ runId: created.id, sequence: 0, type: "run.queued", data });
}
