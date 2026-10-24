import { isDeepStrictEqual } from "node:util";
import {
	account as accountTable,
	agentAuditEvent,
	agentBuilderArtifact,
	agentConversation,
	agentConversationSubmission,
	agentDefinition,
	agentTrigger,
	agentVersion,
	and,
	asc,
	company,
	contact,
	db,
	deal,
	desc,
	type Executor,
	eq,
	firstRow,
	isNotNull,
	type JsonValue,
	mcpConnection,
	mcpToolSnapshot,
	member,
	orNull,
	queryRows,
	requireRow,
	slackChannel,
	slackMemberMatch,
	sql,
	user,
	whereEq,
} from "@crm/db";
import {
	CRM_EVENT_CATALOG,
	CRM_EVENT_TYPES,
	type CrmEventType,
} from "@crm/db/crm-events";
import { readAgentModel } from "@crm/db/settings";
import { WORKSPACE_ID } from "@crm/db/workspace";
import {
	AGENT_ACTION_TYPES,
	type AgentManifestMcpGrant,
} from "@crm/validation/agent-manifest";
import { z } from "zod";
import { actionDependency } from "./agent-actions";
import { requestStaleSlackInventorySync } from "./slack-people";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export type BuilderResource = {
	kind: "integration" | "company" | "contact" | "deal";
	id: string;
	label: string;
};

const taggedResource = z
	.object({
		kind: z.enum(["integration", "company", "contact", "deal"]),
		id: z.string(),
		label: z.string(),
	})
	.nullable()
	.catch(null);

const taggedResources = z
	.object({ resources: z.array(taggedResource).catch([]) })
	.catch({ resources: [] });

export type DraftTrigger = {
	type: "MANUAL" | "SCHEDULE" | "EVENT";
	name: string;
	summary: string;
	event?: CrmEventType | null;
	nextRunAt?: string | null;
	intervalMinutes?: number | null;
};

export type DraftAction =
	| {
			type: typeof AGENT_ACTION_TYPES.CRM_ACTIVITY_CREATE;
			provider: "crm";
			summary: string;
			activityTypes: ("NOTE" | "TASK")[];
	  }
	| {
			type: typeof AGENT_ACTION_TYPES.RUN_SUMMARY;
			provider: "crm";
			summary: string;
	  }
	| {
			type: typeof AGENT_ACTION_TYPES.SLACK_MESSAGE_POST;
			provider: "slack";
			summary: string;
			destination: {
				kind: "channel" | "user";
				resolution: "chosen";
				id: string;
				label: string;
			};
	  };

export type DraftAgentInput = {
	name: string;
	description: string;
	instructions: string;
	triggers: DraftTrigger[];
	recordScope: "SELECTED" | "WORKSPACE";
	resources: BuilderResource[];
	actions: DraftAction[];
	mcp: AgentManifestMcpGrant[];
	access: string[];
};

export const BUILDER_ARTIFACT_PATHS = [
	"agent/README.md",
	"agent/instructions.md",
	"agent/manifest.json",
] as const;

export type BuilderArtifactPath = (typeof BUILDER_ARTIFACT_PATHS)[number];

const ARTIFACT_LANGUAGES = {
	"agent/README.md": "markdown",
	"agent/instructions.md": "markdown",
	"agent/manifest.json": "json",
} satisfies Record<BuilderArtifactPath, string>;

