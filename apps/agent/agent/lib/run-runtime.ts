import { createHash, randomUUID } from "node:crypto";
import {
	ActivityType,
	activity,
	agentAction,
	agentAuditEvent,
	agentRun,
	agentRunEvent,
	agentVersion,
	and,
	company as companyTable,
	contact as contactTable,
	db,
	deal as dealTable,
	desc,
	type Executor,
	eq,
	firstRow,
	inArray,
	isNull,
	type JsonValue,
	lt,
	type NewAgentAction,
	ne,
	or,
	orNull,
	requireRow,
	sql,
	whereEq,
} from "@crm/db";
import type { AgentActionStatus, AgentTriggerType } from "@crm/db/enums";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import {
	AGENT_ACTION_TYPES,
	type AgentManifestResource,
	parseAgentManifest,
} from "@crm/validation/agent-manifest";
import { z } from "zod";
import { readCompanyHistory, readDealHistory } from "./accounts";
import { AGENT_ACTION_EXECUTORS, isAgentActionType } from "./agent-actions";
import { readCrmHistory } from "./crm";
import { DISPATCH } from "./dispatch-config";
import { searchCrm } from "./lookup";
import {
	type LockedAgentRun,
	lockAgentRun,
	runTerminalEventId,
} from "./run-state";
import { slackAccessToken } from "./slack-connection";

const ACTION_LEASE_MS = DISPATCH.run.actionLeaseMs;
const NO_ACTION_TRIGGER_TYPES = new Set<AgentTriggerType>(
	DISPATCH.run.noActionTriggerTypes,
);

type RunRecordScope = "SELECTED" | "WORKSPACE";

const json = z.json();

type Json = z.infer<typeof json>;

const runResult = z.record(z.string(), json);

export type RunResult = z.infer<typeof runResult>;

const storedRunResult = runResult.catch({});

export type SlackRunDestination = {
	kind: "channel" | "user";
	id: string;
	label: string;
};

type RunDataScope = {
	mode: RunRecordScope;
	resources: AgentManifestResource[];
};

export type RunHistorySources = {
	gmail: boolean;
	calendar: boolean;
};

type SlackRequestBody = Record<string, Json>;

type HashableRequest = Record<string, string | boolean | null>;

const optionalText = z.string().nullable().catch(null);

const slackActionMetadata = z
	.object({ clientMessageId: z.string().min(1).nullable().catch(null) })
	.catch({ clientMessageId: null });

const slackEnvelope = z
	.object({ ok: z.boolean().nullable().catch(null), error: optionalText })
	.catch({ ok: null, error: null });

const slackOpenedConversation = z
	.object({
		channel: z
			.object({ id: z.string().min(1).nullable().catch(null) })
			.nullable()
			.catch(null),
	})
	.catch({ channel: null });

const slackPostedMessage = z
	.object({ channel: optionalText, ts: optionalText })
	.catch({ channel: null, ts: null });

const noActionResult = z
	.object({ noActionNeeded: optionalText })
	.catch({ noActionNeeded: null });

type RunActionRow = {
	id: string;
	status: AgentActionStatus;
	externalId: string | null;
	requestHash: string | null;
	metadata: JsonValue;
};

type RunActionClaim =
	| { claimed: false; actionId: string; externalId: string | null }
	| {
			claimed: true;
			actionId: string;
			claimedAt: Date;
			metadata: JsonValue;
	  };

const RUN_ACTION_FIELDS = {
	id: agentAction.id,
	status: agentAction.status,
	externalId: agentAction.externalId,
	requestHash: agentAction.requestHash,
	metadata: agentAction.metadata,
};

export async function approvedRunInstructions(runId: string): Promise<string> {
	const run = await db.query.agentRun
		.findFirst({
			where: whereEq(agentRun.id, runId),
			columns: { status: true },
			with: { version: { columns: { instructions: true } } },
		})
		.then(orNull);

	if (!run) throw new Error("This agent run is unavailable.");
	if (run.status !== "RUNNING") {
		throw new Error("This agent run is not active.");
	}
	return run.version.instructions;
}

