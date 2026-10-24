import {
	agentAction,
	agentConversation,
	agentConversationSubmission,
	agentEvent,
	agentRun,
	agentRunEvent,
	and,
	Decimal,
	db,
	type Executor,
	eq,
	firstRow,
	hasValues,
	isNull,
	type JsonObject,
	mcpConnection,
	not,
	requireRow,
	sql,
	startsWith,
	whereEq,
} from "@crm/db";
import { WORKSPACE_ID } from "@crm/db/workspace";
import { publicEveEventData } from "@crm/validation/eve-public-event";
import { defineHook } from "eve/hooks";
import { z } from "zod";
import { prepareBuilderEventForStorage } from "../lib/builder-event-storage";
import { BUILDER_INPUT_EVENT_PREFIX } from "../lib/builder-input";
import { lockBuilderConversation } from "../lib/custom-agent-dispatch";
import { currentFocus } from "../lib/focus";
import { capMcpArchivedResult, mcpActionResultEvent } from "../lib/mcp-runtime";
import { lockAgentRun } from "../lib/run-state";
import { attribute, purposeOf } from "../lib/session-purpose";

const finiteNumber = z.number().refine(Number.isFinite).nullable().catch(null);

const stepUsage = z
	.object({
		usage: z
			.object({
				inputTokens: finiteNumber,
				outputTokens: finiteNumber,
				costUsd: finiteNumber,
			})
			.catch({ inputTokens: null, outputTokens: null, costUsd: null }),
	})
	.catch({ usage: { inputTokens: null, outputTokens: null, costUsd: null } });

const completedMessage = z
	.object({ message: z.string().nullable().catch(null) })
	.catch({ message: null });