export async function writeBuilderArtifact(
	conversationId: string,
	userId: string,
	path: BuilderArtifactPath,
	content: string,
) {
	assertSafeArtifact(content);

	return db.transaction(async (tx) => {
		const [conversation] = await queryRows<{ id: string }>(
			tx,
			sql`
			SELECT id
			FROM "agentConversation"
			WHERE id = ${conversationId}
				AND "userId" = ${userId}
				AND kind = 'BUILDER'
			FOR UPDATE
		`,
		);
		if (!conversation) {
			throw new Error("This builder conversation is unavailable.");
		}

		const latest = await firstRow(
			tx
				.select({
					id: agentBuilderArtifact.id,
					revision: agentBuilderArtifact.revision,
					content: agentBuilderArtifact.content,
					status: agentBuilderArtifact.status,
				})
				.from(agentBuilderArtifact)
				.where(
					and(
						whereEq(agentBuilderArtifact.conversationId, conversationId),
						whereEq(agentBuilderArtifact.path, path),
					),
				)
				.orderBy(desc(agentBuilderArtifact.revision))
				.limit(1),
		);

		if (latest?.content === content) {
			return { saved: true as const, id: latest.id, revision: latest.revision };
		}

		const artifact = await requireRow(
			tx
				.insert(agentBuilderArtifact)
				.values({
					conversationId,
					path,
					language: ARTIFACT_LANGUAGES[path],
					content,
					previousContent: latest?.content ?? null,
					revision: (latest?.revision ?? 0) + 1,
					status: "WRITING",
				})
				.returning({
					id: agentBuilderArtifact.id,
					revision: agentBuilderArtifact.revision,
				}),
		);

		return { saved: true as const, ...artifact };
	});
}

export async function builderContext(conversationId: string, userId: string) {
	const conversation = await db.query.agentConversation
		.findFirst({
			where: and(
				whereEq(agentConversation.id, conversationId),
				whereEq(agentConversation.userId, userId),
				eq(agentConversation.kind, "BUILDER"),
			),
			columns: { id: true, title: true },
			with: {
				agent: {
					columns: { id: true, name: true, description: true, status: true },
					with: {
						versions: {
							orderBy: [desc(agentVersion.number)],
							limit: 1,
							columns: {
								id: true,
								number: true,
								status: true,
								manifest: true,
								instructions: true,
							},
						},
					},
				},
				submissions: {
					orderBy: [asc(agentConversationSubmission.createdAt)],
					columns: { id: true, message: true, createdAt: true },
				},
			},
		})
		.then(orNull);

	if (!conversation)
		throw new Error("This builder conversation is unavailable.");

	const resources = uniqueResources(
		conversation.submissions.flatMap((submission) =>
			resourcesOf(submission.message),
		),
	);

	return {
		conversation: {
			id: conversation.id,
			title: conversation.title,
		},
		availableConnections: await connectionStatus(userId),
		crmEvents: CRM_EVENT_TYPES.map((type) => ({
			type,
			...CRM_EVENT_CATALOG[type],
		})),
		resources: await describeResources(resources),
		existingDraft: conversation.agent,
		now: new Date().toISOString(),
	};
}