export async function runContext(runId: string) {
	const run = await db.query.agentRun
		.findFirst({
			where: whereEq(agentRun.id, runId),
			columns: { id: true, status: true, triggerType: true, input: true },
			with: {
				agent: { columns: { id: true, name: true, description: true } },
				version: {
					columns: {
						id: true,
						number: true,
						manifest: true,
						modelId: true,
						sandboxPolicy: true,
					},
				},
				trigger: {
					columns: { id: true, name: true, type: true, config: true },
				},
			},
		})
		.then(orNull);

	if (!run) throw new Error("This agent run is unavailable.");
	if (run.status !== "RUNNING") {
		throw new Error("This agent run is not active.");
	}

	const dataScope = manifestDataScope(run.version.manifest);
	return {
		...run,
		recordScope: dataScope.mode,
		allowedResources: dataScope.resources,
		allowedActions: manifestActions(run.version.manifest),
		now: new Date().toISOString(),
	};
}

export async function queryRunCrm(
	runId: string,
	input: {
		query: string;
		kinds?: ("contact" | "company" | "deal")[];
		limit: number;
	},
) {
	const run = await runContext(runId);
	const scoped = run.allowedResources.filter(
		(resource) => resource.kind !== "integration",
	);
	const result = await searchCrm(input.query, input);
	if (run.recordScope === "WORKSPACE") return result;

	const allowed = new Set(
		scoped.map((resource) => `${resource.kind}:${resource.id}`),
	);
	const contacts = result.contacts.filter((row) =>
		allowed.has(`contact:${row.id}`),
	);
	const companies = result.companies.filter((row) =>
		allowed.has(`company:${row.id}`),
	);
	const deals = result.deals.filter((row) => allowed.has(`deal:${row.id}`));
	return {
		...result,
		contacts,
		companies,
		deals,
		total: contacts.length + companies.length + deals.length,
	};
}

export async function readRunRecord(
	runId: string,
	input: {
		kind: "contact" | "company" | "deal";
		id: string;
	},
) {
	const run = await runContext(runId);
	assertResourceAllowed(run.recordScope, run.allowedResources, input);
	const sources = allowedHistorySources(run.allowedResources);

	if (input.kind === "contact")
		return readCrmHistory(input.id, {
			threads: 10,
			includeEmail: sources.gmail,
			includeCalendar: sources.calendar,
		});
	if (input.kind === "company") {
		return readCompanyHistory(input.id, {
			threads: 10,
			people: 50,
			includeEmail: sources.gmail,
			includeCalendar: sources.calendar,
		});
	}
	return readDealHistory(input.id, {
		threads: 10,
		includeEmail: sources.gmail,
		includeCalendar: sources.calendar,
	});
}

