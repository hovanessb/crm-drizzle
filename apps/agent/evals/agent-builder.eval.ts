import {
	agentAuditEvent,
	agentBuilderArtifact,
	agentConversation,
	agentConversationSubmission,
	agentDefinition,
	agentEvent,
	agentTrigger,
	agentVersion,
	db,
	desc,
	eq,
	firstRow,
	inArray,
	orThrow,
	requireRow,
	user,
	whereEq,
} from "@crm/db";
import { agentManifest } from "@crm/validation/agent-manifest";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

export default defineEval({
	description:
		"Turn a short outcome request into a safe, review-only team agent through the durable CRM channel.",
	tags: ["builder", "integration"],
	timeoutMs: 180_000,
	async test(t) {
		const secret = process.env.AGENT_BRIDGE_SECRET?.trim();
		if (
			!process.env.DATABASE_URL ||
			!secret ||
			(!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN)
		) {
			t.skip(
				"Requires DATABASE_URL, AGENT_BRIDGE_SECRET, and an AI Gateway credential.",
			);
			return;
		}

		const suffix = crypto.randomUUID();
		const userId = `builder-eval-user-${suffix}`;
		let conversationId: string | null = null;
		let sessionId: string | null = null;

		try {
			await requireRow(
				db
					.insert(user)
					.values({
						id: userId,
						name: "Agent Builder Eval",
						email: `${userId}@example.test`,
					})
					.returning(),
			);
			const conversation = await requireRow(
				db
					.insert(agentConversation)
					.values({ kind: "BUILDER", userId })
					.returning({ id: agentConversation.id }),
			);
			await db.insert(agentConversationSubmission).values({
				conversationId: conversation.id,
				...{
					submittedById: userId,
					clientRequestId: crypto.randomUUID(),
					commandType: "CREATE_AGENT",
					message: {
						text: "Build me an agent that gives me a snapshot of our CRM accounts.",
						resources: [],
					},
				},
			});
			conversationId = conversation.id;

			const response = await t.target.fetch("/internal/crm/builder-dispatch", {
				method: "POST",
				headers: { authorization: `Bearer ${secret}` },
			});
			await t.require(response.status, equals(202));

			sessionId = await waitForBuilderSession(conversation.id, t.signal);
			await t.require(
				sessionId,
				satisfies<string | null>(
					(value) => value !== null,
					"builder session started",
				),
			);
			const session = await t.target.attachSession(sessionId as string);
			session.succeeded();
			session.calledSubagent("agent_builder", { count: 1 });
			session.notCalledTool("record_fact");
			session.notCalledTool("record_job_change");

			const saved = await db.query.agentConversation
				.findFirst({
					where: whereEq(agentConversation.id, conversation.id),
					columns: {},
					with: {
						agent: {
							columns: { status: true },
							with: {
								versions: {
									orderBy: [desc(agentVersion.number)],
									limit: 1,
									columns: { status: true, manifest: true },
								},
							},
						},
						builderArtifacts: {
							where: eq(agentBuilderArtifact.status, "READY"),
							columns: { path: true },
						},
					},
				})
				.then(orThrow);
			t.check(saved.agent?.status, equals("DRAFT"));
			t.check(saved.agent?.versions[0]?.status, equals("READY"));
			t.check(saved.builderArtifacts.length, equals(3));
			t.check(
				saved.agent?.versions[0]?.manifest,
				satisfies((value) => {
					const parsed = agentManifest.safeParse(value);
					return (
						parsed.success &&
						parsed.data.dataScope.mode === "WORKSPACE" &&
						parsed.data.actions.length === 1 &&
						parsed.data.actions[0]?.type === "run.summary"
					);
				}, "saved manifest is workspace-scoped and side-effect-free"),
			);
		} finally {
			await cleanupBuilderEval(userId, conversationId, sessionId);
		}
	},
});

async function waitForBuilderSession(
	conversationId: string,
	signal: AbortSignal,
): Promise<string | null> {
	for (let attempt = 0; attempt < 600; attempt += 1) {
		if (signal.aborted) return null;
		const conversation = await firstRow(
			db
				.select({ sessionId: agentConversation.sessionId })
				.from(agentConversation)
				.where(whereEq(agentConversation.id, conversationId))
				.limit(1),
		);
		if (conversation?.sessionId) return conversation.sessionId;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return null;
}

async function cleanupBuilderEval(
	userId: string,
	conversationId: string | null,
	sessionId: string | null,
) {
	const agents = await db
		.select({ id: agentDefinition.id })
		.from(agentDefinition)
		.where(whereEq(agentDefinition.createdById, userId));
	const agentIds = agents.map((agent) => agent.id);
	if (sessionId)
		await db.delete(agentEvent).where(whereEq(agentEvent.sessionId, sessionId));
	if (conversationId) {
		await db
			.delete(agentBuilderArtifact)
			.where(whereEq(agentBuilderArtifact.conversationId, conversationId));
	}
	if (agentIds.length > 0) {
		await db
			.delete(agentBuilderArtifact)
			.where(
				inArray(
					agentBuilderArtifact.versionId,
					db
						.select({ id: agentVersion.id })
						.from(agentVersion)
						.where(inArray(agentVersion.agentId, agentIds)),
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
	if (conversationId) {
		await db
			.delete(agentConversation)
			.where(whereEq(agentConversation.id, conversationId));
	}
	await db.delete(user).where(whereEq(user.id, userId));
}