export async function saveBuilderDraft(
	conversationId: string,
	userId: string,
	input: DraftAgentInput,
) {
	const conversation = await db.query.agentConversation
		.findFirst({
			where: and(
				whereEq(agentConversation.id, conversationId),
				whereEq(agentConversation.userId, userId),
				eq(agentConversation.kind, "BUILDER"),
			),
			columns: { id: true },
			with: { submissions: { columns: { message: true } } },
		})
		.then(orNull);

	if (!conversation)
		throw new Error("This builder conversation is unavailable.");

	const taggedResources = uniqueResources(
		conversation.submissions.flatMap((submission) =>
			resourcesOf(submission.message),
		),
	);
	const validation = await validateDraft(userId, input, taggedResources);
	if (!validation.valid) {
		return {
			saved: false as const,
			issues: validation.issues,
			availableConnections: validation.connections,
		};
	}

	const model = await readAgentModel(db);
	const now = new Date();
	const manifestTriggers = input.triggers.map((trigger) => ({
		type: trigger.type,
		name: trigger.name,
		summary: trigger.summary,
		config:
			trigger.type === "SCHEDULE"
				? {
						intervalMinutes: trigger.intervalMinutes,
						nextRunAt: scheduleDate(trigger, now)?.toISOString(),
					}
				: trigger.type === "EVENT"
					? { event: trigger.event }
					: {},
	}));
	const manifest = {
		kind: "crm-team-agent",
		name: input.name,
		description: input.description,
		triggers: manifestTriggers,
		dataScope: {
			mode: input.recordScope,
			summary: scopeSummary(input.recordScope, input.resources),
			resources: input.resources,
		},
		actions: input.actions,
		mcp: input.mcp ?? [],
		access: input.access,
	};
	const sandboxPolicy = {
		backend: "eve-default",
		networkPolicy: "deny-all",
		credentials: "app-runtime-only",
		summary: "Isolated sandbox · deny-all network · bounded CRM tools",
	};
	const files = artifactFiles(input, JSON.stringify(manifest, null, 2));
	for (const file of files) assertSafeArtifact(file.content);

	return db.transaction(async (tx) => {
		const [lockedConversation] = await queryRows<{
			id: string;
			agentId: string | null;
		}>(
			tx,
			sql`
			SELECT id, "agentId"
			FROM "agentConversation"
			WHERE id = ${conversationId}
				AND "userId" = ${userId}
				AND kind = 'BUILDER'
			FOR UPDATE
		`,
		);
		if (!lockedConversation) {
			throw new Error("This builder conversation is unavailable.");
		}

		let agentId = lockedConversation.agentId;
		let created = false;

		if (!agentId) {
			const agent = await requireRow(
				tx
					.insert(agentDefinition)
					.values({
						name: input.name,
						description: input.description,
						createdById: userId,
					})
					.returning({ id: agentDefinition.id }),
			);
			agentId = agent.id;
			created = true;

			await requireRow(
				tx
					.update(agentConversation)
					.set({ agentId, title: input.name })
					.where(whereEq(agentConversation.id, conversationId))
					.returning(),
			);
		} else {
			const [agent] = await queryRows<{
				status: "DRAFT" | "LIVE" | "PAUSED" | "ARCHIVED" | "DELETED";
			}>(
				tx,
				sql`
				SELECT status
				FROM "agentDefinition"
				WHERE id = ${agentId}
				FOR UPDATE
			`,
			);
			if (!agent || agent.status === "DELETED") {
				throw new Error("This agent is unavailable.");
			}
			if (agent.status === "DRAFT") {
				await requireRow(
					tx
						.update(agentDefinition)
						.set({ name: input.name, description: input.description })
						.where(whereEq(agentDefinition.id, agentId))
						.returning(),
				);
			}
		}

		const latest = await firstRow(
			tx
				.select({
					id: agentVersion.id,
					number: agentVersion.number,
					status: agentVersion.status,
					instructions: agentVersion.instructions,
					manifest: agentVersion.manifest,
					modelId: agentVersion.modelId,
					modelContextWindowTokens: agentVersion.modelContextWindowTokens,
				})
				.from(agentVersion)
				.where(whereEq(agentVersion.agentId, agentId))
				.orderBy(desc(agentVersion.number))
				.limit(1),
		);
		if (
			latest?.status === "READY" &&
			latest.instructions === input.instructions &&
			latest.modelId === model.id &&
			latest.modelContextWindowTokens === model.contextWindowTokens &&
			isDeepStrictEqual(latest.manifest, manifest)
		) {
			await persistArtifactSnapshots(tx, conversationId, latest.id, files);
			return {
				saved: true as const,
				agentId,
				versionId: latest.id,
				versionNumber: latest.number,
				status: latest.status,
			};
		}

		const number = (latest?.number ?? 0) + 1;
		const version = await requireRow(
			tx
				.insert(agentVersion)
				.values({
					agentId,
					number,
					status: "READY",
					instructions: input.instructions,
					manifest: manifest as JsonValue,
					modelId: model.id,
					modelContextWindowTokens: model.contextWindowTokens,
					sandboxPolicy,
					validation: {
						status: "passed",
						checkedAt: now.toISOString(),
						capabilities: validation.capabilities,
					},
					sourceConversationId: conversationId,
					createdById: userId,
				})
				.returning({
					id: agentVersion.id,
					number: agentVersion.number,
					status: agentVersion.status,
				}),
		);

		await persistArtifactSnapshots(tx, conversationId, version.id, files);

		await tx.insert(agentTrigger).values(
			input.triggers.map((trigger, index) => ({
				agentId,
				versionId: version.id,
				type: trigger.type,
				name: trigger.name,
				config: manifestTriggers[index]?.config as JsonValue,
				createdById: userId,
				nextRunAt: scheduleDate(trigger, now),
			})),
		);

		if (created) {
			await requireRow(
				tx
					.insert(agentAuditEvent)
					.values({
						agentId,
						actorUserId: userId,
						actorType: "USER",
						actorId: userId,
						type: "agent.created",
						summary: "Created a draft agent from a private builder chat",
						requestId: `builder:${conversationId}`,
					})
					.returning(),
			);
		}

		await requireRow(
			tx
				.insert(agentAuditEvent)
				.values({
					agentId,
					versionId: version.id,
					actorUserId: userId,
					actorType: "USER",
					actorId: userId,
					type: "version.created",
					summary: `Prepared version ${number} for review`,
					requestId: version.id,
					after: { status: "READY", validation: "passed" },
				})
				.returning(),
		);

		return {
			saved: true as const,
			agentId,
			versionId: version.id,
			versionNumber: version.number,
			status: version.status,
		};
	});
}