export async function createRunActivity(
	runId: string,
	callId: string,
	input: {
		type: "NOTE" | "TASK";
		targetKind: "company" | "contact" | "deal";
		targetId: string;
		subject?: string | null;
		body?: string | null;
		dueAt?: string | null;
	},
) {
	const run = await db.query.agentRun
		.findFirst({
			where: whereEq(agentRun.id, runId),
			columns: { id: true, status: true, agentId: true, initiatedById: true },
			with: {
				agent: { columns: { createdById: true } },
				version: { columns: { manifest: true } },
			},
		})
		.then(orNull);
	if (!run) throw new Error("This agent run is unavailable.");

	assertActivityAllowed(run.version.manifest, input.type);
	const dataScope = manifestDataScope(run.version.manifest);
	assertResourceAllowed(dataScope.mode, dataScope.resources, {
		kind: input.targetKind,
		id: input.targetId,
	});
	const idempotencyKey = `${runId}:${callId}`;
	const requestHash = actionRequestHash(input);
	const existing = await findRunAction(idempotencyKey, requestHash);
	if (existing?.status === "SUCCEEDED") {
		return {
			actionId: existing.id,
			activityId: existing.externalId,
			replayed: true,
		};
	}
	if (run.status !== "RUNNING") {
		throw new Error("This agent run is not active.");
	}
	if (input.type === "TASK" && !input.subject?.trim()) {
		throw new Error("A CRM task needs a subject.");
	}
	if (input.type === "NOTE" && !input.subject?.trim() && !input.body?.trim()) {
		throw new Error("A CRM note needs a subject or body.");
	}
	const dueAt = input.dueAt ? new Date(input.dueAt) : null;
	if (dueAt && Number.isNaN(dueAt.getTime())) {
		throw new Error("The due date is invalid.");
	}
	const target = await targetRecord(input.targetKind, input.targetId);
	if (!target) throw new Error("The requested CRM target no longer exists.");

	const claim = await claimRunAction(existing, idempotencyKey, requestHash, {
		agentId: run.agentId,
		runId,
		type: "crm.activity.create",
		provider: "crm",
		targetType: input.targetKind,
		targetId: input.targetId,
		targetLabel: target.label,
		summary:
			input.subject?.trim() ||
			`Create a ${input.type.toLowerCase()} on ${target.label}`,
		metadata: { activityType: input.type },
	});
	if (!claim.claimed) {
		return {
			actionId: claim.actionId,
			activityId: claim.externalId,
			replayed: true,
		};
	}

	try {
		const activityId = `agent-action-${claim.actionId}`;
		const now = new Date();

		await db.transaction(async (tx) => {
			const activeRun = await lockAgentRun(tx, runId);
			if (activeRun.status !== "RUNNING") {
				throw new Error("This agent run is not active.");
			}
			await requireRow(
				tx
					.insert(activity)
					.values({
						id: activityId,
						type: input.type === "TASK" ? ActivityType.TASK : ActivityType.NOTE,
						subject: input.subject?.trim() || null,
						body: input.body?.trim() || null,
						occurredAt: now,
						dueAt: input.type === "TASK" ? dueAt : null,
						companyId: target.companyId,
						contactId: target.contactId,
						dealId: target.dealId,
						createdById: run.initiatedById ?? run.agent.createdById,
						meta: {
							source: "agent",
							agentId: run.agentId,
							runId,
							actionId: claim.actionId,
						},
					})
					.onConflictDoUpdate({
						target: activity.id,
						set: { id: sql`excluded.${sql.identifier("id")}` },
					})
					.returning(),
			);

			if (target.companyId) {
				await requireRow(
					tx
						.update(companyTable)
						.set({ lastActivityAt: now })
						.where(whereEq(companyTable.id, target.companyId))
						.returning(),
				);
			}
			if (target.contactId) {
				await requireRow(
					tx
						.update(contactTable)
						.set({ lastActivityAt: now })
						.where(whereEq(contactTable.id, target.contactId))
						.returning(),
				);
			}
			if (target.dealId) {
				await requireRow(
					tx
						.update(dealTable)
						.set({ lastActivityAt: now })
						.where(whereEq(dealTable.id, target.dealId))
						.returning(),
				);
			}

			await requireRow(
				tx
					.update(agentAction)
					.set({
						status: "SUCCEEDED",
						externalId: activityId,
						completedAt: now,
					})
					.where(whereEq(agentAction.id, claim.actionId))
					.returning(),
			);
		});

		return { actionId: claim.actionId, activityId, replayed: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await failRunAction(claim, "ACTION_REJECTED", message);
		throw error;
	}
}

export async function postRunSlackMessage(
	runId: string,
	callId: string,
	input: { text: string },
	abortSignal?: AbortSignal,
) {
	const run = await db.query.agentRun
		.findFirst({
			where: whereEq(agentRun.id, runId),
			columns: { id: true, status: true, agentId: true },
			with: { version: { columns: { manifest: true } } },
		})
		.then(orNull);
	if (!run) throw new Error("This agent run is unavailable.");

	const destination = approvedSlackDestination(run.version.manifest);
	const text = input.text.trim();
	if (!text) throw new Error("A Slack message needs text.");
	const idempotencyKey = `${runId}:${callId}`;
	const requestHash = hashRequest({ destinationId: destination.id, text });
	const existing = await findRunAction(idempotencyKey, requestHash);
	if (existing?.status === "SUCCEEDED") {
		return {
			actionId: existing.id,
			messageId: existing.externalId,
			destination: destination.label,
			replayed: true,
		};
	}
	if (run.status !== "RUNNING") {
		throw new Error("This agent run is not active.");
	}

	const claim = await claimRunAction(existing, idempotencyKey, requestHash, {
		agentId: run.agentId,
		runId,
		type: "slack.message.post",
		provider: "slack",
		targetType: destination.kind,
		targetId: destination.id,
		targetLabel: destination.label,
		summary: `Post a message to ${destination.label}`,
		metadata: { clientMessageId: randomUUID() },
	});
	if (!claim.claimed) {
		return {
			actionId: claim.actionId,
			messageId: claim.externalId,
			destination: destination.label,
			replayed: true,
		};
	}

	const { actionId, claimedAt } = claim;
	try {
		await assertRunActive(runId);
		const { clientMessageId } = slackActionMetadata.parse(claim.metadata);
		if (!clientMessageId) {
			throw new Error("This Slack action is missing its replay key.");
		}
		const accessToken = await slackAccessToken();
		if (!accessToken) throw new Error("Slack is not connected.");

		const posted = await sendSlackMessage(
			accessToken,
			destination,
			text,
			clientMessageId,
			{
				abortSignal,
				beforePost: () => holdRunActionClaim(runId, actionId, claimedAt),
			},
		);
		const messageId = `${posted.channel}:${posted.ts}`;
		const completed = await db
			.update(agentAction)
			.set({
				status: "SUCCEEDED",
				externalId: messageId,
				completedAt: new Date(),
			})
			.where(
				and(
					whereEq(agentAction.id, actionId),
					eq(agentAction.status, "RUNNING"),
					whereEq(agentAction.startedAt, claimedAt),
				),
			);
		if (completed.rowCount === 0) {
			await recordDeliveryOutsideClaim(actionId, messageId);
			throw new Error(
				"This agent run stopped while Slack was accepting the message.",
			);
		}

		return {
			actionId,
			messageId,
			destination: destination.label,
			replayed: false,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await failRunAction(claim, slackActionErrorCode(message), message);
		throw error;
	}
}

async function findRunAction(
	idempotencyKey: string,
	requestHash: string,
): Promise<RunActionRow | null> {
	const existing = await firstRow(
		db
			.select(RUN_ACTION_FIELDS)
			.from(agentAction)
			.where(eq(agentAction.idempotencyKey, idempotencyKey))
			.limit(1),
	);
	if (existing) assertActionRequestMatches(existing.requestHash, requestHash);
	return existing;
}

async function claimRunAction(
	existing: RunActionRow | null,
	idempotencyKey: string,
	requestHash: string,
	data: Omit<NewAgentAction, "idempotencyKey" | "requestHash">,
): Promise<RunActionClaim> {
	const action =
		existing ??
		(await db.transaction(async (tx) => {
			await lockIdempotencyKey(tx, idempotencyKey);
			const winner = await firstRow(
				tx
					.select(RUN_ACTION_FIELDS)
					.from(agentAction)
					.where(eq(agentAction.idempotencyKey, idempotencyKey))
					.limit(1),
			);
			if (winner) {
				assertActionRequestMatches(winner.requestHash, requestHash);
				return winner;
			}

			return requireRow(
				tx
					.insert(agentAction)
					.values({ ...data, idempotencyKey, requestHash })
					.returning(RUN_ACTION_FIELDS),
			);
		}));
	if (action.status === "SUCCEEDED") {
		return {
			claimed: false,
			actionId: action.id,
			externalId: action.externalId,
		};
	}

	const claimedAt = new Date();
	const claimed = await db
		.update(agentAction)
		.set({
			status: "RUNNING",
			startedAt: claimedAt,
			completedAt: null,
			attemptCount: sql`${agentAction.attemptCount} + 1`,
			errorCode: null,
			errorMessage: null,
		})
		.where(
			and(
				whereEq(agentAction.id, action.id),
				or(
					inArray(agentAction.status, ["PLANNED", "FAILED"]),
					and(
						eq(agentAction.status, "RUNNING"),
						lt(
							agentAction.startedAt,
							new Date(claimedAt.getTime() - ACTION_LEASE_MS),
						),
					),
				),
			),
		);
	if (claimed.rowCount === 0) {
		const current = await firstRow(
			db
				.select({
					status: agentAction.status,
					externalId: agentAction.externalId,
				})
				.from(agentAction)
				.where(whereEq(agentAction.id, action.id))
				.limit(1),
		);
		if (current?.status === "SUCCEEDED") {
			return {
				claimed: false,
				actionId: action.id,
				externalId: current.externalId,
			};
		}
		throw new Error("This agent action is already in progress.");
	}

	return {
		claimed: true,
		actionId: action.id,
		claimedAt,
		metadata: action.metadata,
	};
}

async function failRunAction(
	claim: Extract<RunActionClaim, { claimed: true }>,
	code: string,
	message: string,
): Promise<void> {
	await db
		.update(agentAction)
		.set({
			status: "FAILED",
			errorCode: code,
			errorMessage: message,
			completedAt: new Date(),
		})
		.where(
			and(
				whereEq(agentAction.id, claim.actionId),
				eq(agentAction.status, "RUNNING"),
				whereEq(agentAction.startedAt, claim.claimedAt),
			),
		);
}

export async function sendSlackMessage(
	accessToken: string,
	destination: SlackRunDestination,
	text: string,
	clientMessageId: string,
	options: {
		fetcher?: typeof fetch;
		abortSignal?: AbortSignal;
		beforePost?: () => Promise<void>;
	} = {},
): Promise<{ channel: string; ts: string }> {
	const { fetcher = fetch, abortSignal, beforePost } = options;
	let channel = destination.id;
	if (destination.kind === "user") {
		const opened = slackOpenedConversation.parse(
			await slackApiRequest(
				fetcher,
				accessToken,
				"conversations.open",
				{ users: destination.id, return_im: true },
				abortSignal,
			),
		);
		if (!opened.channel?.id) {
			throw new Error("Slack did not return a direct-message channel.");
		}
		channel = opened.channel.id;
	}
	await beforePost?.();

	const posted = slackPostedMessage.parse(
		await slackApiRequest(
			fetcher,
			accessToken,
			"chat.postMessage",
			{
				channel,
				text,
				client_msg_id: clientMessageId,
			},
			abortSignal,
		),
	);
	if (posted.channel === null || posted.ts === null) {
		throw new Error("Slack returned an incomplete message receipt.");
	}

	return { channel: posted.channel, ts: posted.ts };
}

async function assertRunActive(runId: string): Promise<void> {
	const run = await firstRow(
		db
			.select({ status: agentRun.status })
			.from(agentRun)
			.where(whereEq(agentRun.id, runId))
			.limit(1),
	);
	if (run?.status !== "RUNNING") {
		throw new Error("This agent run is not active.");
	}
}

async function holdRunActionClaim(
	runId: string,
	actionId: string,
	claimedAt: Date,
): Promise<void> {
	await db.transaction(async (tx) => {
		const run = await lockAgentRun(tx, runId);
		if (run.status !== "RUNNING") {
			throw new Error("This agent run is not active.");
		}
		const held = await tx.$count(
			agentAction,
			and(
				whereEq(agentAction.id, actionId),
				eq(agentAction.status, "RUNNING"),
				whereEq(agentAction.startedAt, claimedAt),
			),
		);
		if (held === 0) {
			throw new Error("This agent action is no longer held by this run.");
		}
	});
}

async function recordDeliveryOutsideClaim(
	actionId: string,
	messageId: string,
): Promise<void> {
	const delivered =
		"Slack accepted this message before the run stopped, and it cannot be withdrawn.";
	const current = await firstRow(
		db
			.select({
				status: agentAction.status,
				externalId: agentAction.externalId,
				errorMessage: agentAction.errorMessage,
			})
			.from(agentAction)
			.where(whereEq(agentAction.id, actionId))
			.limit(1),
	);
	if (!current || current.status === "SUCCEEDED" || current.externalId) return;

	await db
		.update(agentAction)
		.set({
			externalId: messageId,
			errorMessage: current.errorMessage
				? `${current.errorMessage} ${delivered}`
				: delivered,
		})
		.where(
			and(
				whereEq(agentAction.id, actionId),
				ne(agentAction.status, "SUCCEEDED"),
				isNull(agentAction.externalId),
			),
		);
}

async function slackApiRequest(
	fetcher: typeof fetch,
	accessToken: string,
	method: string,
	body: SlackRequestBody,
	abortSignal?: AbortSignal,
): Promise<Json> {
	const response = await fetcher(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json; charset=utf-8",
		},
		body: JSON.stringify(body),
		signal: abortSignal,
	});
	if (!response.ok) throw new Error("Slack message delivery failed.");

	const data = json.catch(null).parse(await response.json());
	const envelope = slackEnvelope.parse(data);
	if (envelope.ok !== true) {
		const reason = envelope.error ?? "rejected";
		if (reason === "not_in_channel") {
			throw new Error(
				"The Slack bot is not in the selected channel. Invite the app to that channel and retry the run.",
			);
		}
		if (reason === "missing_scope") {
			throw new Error(
				"Slack needs an additional permission. Reconnect Slack, then retry the run.",
			);
		}
		throw new Error(`Slack rejected the message (${reason}).`);
	}
	return data;
}

