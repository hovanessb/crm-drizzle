import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	agentAuditEvent,
	agentBuilderArtifact,
	agentConversation,
	agentDefinition,
	agentEvent,
	agentTrigger,
	agentVersion,
	and,
	asc,
	db,
	desc,
	eq,
	firstRow,
	inArray,
	or,
	requireRow,
	user,
	whereEq,
} from "@crm/db";
import { persistBuilderInputRequest } from "../agent/lib/builder-input";
import {
	saveBuilderDraft,
	writeBuilderArtifact,
} from "../agent/lib/builder-runtime";
import { setBuilderConversationTitle } from "../agent/lib/conversation-title";
import { builderToken } from "../agent/lib/custom-agent-dispatch";

const suffix = crypto.randomUUID();
const userId = `builder-runtime-user-${suffix}`;
let conversationId = "";
let agentId = "";
const conversationIds: string[] = [];

beforeAll(async () => {
	await requireRow(
		db
			.insert(user)
			.values({
				id: userId,
				name: "Builder Runtime Test",
				email: `${userId}@example.test`,
			})
			.returning(),
	);
	const conversation = await requireRow(
		db
			.insert(agentConversation)
			.values({
				kind: "BUILDER",
				userId,
				sessionId: `builder-question-session-${suffix}`,
			})
			.returning({ id: agentConversation.id }),
	);
	conversationId = conversation.id;
	conversationIds.push(conversation.id);
});