async function persistArtifactSnapshots(
	tx: Executor,
	conversationId: string,
	versionId: string,
	files: ReturnType<typeof artifactFiles>,
) {
	for (const file of files) {
		const latestArtifact = await firstRow(
			tx
				.select({
					id: agentBuilderArtifact.id,
					versionId: agentBuilderArtifact.versionId,
					revision: agentBuilderArtifact.revision,
					content: agentBuilderArtifact.content,
					status: agentBuilderArtifact.status,
				})
				.from(agentBuilderArtifact)
				.where(
					and(
						whereEq(agentBuilderArtifact.conversationId, conversationId),
						whereEq(agentBuilderArtifact.path, file.path),
					),
				)
				.orderBy(desc(agentBuilderArtifact.revision))
				.limit(1),
		);
		if (
			latestArtifact?.content === file.content &&
			latestArtifact.versionId === versionId &&
			latestArtifact.status === "READY"
		) {
			continue;
		}
		if (
			latestArtifact?.content === file.content &&
			latestArtifact.status === "WRITING" &&
			latestArtifact.versionId === null
		) {
			await requireRow(
				tx
					.update(agentBuilderArtifact)
					.set({ versionId, status: "READY" })
					.where(whereEq(agentBuilderArtifact.id, latestArtifact.id))
					.returning(),
			);
			continue;
		}

		await requireRow(
			tx
				.insert(agentBuilderArtifact)
				.values({
					conversationId,
					versionId,
					path: file.path,
					language: file.language,
					content: file.content,
					previousContent: latestArtifact?.content ?? null,
					revision: (latestArtifact?.revision ?? 0) + 1,
					status: "READY",
				})
				.returning(),
		);
	}
}