function slackActionErrorCode(message: string): string {
	return message === "Slack is not connected." ||
		message.includes("additional permission")
		? "NOT_AUTHORISED"
		: "PROVIDER_ERROR";
}

export async function stageRunResult(
	runId: string,
	input: {
		summary: string;
		result?: RunResult | null;
		noActionNeeded?: { reason: string } | null;
	},
) {
	return db.transaction(async (tx) => {
		const run = await lockAgentRun(tx, runId);
		if (run.status !== "RUNNING") {
			throw new Error(`This agent run already ended with ${run.status}.`);
		}
		if (input.noActionNeeded) {
			const refusal = await noActionNeededRefusal(tx, run);
			if (refusal) throw new Error(refusal);
		}

		const result: RunResult = { ...(input.result ?? {}) };
		if (input.noActionNeeded) {
			result.noActionNeeded = input.noActionNeeded.reason;
		}

		await requireRow(
			tx
				.update(agentRun)
				.set({
					summary: input.summary,
					result: result as JsonValue,
				})
				.where(whereEq(agentRun.id, runId))
				.returning(),
		);

		return { id: run.id, status: "RUNNING" as const };
	});
}

export function runResultOf(value: JsonValue): RunResult {
	return storedRunResult.parse(value);
}

export function runReportedNoActionNeeded(
	result: RunResult | null | undefined,
): boolean {
	return noActionResult.parse(result).noActionNeeded !== null;
}