afterAll(async () => {
	const agentIds = (
		await db
			.select({ id: agentDefinition.id })
			.from(agentDefinition)
			.where(whereEq(agentDefinition.createdById, userId))
	).map((agent) => agent.id);
	if (agentIds.length > 0) {
		await db
			.delete(agentBuilderArtifact)
			.where(
				or(
					inArray(agentBuilderArtifact.conversationId, conversationIds),
					inArray(
						agentBuilderArtifact.versionId,
						db
							.select({ id: agentVersion.id })
							.from(agentVersion)
							.where(inArray(agentVersion.agentId, agentIds)),
					),
				),
			);
		await db
			.delete(agentAuditEvent)
			.where(inArray(agentAuditEvent.agentId, agentIds));
		await db
			.delete(agentTrigger)
			.where(inArray(agentTrigger.agentId, agentIds));
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
	await db
		.delete(agentConversation)
		.where(inArray(agentConversation.id, conversationIds));
	await db.delete(user).where(whereEq(user.id, userId));
});

describe("builder persistence", () => {
	it("persists a proxied child question on its builder conversation", async () => {
		const request = {
			kind: "question",
			requestId: "question-from-child",
			prompt: "Which channel should receive this?",
			action: {
				kind: "tool-call",
				callId: "call-from-child",
				toolName: "ask_question",
				input: { prompt: "Which channel should receive this?" },
			},
			display: "select",
			options: [{ id: "C123", label: "#sales" }],
		};
		const event = {
			requests: [request],
			sequence: 1,
			stepIndex: 2,
			turnId: "child-turn",
		};

		expect(
			await persistBuilderInputRequest(event, undefined, conversationId),
		).toBe(true);
		expect(
			await firstRow(
				db
					.select({
						continuationToken: agentConversation.continuationToken,
						pendingInputRequests: agentConversation.pendingInputRequests,
					})
					.from(agentConversation)
					.where(whereEq(agentConversation.id, conversationId))
					.limit(1),
			),
		).toEqual({
			continuationToken: builderToken(conversationId),
			pendingInputRequests: [request],
		});
		expect(
			await firstRow(
				db
					.select({
						conversationId: agentEvent.conversationId,
						type: agentEvent.type,
						data: agentEvent.data,
					})
					.from(agentEvent)
					.where(
						whereEq(
							agentEvent.id,
							`builder-input:${conversationId}:${event.turnId}:${event.sequence}:${event.stepIndex}`,
						),
					)
					.limit(1),
			),
		).toEqual({
			conversationId,
			type: "input.requested",
			data: event,
		});

		const newer = {
			...event,
			sequence: 4,
			requests: [
				{
					...request,
					requestId: "newer-question-from-child",
					prompt: "Which deal stage should this watch?",
				},
			],
		};
		expect(
			await persistBuilderInputRequest(newer, undefined, conversationId),
		).toBe(true);

		expect(
			await persistBuilderInputRequest(event, undefined, conversationId),
		).toBe(false);
		expect(
			await persistBuilderInputRequest(
				{
					...event,
					sequence: 2,
					requests: [{ ...request, requestId: "stale-question-from-child" }],
				},
				undefined,
				conversationId,
			),
		).toBe(false);

		expect(
			await firstRow(
				db
					.select({
						pendingInputRequests: agentConversation.pendingInputRequests,
					})
					.from(agentConversation)
					.where(whereEq(agentConversation.id, conversationId))
					.limit(1),
			),
		).toEqual({ pendingInputRequests: newer.requests });
		expect(
			await db.$count(
				agentEvent,
				whereEq(
					agentEvent.id,
					`builder-input:${conversationId}:${event.turnId}:2:${event.stepIndex}`,
				),
			),
		).toBe(0);
	});

	it("persists every request from the same event", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({
					kind: "BUILDER",
					userId,
					sessionId: `builder-approval-session-${suffix}`,
				})
				.returning({ id: agentConversation.id }),
		);
		conversationIds.push(conversation.id);
		const approval = {
			kind: "tool-approval" as const,
			requestId: "approval-from-child",
			prompt: "Archive the field?",
			action: {
				kind: "tool-call" as const,
				callId: "approval-call",
				toolName: "archive_field",
				input: { fieldId: "field-1" },
			},
			options: [
				{ id: "approve", label: "Approve" },
				{ id: "cancel", label: "Decline" },
			],
		};
		const question = {
			kind: "question" as const,
			requestId: "question-after-approval",
			prompt: "Which field?",
			action: {
				kind: "tool-call" as const,
				callId: "question-call",
				toolName: "ask_question",
				input: { prompt: "Which field?" },
			},
		};
		const sessionLimit = {
			kind: "session-limit" as const,
			requestId: "session-limit-from-child",
			prompt: "This session reached its usage limit. Continue?",
			action: {
				kind: "tool-call" as const,
				callId: "session-limit-call",
				toolName: "session_limit",
				input: {},
			},
			options: [
				{ id: "continue", label: "Continue" },
				{ id: "stop", label: "Stop" },
			],
		};

		expect(
			await persistBuilderInputRequest(
				{
					requests: [question, approval, sessionLimit],
					sequence: 1,
					stepIndex: 1,
					turnId: "approval-turn",
				},
				undefined,
				conversation.id,
			),
		).toBe(true);
		expect(
			await firstRow(
				db
					.select({
						pendingInputRequests: agentConversation.pendingInputRequests,
					})
					.from(agentConversation)
					.where(whereEq(agentConversation.id, conversation.id))
					.limit(1),
			),
		).toEqual({ pendingInputRequests: [question, approval, sessionLimit] });
	});

	it("ignores a delayed question from a turn the session has already left", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({
					kind: "BUILDER",
					userId,
					sessionId: `builder-stale-turn-session-${suffix}`,
				})
				.returning({ id: agentConversation.id }),
		);
		conversationIds.push(conversation.id);

		const question = (requestId: string, prompt: string) => ({
			kind: "question",
			requestId,
			prompt,
			action: {
				kind: "tool-call",
				callId: `call-${requestId}`,
				toolName: "ask_question",
				input: { prompt },
			},
			display: "text",
		});

		const current = question("current-turn-question", "Which channel?");
		expect(
			await persistBuilderInputRequest(
				{
					requests: [current],
					sequence: 5,
					stepIndex: 0,
					turnId: "turn_5",
				},
				undefined,
				conversation.id,
			),
		).toBe(true);

		expect(
			await persistBuilderInputRequest(
				{
					requests: [question("earlier-turn-question", "Which stage?")],
					sequence: 3,
					stepIndex: 7,
					turnId: "turn_3",
				},
				undefined,
				conversation.id,
			),
		).toBe(false);

		expect(
			await firstRow(
				db
					.select({
						pendingInputRequests: agentConversation.pendingInputRequests,
					})
					.from(agentConversation)
					.where(whereEq(agentConversation.id, conversation.id))
					.limit(1),
			),
		).toEqual({ pendingInputRequests: [current] });
		expect(
			await db.$count(
				agentEvent,
				whereEq(agentEvent.id, `builder-input:${conversation.id}:turn_3:3:7`),
			),
		).toBe(0);
	});

	it("sets a concise model-authored title only once", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({ kind: "BUILDER", userId })
				.returning({ id: agentConversation.id }),
		);
		conversationIds.push(conversation.id);

		expect(
			await setBuilderConversationTitle(
				conversation.id,
				userId,
				"  “Flag stale pipeline deals”  ",
			),
		).toEqual({ saved: true, title: "Flag stale pipeline deals" });
		expect(
			await setBuilderConversationTitle(
				conversation.id,
				userId,
				"Replace the title",
			),
		).toEqual({ saved: false, title: "Flag stale pipeline deals" });
	});

	it("serializes concurrent file writes and draft saves", async () => {
		const instructions =
			"When manually triggered, review the approved CRM scope and write a concise run summary without changing external systems.";
		const writes = await Promise.all(
			Array.from({ length: 4 }, () =>
				writeBuilderArtifact(
					conversationId,
					userId,
					"agent/instructions.md",
					`${instructions}\n`,
				),
			),
		);

		expect(new Set(writes.map((write) => write.id)).size).toBe(1);
		expect(new Set(writes.map((write) => write.revision))).toEqual(
			new Set([1]),
		);

		const input = {
			name: "Meeting prep",
			description: "Prepare a concise CRM meeting brief.",
			instructions,
			triggers: [
				{
					type: "MANUAL" as const,
					name: "Manual",
					summary: "Run when a rep requests meeting preparation.",
				},
			],
			recordScope: "WORKSPACE" as const,
			resources: [],
			actions: [
				{
					type: "run.summary" as const,
					provider: "crm" as const,
					summary: "Write a run summary.",
				},
			],
			access: ["Read CRM records in the approved scope"],
		};
		const saves = await Promise.all(
			Array.from({ length: 4 }, () =>
				saveBuilderDraft(conversationId, userId, input),
			),
		);
		const saved = saves.flatMap((save) => (save.saved ? [save] : []));

		expect(saved).toHaveLength(4);
		expect(new Set(saved.map((save) => save.agentId)).size).toBe(1);
		expect(new Set(saved.map((save) => save.versionId)).size).toBe(1);
		agentId = saved[0]?.agentId ?? "";
		expect(
			await db.$count(agentDefinition, whereEq(agentDefinition.id, agentId)),
		).toBe(1);
		expect(
			await db.$count(agentVersion, whereEq(agentVersion.agentId, agentId)),
		).toBe(1);

		const artifact = await requireRow(
			db
				.select({
					revision: agentBuilderArtifact.revision,
					status: agentBuilderArtifact.status,
					versionId: agentBuilderArtifact.versionId,
				})
				.from(agentBuilderArtifact)
				.where(
					and(
						whereEq(agentBuilderArtifact.conversationId, conversationId),
						eq(agentBuilderArtifact.path, "agent/instructions.md"),
					),
				)
				.orderBy(desc(agentBuilderArtifact.revision))
				.limit(1),
		);
		expect(artifact).toEqual({
			revision: 1,
			status: "READY",
			versionId: saved[0]?.versionId,
		});
	});

	it("assigns consecutive versions to distinct concurrent drafts", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({ kind: "BUILDER", userId })
				.returning({ id: agentConversation.id }),
		);
		conversationIds.push(conversation.id);
		const base = {
			description: "Prepare a distinct CRM run summary.",
			triggers: [
				{
					type: "MANUAL" as const,
					name: "Manual",
					summary: "Run when a rep requests it.",
				},
			],
			recordScope: "WORKSPACE" as const,
			resources: [],
			actions: [
				{
					type: "run.summary" as const,
					provider: "crm" as const,
					summary: "Write a run summary.",
				},
			],
			access: ["Read workspace CRM records"],
		};
		const saves = await Promise.all(
			Array.from({ length: 4 }, (_, index) =>
				saveBuilderDraft(conversation.id, userId, {
					...base,
					name: `Concurrent draft ${index + 1}`,
					instructions: `When manually triggered, prepare distinct CRM summary ${index + 1} without changing external systems.`,
				}),
			),
		);
		const saved = saves.flatMap((save) => (save.saved ? [save] : []));

		expect(saved).toHaveLength(4);
		expect(new Set(saved.map((save) => save.agentId)).size).toBe(1);
		expect(saved.map((save) => save.versionNumber).sort()).toEqual([
			1, 2, 3, 4,
		]);
		expect(
			await db.$count(
				agentVersion,
				whereEq(agentVersion.agentId, saved[0]?.agentId),
			),
		).toBe(4);
	});

	it("persists every event trigger on one agent version", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({ kind: "BUILDER", userId })
				.returning({ id: agentConversation.id }),
		);
		conversationIds.push(conversation.id);

		const saved = await saveBuilderDraft(conversation.id, userId, {
			name: "Deal lifecycle alerts",
			description: "Report deal creation, opening, and closing.",
			instructions:
				"When a configured deal lifecycle event occurs, read the triggering deal, return one concise summary of the change, and stop without changing CRM records.",
			triggers: [
				{
					type: "EVENT",
					name: "Deal created",
					summary: "Run when a deal is created.",
					event: "deal.created",
				},
				{
					type: "EVENT",
					name: "Deal opened",
					summary: "Run when a closed deal returns to the open pipeline.",
					event: "deal.opened",
				},
				{
					type: "EVENT",
					name: "Deal closed",
					summary: "Run when an open deal enters a closed stage.",
					event: "deal.closed",
				},
			],
			recordScope: "WORKSPACE",
			resources: [],
			actions: [
				{
					type: "run.summary",
					provider: "crm",
					summary: "Write a deal lifecycle summary.",
				},
			],
			access: ["Read workspace CRM records"],
		});
		if (!saved.saved) throw new Error("Lifecycle draft was not saved");

		expect(
			await db
				.select({ type: agentTrigger.type, config: agentTrigger.config })
				.from(agentTrigger)
				.where(whereEq(agentTrigger.versionId, saved.versionId))
				.orderBy(asc(agentTrigger.createdAt)),
		).toEqual([
			{ type: "EVENT", config: { event: "deal.created" } },
			{ type: "EVENT", config: { event: "deal.opened" } },
			{ type: "EVENT", config: { event: "deal.closed" } },
		]);

		const version = await requireRow(
			db
				.select({ manifest: agentVersion.manifest })
				.from(agentVersion)
				.where(whereEq(agentVersion.id, saved.versionId))
				.limit(1),
		);
		expect(version.manifest).toMatchObject({
			triggers: [
				{ config: { event: "deal.created" } },
				{ config: { event: "deal.opened" } },
				{ config: { event: "deal.closed" } },
			],
		});
	});

	it("fails closed on unsupported integrations and ambiguous record scope", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({ kind: "BUILDER", userId })
				.returning({ id: agentConversation.id }),
		);
		conversationIds.push(conversation.id);
		const base = {
			name: "Safe scope",
			description: "Keep a bounded CRM summary.",
			instructions:
				"When manually triggered, read only the approved CRM scope and return a concise summary without changing CRM records.",
			triggers: [
				{
					type: "MANUAL" as const,
					name: "Manual",
					summary: "Run only when a teammate requests it.",
				},
			],
			actions: [
				{
					type: "run.summary" as const,
					provider: "crm" as const,
					summary: "Return a run summary.",
				},
			],
			access: ["Read approved CRM records"],
		};

		const unsupported = await saveBuilderDraft(conversation.id, userId, {
			...base,
			recordScope: "WORKSPACE",
			resources: [
				{ kind: "integration", id: "google:drive", label: "Google Drive" },
			],
		});
		expect(unsupported).toMatchObject({
			saved: false,
			issues: ["Google Drive is not an available integration."],
		});

		const ambiguous = await saveBuilderDraft(conversation.id, userId, {
			...base,
			recordScope: "SELECTED",
			resources: [],
		});
		expect(ambiguous).toMatchObject({
			saved: false,
			issues: ["Selected CRM scope needs at least one tagged record."],
		});

		const missingSummary = await saveBuilderDraft(conversation.id, userId, {
			...base,
			recordScope: "WORKSPACE",
			resources: [],
			actions: [
				{
					type: "crm.activity.create",
					provider: "crm",
					summary: "Write one note.",
					activityTypes: ["NOTE"],
				},
			],
		});
		expect(missingSummary).toMatchObject({
			saved: false,
			issues: ["An agent needs one run summary action."],
		});

		const duplicateActions = await saveBuilderDraft(conversation.id, userId, {
			...base,
			recordScope: "WORKSPACE",
			resources: [],
			actions: [...base.actions, ...base.actions],
		});
		expect(duplicateActions).toMatchObject({
			saved: false,
			issues: ["The run.summary action is listed more than once."],
		});
	});

	it("keeps a live definition unchanged until a revised version is deployed", async () => {
		const conversation = await requireRow(
			db
				.insert(agentConversation)
				.values({ kind: "BUILDER", userId })
				.returning({ id: agentConversation.id }),
		);
		conversationIds.push(conversation.id);

		const original = {
			name: "Workspace pulse",
			description: "Report the workspace company count.",
			instructions:
				"When manually triggered, read workspace companies and return the company count in a concise run summary without changing CRM records.",
			triggers: [
				{
					type: "MANUAL" as const,
					name: "Manual",
					summary: "Run when a teammate requests a workspace pulse.",
				},
			],
			recordScope: "WORKSPACE" as const,
			resources: [],
			actions: [
				{
					type: "run.summary" as const,
					provider: "crm" as const,
					summary: "Write a run summary.",
				},
			],
			access: ["Read workspace CRM records"],
		};
		const first = await saveBuilderDraft(conversation.id, userId, original);
		if (!first.saved) throw new Error("Initial draft was not saved");

		await db.transaction(async (tx) => {
			await requireRow(
				tx
					.update(agentVersion)
					.set({ status: "DEPLOYED" })
					.where(eq(agentVersion.id, first.versionId))
					.returning(),
			);
			await requireRow(
				tx
					.update(agentDefinition)
					.set({
						name: "Workspace pulse",
						description: "Team-visible description",
						status: "LIVE",
						currentVersionId: first.versionId,
					})
					.where(eq(agentDefinition.id, first.agentId))
					.returning(),
			);
		});

		const revised = {
			...original,
			name: "Workspace health pulse",
			description: "Report company and open-deal counts.",
		};
		await writeBuilderArtifact(
			conversation.id,
			userId,
			"agent/README.md",
			`# ${revised.name}\n\n${revised.description}\n\n## Triggers\n\n- ${revised.triggers[0]?.summary}\n\n## Access\n\n- ${revised.access[0]}\n`,
		);
		const second = await saveBuilderDraft(conversation.id, userId, revised);
		if (!second.saved) throw new Error("Revised draft was not saved");

		const [definition, version, artifacts] = await Promise.all([
			requireRow(
				db
					.select({
						name: agentDefinition.name,
						description: agentDefinition.description,
						status: agentDefinition.status,
						currentVersionId: agentDefinition.currentVersionId,
					})
					.from(agentDefinition)
					.where(whereEq(agentDefinition.id, first.agentId))
					.limit(1),
			),
			requireRow(
				db
					.select({
						number: agentVersion.number,
						status: agentVersion.status,
						manifest: agentVersion.manifest,
					})
					.from(agentVersion)
					.where(whereEq(agentVersion.id, second.versionId))
					.limit(1),
			),
			db
				.select({
					path: agentBuilderArtifact.path,
					status: agentBuilderArtifact.status,
				})
				.from(agentBuilderArtifact)
				.where(
					and(
						whereEq(agentBuilderArtifact.conversationId, conversation.id),
						whereEq(agentBuilderArtifact.versionId, second.versionId),
					),
				),
		]);

		expect(second.versionId).not.toBe(first.versionId);
		expect(definition).toEqual({
			name: "Workspace pulse",
			description: "Team-visible description",
			status: "LIVE",
			currentVersionId: first.versionId,
		});
		expect(version).toMatchObject({
			number: 2,
			status: "READY",
			manifest: {
				name: revised.name,
				description: revised.description,
			},
		});
		expect(artifacts).toHaveLength(3);
		expect(artifacts.every((artifact) => artifact.status === "READY")).toBe(
			true,
		);
		expect(
			await db.$count(
				agentBuilderArtifact,
				and(
					whereEq(agentBuilderArtifact.conversationId, conversation.id),
					eq(agentBuilderArtifact.status, "WRITING"),
				),
			),
		).toBe(0);
	});
});