async function validateDraft(
	userId: string,
	input: DraftAgentInput,
	taggedResources: BuilderResource[],
) {
	const connections = await connectionStatus(userId);
	const issues: string[] = [];
	const capabilities = new Set(["crm.read"]);
	const resourceKeys = new Set<string>();
	const recordResources = input.resources.filter(
		(resource) => resource.kind !== "integration",
	);

	if (input.recordScope === "SELECTED" && recordResources.length === 0) {
		issues.push("Selected CRM scope needs at least one tagged record.");
	}
	if (input.recordScope === "WORKSPACE" && recordResources.length > 0) {
		issues.push("Workspace CRM scope cannot also list selected records.");
	}
	const taggedRecordKeys = new Set(
		taggedResources
			.filter((resource) => resource.kind !== "integration")
			.map((resource) => `${resource.kind}:${resource.id}`),
	);
	const taggedRecordLabels = new Map(
		taggedResources
			.filter((resource) => resource.kind !== "integration")
			.map((resource) => [`${resource.kind}:${resource.id}`, resource.label]),
	);
	for (const resource of recordResources) {
		const key = `${resource.kind}:${resource.id}`;
		if (!taggedRecordKeys.has(key)) {
			issues.push(`${resource.label} was not tagged in this builder chat.`);
			continue;
		}
		if (taggedRecordLabels.get(key) !== resource.label) {
			issues.push(
				`${resource.kind} ${resource.id} must use its exact tagged label.`,
			);
		}
	}

	for (const resource of input.resources) {
		const key = `${resource.kind}:${resource.id}`;
		if (resourceKeys.has(key)) {
			issues.push(`${resource.label} is listed more than once.`);
			continue;
		}
		resourceKeys.add(key);

		if (resource.kind !== "integration") continue;
		const integration = integrationResourceStatus(resource, connections);
		if (integration.issue) issues.push(integration.issue);
		if (!integration.available) continue;
		capabilities.add(`${resource.id}.read`);
	}
	const mcpGrants = input.mcp ?? [];
	issues.push(...mcpGrantIssues(mcpGrants, input.resources, connections.mcp));
	for (const grant of mcpGrants) {
		for (const tool of grant.tools) {
			capabilities.add(`mcp:${grant.platformSlug}:${tool.name}`);
		}
	}

	const actionTypes = new Set<string>();
	for (const action of input.actions) {
		if (actionTypes.has(action.type)) {
			issues.push(`The ${action.type} action is listed more than once.`);
		}
		actionTypes.add(action.type);
		capabilities.add(action.type);
		if (action.type === AGENT_ACTION_TYPES.SLACK_MESSAGE_POST) {
			issues.push(...slackDestinationIssues(action.destination, connections));
		}
		if (action.type !== AGENT_ACTION_TYPES.CRM_ACTIVITY_CREATE) continue;
		if (new Set(action.activityTypes).size !== action.activityTypes.length) {
			issues.push("CRM activity permissions must not repeat an activity type.");
		}
	}
	if (!actionTypes.has(AGENT_ACTION_TYPES.RUN_SUMMARY)) {
		issues.push("An agent needs one run summary action.");
	}
	issues.push(...actionIntegrationIssues(input.actions, input.resources));

	const missingRecords = await missingResourceIds(input.resources);
	issues.push(
		...missingRecords.map(
			(resource) => `${resource.label} is no longer in the CRM.`,
		),
	);

	const eventTypes = new Set<CrmEventType>();
	let manualTriggers = 0;
	if (input.triggers.length === 0) {
		issues.push("An agent needs at least one trigger.");
	}
	for (const trigger of input.triggers) {
		if (trigger.type === "MANUAL") manualTriggers += 1;
		if (trigger.type === "SCHEDULE") {
			const next = Date.parse(trigger.nextRunAt ?? "");
			if (!Number.isFinite(next) || next <= Date.now()) {
				issues.push("A scheduled trigger needs a future next run time.");
			}
			if (
				!trigger.intervalMinutes ||
				trigger.intervalMinutes < 1 ||
				trigger.intervalMinutes > 525_600
			) {
				issues.push(
					"A scheduled trigger needs a recurrence from 1 minute to 1 year.",
				);
			}
		}
		if (trigger.type === "EVENT") {
			if (!trigger.event) {
				issues.push("An event trigger needs a supported CRM event.");
			} else if (eventTypes.has(trigger.event)) {
				issues.push(`The ${trigger.event} event is already a trigger.`);
			} else {
				eventTypes.add(trigger.event);
			}
			if (input.recordScope !== "WORKSPACE") {
				issues.push("Event triggers need workspace CRM scope.");
			}
		}
	}
	if (manualTriggers > 1) {
		issues.push("An agent needs at most one manual trigger.");
	}

	return {
		valid: issues.length === 0,
		issues,
		connections,
		capabilities: [...capabilities],
	};
}

type IntegrationResourceStatus = {
	available: boolean;
	issue: string | null;
};