export async function finishRun(
	runId: string,
	input: { summary: string; result?: RunResult | null },
) {
	return db.transaction(async (tx) => {
		const run = await lockAgentRun(tx, runId);
		if (run.status === "SUCCEEDED") {
			return { id: run.id, status: "SUCCEEDED" as const };
		}
		if (run.status !== "RUNNING") {
			throw new Error(`This agent run already ended with ${run.status}.`);
		}
		const noActionAccepted =
			runReportedNoActionNeeded(input.result) &&
			(await noActionNeededRefusal(tx, run)) === null;
		const actionFailure = noActionAccepted
			? null
			: await requiredActionFailure(tx, run);
		if (actionFailure) {
			return failLockedRun(tx, run, actionFailure.code, actionFailure.message);
		}

		const sequence = run.nextEventSequence + 1;
		const finishedAt = new Date();
		await requireRow(
			tx
				.update(agentRun)
				.set({
					status: "SUCCEEDED",
					summary: input.summary,
					result: (input.result ?? {}) as JsonValue,
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
					id: runTerminalEventId(run.id, "completed"),
					runId: run.id,
					sequence,
					type: "run.completed",
					data: { summary: input.summary },
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
					type: "run.completed",
					summary: input.summary,
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

		return { id: run.id, status: "SUCCEEDED" as const };
	});
}

async function noActionNeededRefusal(
	tx: Executor,
	run: LockedAgentRun,
): Promise<string | null> {
	const { triggerType } = await requireRow(
		tx
			.select({ triggerType: agentRun.triggerType })
			.from(agentRun)
			.where(whereEq(agentRun.id, run.id))
			.limit(1),
	);
	if (NO_ACTION_TRIGGER_TYPES.has(triggerType)) return null;

	const version = await requireRow(
		tx
			.select({ manifest: agentVersion.manifest })
			.from(agentVersion)
			.where(whereEq(agentVersion.id, run.versionId))
			.limit(1),
	);
	if (externalManifestActions(version.manifest).length === 0) return null;

	return `This ${triggerType.toLowerCase()} run cannot end with no action needed, because its agent declares an action. Perform the declared action, or report why it failed.`;
}

async function requiredActionFailure(
	tx: Executor,
	run: LockedAgentRun,
): Promise<{ code: string; message: string } | null> {
	const version = await requireRow(
		tx
			.select({ manifest: agentVersion.manifest })
			.from(agentVersion)
			.where(whereEq(agentVersion.id, run.versionId))
			.limit(1),
	);
	const external = externalManifestActions(version.manifest);
	const recorded = await tx
		.select({
			type: agentAction.type,
			status: agentAction.status,
			errorCode: agentAction.errorCode,
			errorMessage: agentAction.errorMessage,
		})
		.from(agentAction)
		.where(whereEq(agentAction.runId, run.id))
		.orderBy(desc(agentAction.completedAt), desc(agentAction.plannedAt));

	for (const action of external) {
		const type = action.type;
		const rows = recorded.filter((row) => row.type === type);
		if (rows.some((row) => row.status === "SUCCEEDED")) continue;

		const executable =
			isAgentActionType(type) && Object.hasOwn(AGENT_ACTION_EXECUTORS, type);
		const latestFailure = rows.find((row) => row.status === "FAILED");
		const code = executable
			? (latestFailure?.errorCode ?? "ACTION_NOT_PERFORMED")
			: "NO_EXECUTOR";
		const message = executable
			? (latestFailure?.errorMessage ??
				`The declared ${type} action was not performed.`)
			: `The declared ${type} action has no executor.`;

		if (rows.length === 0) {
			await requireRow(
				tx
					.insert(agentAction)
					.values({
						agentId: run.agentId,
						runId: run.id,
						type,
						provider:
							type === AGENT_ACTION_TYPES.SLACK_MESSAGE_POST ? "slack" : "crm",
						summary: action.summary,
						status: "FAILED",
						idempotencyKey: `run:${run.id}:required:${type}`,
						requestHash: hashRequest({ type, required: true }),
						errorCode: code,
						errorMessage: message,
						completedAt: new Date(),
					})
					.returning(),
			);
		}

		return { code, message };
	}

	return null;
}

async function failLockedRun(
	tx: Executor,
	run: LockedAgentRun,
	code: string,
	message: string,
) {
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
			.where(whereEq(agentRun.id, run.id))
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
}

function manifestDataScope(value: JsonValue): RunDataScope {
	const scope = parseAgentManifest(value).dataScope;
	const resources = scope.resources;
	const records = resources.filter(
		(resource) => resource.kind !== "integration",
	);
	if (scope.mode === "SELECTED" && records.length === 0) {
		throw new Error("Agent version selected no CRM records.");
	}
	if (scope.mode === "WORKSPACE" && records.length > 0) {
		throw new Error("Agent version mixes workspace and selected CRM scope.");
	}
	return { mode: scope.mode, resources };
}

function manifestActions(value: JsonValue) {
	return parseAgentManifest(value).actions;
}

function externalManifestActions(value: JsonValue) {
	return manifestActions(value).filter(
		(action) => action.type !== AGENT_ACTION_TYPES.RUN_SUMMARY,
	);
}

function assertActivityAllowed(
	manifest: JsonValue,
	activityType: "NOTE" | "TASK",
) {
	const allowed = manifestActions(manifest).some(
		(action) =>
			action.type === AGENT_ACTION_TYPES.CRM_ACTIVITY_CREATE &&
			action.activityTypes.includes(activityType),
	);
	if (!allowed) {
		throw new Error(
			`Agent version does not allow CRM ${activityType.toLowerCase()} activities.`,
		);
	}
}

export function approvedSlackDestination(
	manifest: JsonValue,
): SlackRunDestination {
	const scope = manifestDataScope(manifest);
	if (
		!scope.resources.some(
			(resource) =>
				resource.kind === "integration" && resource.id === "slack:workspace",
		)
	) {
		throw new Error("Agent version does not allow Slack.");
	}

	const destinations = manifestActions(manifest).flatMap((action) =>
		action.type === AGENT_ACTION_TYPES.SLACK_MESSAGE_POST
			? [
					{
						kind: action.destination.kind,
						id: action.destination.id,
						label: action.destination.label,
					},
				]
			: [],
	);
	const [destination] = destinations;
	if (!destination || destinations.length !== 1) {
		throw new Error(
			"Agent version needs exactly one approved Slack destination.",
		);
	}

	return destination;
}

function assertResourceAllowed(
	mode: RunRecordScope,
	resources: AgentManifestResource[],
	input: { kind: "contact" | "company" | "deal"; id: string },
) {
	if (mode === "WORKSPACE") return;
	const records = resources.filter(
		(resource) => resource.kind !== "integration",
	);
	if (
		records.some(
			(resource) => resource.kind === input.kind && resource.id === input.id,
		)
	) {
		return;
	}
	throw new Error(
		"That CRM record is outside this agent version's approved scope.",
	);
}

export function allowedHistorySources(
	resources: AgentManifestResource[],
): RunHistorySources {
	const integrations = new Set(
		resources
			.filter((resource) => resource.kind === "integration")
			.map((resource) => resource.id),
	);
	return {
		gmail: integrations.has("google:gmail"),
		calendar: integrations.has("google:calendar"),
	};
}

async function targetRecord(kind: "company" | "contact" | "deal", id: string) {
	if (kind === "company") {
		const company = await firstRow(
			db
				.select({ id: companyTable.id, name: companyTable.name })
				.from(companyTable)
				.where(whereEq(companyTable.id, id))
				.limit(1),
		);
		return company
			? {
					label: company.name,
					companyId: company.id,
					contactId: null,
					dealId: null,
				}
			: null;
	}
	if (kind === "contact") {
		const contact = await firstRow(
			db
				.select({
					id: contactTable.id,
					firstName: contactTable.firstName,
					lastName: contactTable.lastName,
					companyId: contactTable.companyId,
				})
				.from(contactTable)
				.where(whereEq(contactTable.id, id))
				.limit(1),
		);
		return contact
			? {
					label: [contact.firstName, contact.lastName]
						.filter(Boolean)
						.join(" "),
					companyId: contact.companyId,
					contactId: contact.id,
					dealId: null,
				}
			: null;
	}

	const deal = await firstRow(
		db
			.select({
				id: dealTable.id,
				name: dealTable.name,
				companyId: dealTable.companyId,
			})
			.from(dealTable)
			.where(whereEq(dealTable.id, id))
			.limit(1),
	);
	return deal
		? {
				label: deal.name,
				companyId: deal.companyId,
				contactId: null,
				dealId: deal.id,
			}
		: null;
}

function actionRequestHash(input: {
	type: "NOTE" | "TASK";
	targetKind: "company" | "contact" | "deal";
	targetId: string;
	subject?: string | null;
	body?: string | null;
	dueAt?: string | null;
}): string {
	return hashRequest({
		type: input.type,
		targetKind: input.targetKind,
		targetId: input.targetId,
		subject: input.subject?.trim() || null,
		body: input.body?.trim() || null,
		dueAt: input.dueAt?.trim() || null,
	});
}

function hashRequest(input: HashableRequest): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function assertActionRequestMatches(
	existingHash: string | null,
	requestHash: string,
): void {
	if (existingHash !== requestHash) {
		throw new Error("That agent action call was already used for other input.");
	}
}