export default defineHook({
	events: {
		async "*"(event, ctx) {
			const id = event.meta?.id;

			if (!id) return;

			try {
				const archivedData = capMcpArchivedResult(
					event.type,
					("data" in event ? (event.data ?? {}) : {}) as JsonObject,
				);
				const emittedAt = event.meta?.at ? new Date(event.meta.at) : new Date();
				const purpose = purposeOf(ctx);
				const conversationId =
					purpose === "builder" ? attribute(ctx, "conversationId") : null;
				const storedEvent =
					purpose === "builder" && conversationId
						? prepareBuilderEventForStorage(event.type, archivedData, {
								conversationId,
								eventId: id,
							})
						: {
								...publicEveEventData(event.type, archivedData),
								encryptedData: null,
							};
				await db.transaction(async (tx) => {
					const existing = await firstRow(
						tx
							.select({ id: agentEvent.id })
							.from(agentEvent)
							.where(whereEq(agentEvent.id, id))
							.limit(1),
					);
					if (existing) return;

					const streamIndex =
						purpose === "builder" && conversationId && isRootSession(ctx)
							? await reserveBuilderStreamIndex(
									tx,
									conversationId,
									ctx.session.id,
									event.type,
								)
							: null;

					await requireRow(
						tx
							.insert(agentEvent)
							.values({
								id,
								sessionId: ctx.session.id,
								streamIndex,
								deliveryIds: [...(event.meta?.deliveryIds ?? [])],
								contactId: currentFocus().contactId,
								conversationId,
								type: storedEvent.type,
								data: storedEvent.data,
								encryptedData: storedEvent.encryptedData,
								emittedAt,
							})
							.returning(),
					);

					if (purpose === "builder") {
						await persistBuilderLifecycle(tx, event, ctx.session.id, ctx);
					}
					if (purpose === "team-agent") {
						await persistRunEvent(
							tx,
							id,
							event.type,
							archivedData,
							emittedAt,
							ctx,
						);
					}
				});
			} catch (error) {
				console.warn("[audit] could not record event", {
					type: event.type,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		},
	},
});

async function reserveBuilderStreamIndex(
	tx: Executor,
	conversationId: string,
	sessionId: string,
	eventType: string,
): Promise<number | null> {
	const conversation = await lockBuilderConversation(tx, conversationId);
	if (conversation?.kind !== "BUILDER") return null;
	if (
		conversation.sessionId !== sessionId &&
		!(conversation.sessionId === null && eventType === "session.started")
	) {
		return null;
	}
	if (conversation.sessionId === sessionId) {
		const legacyEvents = await tx.$count(
			agentEvent,
			and(
				whereEq(agentEvent.conversationId, conversationId),
				whereEq(agentEvent.sessionId, sessionId),
				isNull(agentEvent.streamIndex),
				not(startsWith(agentEvent.id, BUILDER_INPUT_EVENT_PREFIX)),
			),
		);
		if (legacyEvents > 0) return null;
	}

	const streamIndex = conversation.streamIndex;
	await requireRow(
		tx
			.update(agentConversation)
			.set({
				sessionId:
					conversation.sessionId === null && eventType === "session.started"
						? sessionId
						: undefined,
				streamIndex: sql`${agentConversation.streamIndex} + 1`,
			})
			.where(whereEq(agentConversation.id, conversationId))
			.returning(),
	);
	return streamIndex;
}

async function persistBuilderLifecycle(
	tx: Executor,
	event: { type: string },
	sessionId: string,
	ctx: Parameters<typeof purposeOf>[0],
) {
	const conversationId = attribute(ctx, "conversationId");
	if (!conversationId) return;

	if (event.type === "session.started" && isRootSession(ctx)) {
		await tx
			.update(agentConversation)
			.set({ sessionId, continuationToken: null })
			.where(
				and(
					whereEq(agentConversation.id, conversationId),
					eq(agentConversation.kind, "BUILDER"),
				),
			);
	}

	if (event.type === "message.received") {
		const submissionId = attribute(ctx, "submissionId");
		if (submissionId) {
			await tx
				.update(agentConversationSubmission)
				.set({ status: "ACCEPTED", acceptedAt: new Date() })
				.where(
					and(
						whereEq(agentConversationSubmission.id, submissionId),
						whereEq(agentConversationSubmission.conversationId, conversationId),
					),
				);
		}
	}
}

async function persistRunEvent(
	tx: Executor,
	eventId: string,
	type: string,
	data: JsonObject,
	emittedAt: Date,
	ctx: Parameters<typeof purposeOf>[0] & { session: { id: string } },
) {
	const runId = attribute(ctx, "runId");
	if (!runId) return;

	const run = await lockAgentRun(tx, runId);
	if (
		run.status === "SUCCEEDED" ||
		run.status === "FAILED" ||
		run.status === "CANCELLED"
	) {
		return;
	}
	const existing = await firstRow(
		tx
			.select({ id: agentRunEvent.id })
			.from(agentRunEvent)
			.where(whereEq(agentRunEvent.id, eventId))
			.limit(1),
	);
	if (existing) return;

	const sequence = run.nextEventSequence + 1;
	const mayStart =
		type === "session.started" &&
		isRootSession(ctx) &&
		(run.status === "QUEUED" || run.status === "RUNNING");
	await requireRow(
		tx
			.update(agentRun)
			.set({
				nextEventSequence: sequence,
				sessionId: mayStart ? ctx.session.id : undefined,
				status: mayStart ? "RUNNING" : undefined,
				startedAt: mayStart ? (run.startedAt ?? new Date()) : undefined,
			})
			.where(whereEq(agentRun.id, run.id))
			.returning(),
	);

	await requireRow(
		tx
			.insert(agentRunEvent)
			.values({
				id: eventId,
				runId,
				sequence,
				type,
				data,
				emittedAt,
			})
			.returning(),
	);
	if (type === "action.result") {
		await persistMcpActionResult(tx, runId, data, emittedAt);
	}

	if (type === "step.completed") {
		const { inputTokens, outputTokens, costUsd } = stepUsage.parse(data).usage;
		const current = await requireRow(
			tx
				.select({
					inputTokens: agentRun.inputTokens,
					outputTokens: agentRun.outputTokens,
					costUsd: agentRun.costUsd,
				})
				.from(agentRun)
				.where(whereEq(agentRun.id, runId))
				.limit(1),
		);
		const usage = {
			inputTokens:
				inputTokens === null
					? undefined
					: (current.inputTokens ?? 0) + inputTokens,
			outputTokens:
				outputTokens === null
					? undefined
					: (current.outputTokens ?? 0) + outputTokens,
			costUsd:
				costUsd === null
					? undefined
					: new Decimal(current.costUsd ?? 0).plus(costUsd),
		};
		if (hasValues(usage)) {
			await tx.update(agentRun).set(usage).where(whereEq(agentRun.id, runId));
		}
	}

	if (type === "message.completed") {
		const { message } = completedMessage.parse(data);
		if (message?.trim()) {
			await tx
				.update(agentRun)
				.set({ summary: message.slice(0, 1000) })
				.where(
					and(whereEq(agentRun.id, runId), eq(agentRun.status, "RUNNING")),
				);
		}
	}
}

async function persistMcpActionResult(
	tx: Executor,
	runId: string,
	data: JsonObject,
	emittedAt: Date,
): Promise<void> {
	const parsed = mcpActionResultEvent.safeParse(data);
	if (!parsed.success) return;
	const separator = parsed.data.result.toolName.indexOf("__");
	if (separator <= 0) return;
	const platformSlug = parsed.data.result.toolName.slice(0, separator);
	const success = parsed.data.status === "completed";
	const updated = await tx
		.update(agentAction)
		.set({
			status: success ? "SUCCEEDED" : "FAILED",
			errorCode: success ? null : "MCP_CALL_FAILED",
			errorMessage: success
				? null
				: (parsed.data.error?.message ?? "The MCP tool call failed."),
			completedAt: emittedAt,
		})
		.where(
			and(
				whereEq(agentAction.runId, runId),
				whereEq(
					agentAction.idempotencyKey,
					`${runId}:${parsed.data.result.callId}`,
				),
				whereEq(agentAction.provider, platformSlug),
				eq(agentAction.type, "mcp.tool.call"),
				eq(agentAction.status, "RUNNING"),
			),
		);
	if (success && updated.rowCount === 1) {
		await tx
			.update(mcpConnection)
			.set({ lastSuccessfulCallAt: emittedAt, lastErrorCode: null })
			.where(
				and(
					eq(mcpConnection.organizationId, WORKSPACE_ID),
					whereEq(mcpConnection.platformSlug, platformSlug),
				),
			);
	}
}

function isRootSession(ctx: Parameters<typeof purposeOf>[0]): boolean {
	return !("parent" in ctx.session) || !ctx.session.parent;
}