function integrationResourceStatus(
	resource: BuilderResource,
	connections: Awaited<ReturnType<typeof connectionStatus>>,
): IntegrationResourceStatus {
	if (resource.id === "google:gmail") {
		return {
			available: true,
			issue: connections.gmail
				? null
				: "Gmail is not connected for the chat owner.",
		};
	}
	if (resource.id === "google:calendar") {
		return {
			available: true,
			issue: connections.calendar
				? null
				: "Google Calendar is not connected for the chat owner.",
		};
	}
	if (resource.id === "slack:workspace") {
		return {
			available: true,
			issue: connections.slack
				? null
				: "Slack is not connected for this workspace.",
		};
	}
	const mcpSlug = resource.id.startsWith("mcp:")
		? resource.id.slice("mcp:".length)
		: null;
	const available = connections.mcp.some(
		(entry) => entry.platformSlug === mcpSlug,
	);
	return {
		available,
		issue: available
			? null
			: `${resource.label} is not an available integration.`,
	};
}

async function connectionStatus(userId: string) {
	const [googleAccounts, slackAccount, workspaceMembers, mcpConnections] =
		await Promise.all([
			db
				.select({
					providerId: accountTable.providerId,
					scope: accountTable.scope,
				})
				.from(accountTable)
				.where(
					and(
						whereEq(accountTable.userId, userId),
						eq(accountTable.providerId, "google"),
					),
				),
			firstRow(
				db
					.select({ id: accountTable.id })
					.from(accountTable)
					.where(
						and(
							eq(accountTable.providerId, "slack"),
							isNotNull(accountTable.accessToken),
						),
					)
					.orderBy(desc(accountTable.updatedAt))
					.limit(1),
			),
			db
				.select({
					user: { name: user.name, email: user.email },
					match: {
						id: slackMemberMatch.id,
						slackUserId: slackMemberMatch.slackUserId,
						slackHandle: slackMemberMatch.slackHandle,
						slackEmail: slackMemberMatch.slackEmail,
					},
				})
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.leftJoin(slackMemberMatch, eq(slackMemberMatch.crmUserId, user.id))
				.where(eq(member.organizationId, WORKSPACE_ID))
				.orderBy(asc(user.name))
				.then((rows) =>
					rows.map((row) => ({
						user: {
							...row.user,
							slackMemberMatch: row.match
								? {
										slackUserId: row.match.slackUserId,
										slackHandle: row.match.slackHandle,
										slackEmail: row.match.slackEmail,
									}
								: null,
						},
					})),
				),
			db.query.mcpConnection.findMany({
				where: and(
					eq(mcpConnection.organizationId, WORKSPACE_ID),
					eq(mcpConnection.status, "CONNECTED"),
				),
				columns: { platformSlug: true, accessMode: true },
				with: {
					toolSnapshots: {
						orderBy: [desc(mcpToolSnapshot.createdAt)],
						columns: {
							name: true,
							description: true,
							fingerprint: true,
							callKind: true,
							reviewState: true,
						},
					},
				},
			}),
		]);
	if (slackAccount) void requestStaleSlackInventorySync();

	const slackChannels = await db
		.select({
			id: slackChannel.id,
			name: slackChannel.name,
			memberCount: slackChannel.memberCount,
		})
		.from(slackChannel)
		.where(eq(slackChannel.available, true))
		.orderBy(asc(slackChannel.name))
		.limit(100);
	const scopes = new Set(
		googleAccounts.flatMap((account) => (account.scope ?? "").split(/[,\s]+/)),
	);
	const slackPeople = workspaceMembers.flatMap(({ user }) => {
		const match = user.slackMemberMatch;
		return match?.slackUserId && match.slackHandle
			? [
					{
						id: match.slackUserId,
						label: match.slackHandle,
						name: user.name,
						email: user.email,
						slackEmail: match.slackEmail,
					},
				]
			: [];
	});

	return {
		gmail: scopes.has(GMAIL_SCOPE),
		calendar: scopes.has(CALENDAR_SCOPE),
		slack: Boolean(slackAccount),
		slackChannels: slackChannels.map((channel) => ({
			id: channel.id,
			label: `#${channel.name}`,
			memberCount: channel.memberCount,
		})),
		slackPeople,
		mcp: mcpConnections.map((connection) => {
			const latest = new Map<
				string,
				(typeof connection.toolSnapshots)[number]
			>();
			for (const tool of connection.toolSnapshots) {
				if (!latest.has(tool.name)) latest.set(tool.name, tool);
			}
			return {
				platformSlug: connection.platformSlug,
				label: connection.platformSlug,
				accessMode:
					connection.accessMode === "READ_ONLY" ? "read_only" : "read_write",
				tools: [...latest.values()].flatMap((tool) =>
					tool.reviewState === "REVIEWED" &&
					(tool.callKind === "read" ||
						tool.callKind === "change" ||
						tool.callKind === "risky")
						? [
								{
									name: tool.name,
									description: tool.description,
									fingerprint: tool.fingerprint,
									callKind: tool.callKind,
								},
							]
						: [],
				),
			};
		}),
		crm: true,
	};
}

function mcpGrantIssues(
	grants: AgentManifestMcpGrant[],
	resources: BuilderResource[],
	connections: Awaited<ReturnType<typeof connectionStatus>>["mcp"],
): string[] {
	const issues: string[] = [];
	const resourceIds = new Set(resources.map((resource) => resource.id));
	const seenPlatforms = new Set<string>();

	for (const grant of grants) {
		if (seenPlatforms.has(grant.platformSlug)) {
			issues.push(`${grant.platformSlug} is granted more than once.`);
			continue;
		}
		seenPlatforms.add(grant.platformSlug);
		if (!resourceIds.has(`mcp:${grant.platformSlug}`)) {
			issues.push(
				`${grant.platformSlug} tools need that platform in this agent's integrations.`,
			);
		}
		const connection = connections.find(
			(entry) => entry.platformSlug === grant.platformSlug,
		);
		if (!connection) {
			issues.push(`${grant.platformSlug} is not connected.`);
			continue;
		}
		const available = new Map(
			connection.tools.map((tool) => [tool.name, tool]),
		);
		const seenTools = new Set<string>();
		for (const tool of grant.tools) {
			if (seenTools.has(tool.name)) {
				issues.push(`${grant.platformSlug} tool ${tool.name} repeats.`);
				continue;
			}
			seenTools.add(tool.name);
			const current = available.get(tool.name);
			if (
				!current ||
				current.fingerprint !== tool.fingerprint ||
				current.callKind !== tool.callKind
			) {
				issues.push(
					`${grant.platformSlug} tool ${tool.name} changed or is unavailable.`,
				);
			}
			if (connection.accessMode === "read_only" && tool.callKind !== "read") {
				issues.push(
					`${grant.platformSlug} has read-only access to ${tool.name}.`,
				);
			}
		}
	}

	return issues;
}

type SlackConnections = Awaited<ReturnType<typeof connectionStatus>>;

export function actionIntegrationIssues(
	actions: DraftAction[],
	resources: BuilderResource[],
): string[] {
	const integrations = new Set(
		resources
			.filter((resource) => resource.kind === "integration")
			.map((resource) => resource.id),
	);

	return actions.flatMap((action) => {
		const dependency = actionDependency(action.type);
		if (!dependency || integrations.has(dependency.resourceId)) return [];
		return [
			`Posting to ${dependency.label} needs ${dependency.label} in this agent's integrations.`,
		];
	});
}

export function slackDestinationIssues(
	destination: Extract<
		DraftAction,
		{ type: typeof AGENT_ACTION_TYPES.SLACK_MESSAGE_POST }
	>["destination"],
	connections: Pick<SlackConnections, "slackChannels" | "slackPeople">,
): string[] {
	const noun = destination.kind === "user" ? "person" : "channel";
	const options =
		destination.kind === "user"
			? connections.slackPeople
			: connections.slackChannels;
	const option = options.find((entry) => entry.id === destination.id);
	if (!option) return [`The Slack ${noun} is not available to this workspace.`];
	if (option.label !== destination.label) {
		return [`The Slack ${noun} must use its exact inspected label.`];
	}
	return [];
}

async function describeResources(resources: BuilderResource[]) {
	return Promise.all(
		resources.map(async (resource) => {
			if (resource.kind === "company") {
				const row = await firstRow(
					db
						.select({
							id: company.id,
							name: company.name,
							domain: company.domain,
							industry: company.industry,
						})
						.from(company)
						.where(whereEq(company.id, resource.id))
						.limit(1),
				);
				return { ...resource, record: row };
			}
			if (resource.kind === "contact") {
				const row = await db.query.contact
					.findFirst({
						where: whereEq(contact.id, resource.id),
						columns: {
							id: true,
							firstName: true,
							lastName: true,
							email: true,
							title: true,
						},
						with: { company: { columns: { id: true, name: true } } },
					})
					.then(orNull);
				return { ...resource, record: row };
			}
			if (resource.kind === "deal") {
				const row = await db.query.deal
					.findFirst({
						where: whereEq(deal.id, resource.id),
						columns: {
							id: true,
							name: true,
							stage: true,
							amount: true,
							currency: true,
						},
						with: { company: { columns: { id: true, name: true } } },
					})
					.then(orNull);
				return {
					...resource,
					record: row
						? {
								...row,
								amount: row.amount === null ? null : Number(row.amount),
							}
						: null,
				};
			}
			return { ...resource, record: null };
		}),
	);
}

async function missingResourceIds(resources: BuilderResource[]) {
	const described = await describeResources(
		resources.filter((resource) => resource.kind !== "integration"),
	);
	return described.filter((resource) => !resource.record);
}

function resourcesOf(value: JsonValue): BuilderResource[] {
	return taggedResources
		.parse(value)
		.resources.filter((resource) => resource !== null);
}

function uniqueResources(resources: BuilderResource[]): BuilderResource[] {
	return [
		...new Map(
			resources.map((resource) => [
				`${resource.kind}:${resource.id}`,
				resource,
			]),
		).values(),
	];
}

function scheduleDate(trigger: DraftTrigger, now: Date): Date | null {
	if (trigger.type !== "SCHEDULE") return null;
	const parsed = new Date(trigger.nextRunAt ?? "");
	return parsed > now ? parsed : null;
}

function artifactFiles(input: DraftAgentInput, manifestJson: string) {
	const triggerSummary = input.triggers
		.map((trigger) => `- ${trigger.summary}`)
		.join("\n");
	return [
		{
			path: "agent/README.md" as const,
			language: ARTIFACT_LANGUAGES["agent/README.md"],
			content: `# ${input.name}\n\n${input.description}\n\n## Triggers\n\n${triggerSummary}\n\n## Access\n\n${input.access.map((item) => `- ${item}`).join("\n") || "- CRM data in the approved scope"}\n`,
		},
		{
			path: "agent/instructions.md" as const,
			language: ARTIFACT_LANGUAGES["agent/instructions.md"],
			content: `${input.instructions.trim()}\n`,
		},
		{
			path: "agent/manifest.json" as const,
			language: ARTIFACT_LANGUAGES["agent/manifest.json"],
			content: `${manifestJson}\n`,
		},
	];
}

function assertSafeArtifact(content: string): void {
	const secretPatterns = [
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
		/\b(?:api[_-]?key|password|secret|access[_-]?token)\b\s*[:=]\s*["']?[a-z0-9_./+=-]{12,}/i,
		/\b(?:sk|pk)_(?:live|test)_[a-z0-9]{16,}/i,
	];

	if (secretPatterns.some((pattern) => pattern.test(content))) {
		throw new Error("Agent files cannot contain credentials or secret values.");
	}
}

function scopeSummary(
	recordScope: DraftAgentInput["recordScope"],
	resources: BuilderResource[],
): string {
	const records = resources.filter(
		(resource) => resource.kind !== "integration",
	);
	if (recordScope === "WORKSPACE") return "Workspace CRM records";
	return records.map((resource) => resource.label).join(" · ");
}
