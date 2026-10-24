import {
	agentAuditEvent,
	agentBuilderArtifact,
	agentDefinition,
	agentRun,
	agentRunEvent,
	agentTrigger,
	agentVersion,
	and,
	asc,
	type Db,
	desc,
	type Executor,
	eq,
	inArray,
	type JsonValue,
	type NewAgentDefinition,
	ne,
	relatedCount,
	sql,
} from "@crm/db";
import type { AgentDefinitionStatus } from "@crm/db/enums";
import { schemas } from "@crm/validation";
import { readAgentManifestSummary } from "@crm/validation/agent-manifest";
import {
	BadRequestException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { AgentAccessService } from "./agent-access.service";
import { AgentTriggerService } from "./agent-trigger.service";
import { TEAM_AGENT_STATUSES } from "./agent-visibility";
import {
	type AgentDeployInput,
	type AgentReviseInput,
	type AgentSaveFileInput,
	type AgentUpdateInput,
	agentManifest,
} from "./agents.contracts";

const INSTRUCTIONS_PATH = "agent/instructions.md";

type VersionMetadata = {
	name?: string;
	description?: string | null;
};

const capabilityName = z.string().nullable().catch(null);

const versionValidation = z
	.object({ capabilities: z.array(z.json()).catch([]) })
	.catchall(z.json())
	.catch({ capabilities: [] });

@Injectable()
export class AgentDefinitionsService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly access: AgentAccessService,
		private readonly trigger: AgentTriggerService,
	) {}

	async list(userId: string) {
		await this.access.assertMember(userId);

		const rows = await this.db.query.agentDefinition.findMany({
			where: inArray(agentDefinition.status, [...TEAM_AGENT_STATUSES]),
			orderBy: [desc(agentDefinition.updatedAt)],
			columns: {
				id: true,
				name: true,
				description: true,
				status: true,
				createdAt: true,
				updatedAt: true,
			},
			extras: runCountExtra,
			with: {
				createdBy: { columns: { id: true, name: true, image: true } },
				currentVersion: {
					columns: { id: true, number: true, deployedAt: true },
				},
				triggers: {
					where: eq(agentTrigger.enabled, true),
					orderBy: [asc(agentTrigger.nextRunAt)],
					limit: 1,
					columns: { id: true, type: true, name: true, nextRunAt: true },
				},
			},
		});

		return rows.map((row) => ({
			...row,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			currentVersion: row.currentVersion
				? {
						...row.currentVersion,
						deployedAt: row.currentVersion.deployedAt?.toISOString() ?? null,
					}
				: null,
			triggers: row.triggers.map((trigger) => ({
				...trigger,
				nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
			})),
			runCount: row.runCount,
		}));
	}

	async byId(id: string, userId: string) {
		await this.access.assertCanRead(id, userId);

		const row = await this.db.query.agentDefinition.findFirst({
			where: and(
				eq(agentDefinition.id, id),
				ne(agentDefinition.status, "DELETED"),
			),
			columns: {
				id: true,
				name: true,
				description: true,
				status: true,
				createdById: true,
				createdAt: true,
				updatedAt: true,
			},
			extras: runCountExtra,
			with: {
				createdBy: { columns: { id: true, name: true, image: true } },
				currentVersion: {
					columns: {
						id: true,
						number: true,
						status: true,
						manifest: true,
						modelId: true,
						sandboxPolicy: true,
						approvedAt: true,
						deployedAt: true,
					},
				},
				versions: {
					where: inArray(agentVersion.status, ["DRAFT", "READY"]),
					orderBy: [desc(agentVersion.number)],
					limit: 1,
					columns: {
						id: true,
						number: true,
						status: true,
						manifest: true,
						modelId: true,
						sandboxPolicy: true,
						sourceConversationId: true,
					},
				},
				triggers: {
					orderBy: [asc(agentTrigger.createdAt)],
					columns: {
						id: true,
						type: true,
						name: true,
						config: true,
						enabled: true,
						nextRunAt: true,
						lastRunAt: true,
					},
				},
			},
		});

		if (!row) throw new NotFoundException(`No agent with id ${id}.`);
		const { versions, ...agent } = row;
		const draft = versions[0];

		return {
			...agent,
			canManage: agent.createdById === userId || (await this.canAdmin(userId)),
			createdAt: agent.createdAt.toISOString(),
			updatedAt: agent.updatedAt.toISOString(),
			currentVersion: agent.currentVersion
				? {
						...agent.currentVersion,
						approvedAt: agent.currentVersion.approvedAt?.toISOString() ?? null,
						deployedAt: agent.currentVersion.deployedAt?.toISOString() ?? null,
					}
				: null,
			reviewVersion:
				agent.status === "DRAFT" && draft
					? { ...draft, manifest: readAgentManifestSummary(draft.manifest) }
					: null,
			triggers: agent.triggers.map((trigger) => ({
				...trigger,
				nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
				lastRunAt: trigger.lastRunAt?.toISOString() ?? null,
			})),
			runCount: agent.runCount,
			capabilities: readCapabilities(
				agent.currentVersion?.manifest ?? draft?.manifest,
			),
		};
	}

	async update(input: AgentUpdateInput, userId: string) {
		const description = input.description?.trim() || null;

		const updated = await this.db.transaction(async (tx) => {
			await this.access.assertCanManageInTransaction(tx, input.id, userId);
			const agent = await this.lockAgent(tx, input.id);
			const [row] = await tx
				.update(agentDefinition)
				.set({ name: input.name, description })
				.where(eq(agentDefinition.id, input.id))
				.returning({
					id: agentDefinition.id,
					name: agentDefinition.name,
					description: agentDefinition.description,
					status: agentDefinition.status,
				});
			if (!row) throw new NotFoundException(`No agent with id ${input.id}.`);

			await tx.insert(agentAuditEvent).values({
				agentId: input.id,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type: "agent.updated",
				summary: "Changed agent details",
				before: { name: agent.name, description: agent.description },
				after: { name: input.name, description },
			});

			return row;
		});

		return updated;
	}

	async files(id: string, userId: string) {
		await this.access.assertCanRead(id, userId);

		const [agent] = await this.db
			.select({ currentVersionId: agentDefinition.currentVersionId })
			.from(agentDefinition)
			.where(
				and(eq(agentDefinition.id, id), ne(agentDefinition.status, "DELETED")),
			)
			.limit(1);
		if (!agent?.currentVersionId) return { versionId: null, files: [] };

		const rows = await this.db
			.select({
				path: agentBuilderArtifact.path,
				language: agentBuilderArtifact.language,
				content: agentBuilderArtifact.content,
				previousContent: agentBuilderArtifact.previousContent,
				revision: agentBuilderArtifact.revision,
			})
			.from(agentBuilderArtifact)
			.where(eq(agentBuilderArtifact.versionId, agent.currentVersionId))
			.orderBy(
				asc(agentBuilderArtifact.path),
				desc(agentBuilderArtifact.revision),
			);

		const latest = new Map<string, (typeof rows)[number]>();
		for (const row of rows)
			if (!latest.has(row.path)) latest.set(row.path, row);

		return {
			versionId: agent.currentVersionId,
			files: [...latest.values()],
		};
	}

	async saveFile(input: AgentSaveFileInput, userId: string) {
		return this.db.transaction(async (tx) => {
			await this.access.assertCanManageInTransaction(tx, input.id, userId);
			const agent = await this.lockAgent(tx, input.id);

			const replay = await auditReplay(
				tx,
				input.id,
				"agent.file.saved",
				input.clientRequestId,
			);
			if (replay) return { saved: false, versionId: replay.versionId };

			if (!agent.currentVersionId) {
				throw new BadRequestException("This agent has no deployed version.");
			}

			const current = await currentVersion(tx, agent.currentVersionId);

			const [file] = await tx
				.select()
				.from(agentBuilderArtifact)
				.where(
					and(
						eq(agentBuilderArtifact.versionId, agent.currentVersionId),
						eq(agentBuilderArtifact.path, input.path),
					),
				)
				.orderBy(desc(agentBuilderArtifact.revision))
				.limit(1);
			if (!file) throw new NotFoundException(`No file at ${input.path}.`);
			if (file.content === input.content) {
				return { saved: false, versionId: agent.currentVersionId };
			}

			const version = await createVersion(tx, {
				agentId: input.id,
				number: await nextVersionNumber(tx, input.id),
				status: current.status,
				instructions:
					input.path === INSTRUCTIONS_PATH
						? input.content
						: current.instructions,
				manifest: current.manifest,
				modelId: current.modelId,
				modelContextWindowTokens: current.modelContextWindowTokens,
				sandboxPolicy: current.sandboxPolicy,
				validation: current.validation,
				sourceConversationId: current.sourceConversationId,
				approvedAt: current.approvedAt,
				deployedAt: current.deployedAt,
				createdById: userId,
			});

			await carryArtifactsForward(tx, agent.currentVersionId, version.id);

			await tx
				.update(agentBuilderArtifact)
				.set({ previousContent: file.content, content: input.content })
				.where(
					and(
						eq(agentBuilderArtifact.versionId, version.id),
						eq(agentBuilderArtifact.path, input.path),
					),
				);

			await tx
				.update(agentDefinition)
				.set({ currentVersionId: version.id })
				.where(eq(agentDefinition.id, input.id));

			const repointed = await repointTriggers(
				tx,
				input.id,
				agent.currentVersionId,
				version.id,
			);

			await tx.insert(agentAuditEvent).values({
				agentId: input.id,
				versionId: version.id,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type: "agent.file.saved",
				summary: `Edited ${input.path}`,
				before: { path: input.path, bytes: file.content.length },
				after: {
					path: input.path,
					bytes: input.content.length,
					triggers: repointed,
				},
				requestId: input.clientRequestId,
			});

			return { saved: true, versionId: version.id };
		});
	}

	async revise(input: AgentReviseInput, userId: string) {
		const versionId = await this.trigger.withTasks(async (tx, queue) => {
			await this.access.assertCanManageInTransaction(tx, input.id, userId);
			const agent = await this.lockAgent(tx, input.id);

			const replay = await auditReplay(
				tx,
				input.id,
				"agent.revised",
				input.clientRequestId,
			);
			if (replay) return replay.versionId;

			if (!agent.currentVersionId) {
				throw new BadRequestException("This agent has no deployed version.");
			}

			const current = await currentVersion(tx, agent.currentVersionId);

			const parsed = agentManifest.safeParse(current.manifest);
			if (!parsed.success) {
				throw new BadRequestException(
					"This version's manifest cannot be read, so it cannot be changed.",
				);
			}

			const manifest = parsed.data;
			const before = manifest.actions.find(
				(action) => action.destination !== undefined,
			);

			let actions = manifest.actions;

			if (input.actions) {
				const keep = new Set(input.actions);
				actions = actions.filter((action) => keep.has(action.type));
				if (actions.length === 0) {
					throw new BadRequestException("An agent needs at least one action.");
				}
			}

			const channel = input.channel;

			if (channel) {
				if (!actions.some((action) => action.destination !== undefined)) {
					throw new BadRequestException(
						"None of this agent's actions post to a channel, so its channel cannot be changed.",
					);
				}

				actions = actions.map((action) =>
					action.destination
						? {
								...action,
								destination: {
									...action.destination,
									id: channel.id,
									label: `#${channel.name}`,
								},
							}
						: action,
				);
			}

			const dataScope = input.resources
				? {
						...manifest.dataScope,
						mode: input.resources.length > 0 ? "SELECTED" : "WORKSPACE",
						resources: input.resources,
					}
				: manifest.dataScope;

			const version = await createVersion(tx, {
				agentId: input.id,
				number: await nextVersionNumber(tx, input.id),
				status: current.status,
				instructions: current.instructions,
				manifest: {
					...manifest,
					actions,
					dataScope,
				} as JsonValue,
				modelId: current.modelId,
				modelContextWindowTokens: current.modelContextWindowTokens,
				sandboxPolicy: current.sandboxPolicy,
				validation: reviseValidation(
					current.validation,
					manifest.actions.map((action) => action.type),
					actions.map((action) => action.type),
				),
				sourceConversationId: current.sourceConversationId,
				approvedAt: current.approvedAt,
				deployedAt: current.deployedAt,
				createdById: userId,
			});

			await carryArtifactsForward(tx, agent.currentVersionId, version.id);

			await tx
				.update(agentDefinition)
				.set({ currentVersionId: version.id })
				.where(eq(agentDefinition.id, input.id));

			const repointed = await repointTriggers(
				tx,
				input.id,
				agent.currentVersionId,
				version.id,
			);

			if (channel && channel.id !== before?.destination?.id) {
				await queue.slackChannelJoinRequested(channel.id, channel.name);
			}

			await tx.insert(agentAuditEvent).values({
				agentId: input.id,
				versionId: version.id,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type: "agent.revised",
				summary: reviseSummary(input),
				before: {
					channel: before?.destination?.label ?? null,
					actions: manifest.actions.map((action) => action.type),
					resources: manifest.dataScope.resources.length,
				},
				after: {
					channel: channel ? `#${channel.name}` : null,
					actions: input.actions ?? null,
					resources: input.resources?.length ?? null,
					triggers: repointed,
				},
				requestId: input.clientRequestId,
			});

			return version.id;
		});

		return { versionId };
	}

	async deploy(input: AgentDeployInput, userId: string) {
		return this.db.transaction(async (tx) => {
			await this.access.assertCanManageInTransaction(tx, input.id, userId);
			const agent = await this.lockAgent(tx, input.id);
			const existing = await auditReplay(
				tx,
				input.id,
				"agent.deployed",
				input.clientRequestId,
			);

			if (existing) {
				if (existing.versionId !== input.versionId) {
					throw new BadRequestException(
						"That deployment request has already been used.",
					);
				}

				return { id: input.id, versionId: input.versionId, status: "LIVE" };
			}

			const [version] = await tx
				.select({
					id: agentVersion.id,
					number: agentVersion.number,
					status: agentVersion.status,
					manifest: agentVersion.manifest,
				})
				.from(agentVersion)
				.where(
					and(
						eq(agentVersion.id, input.versionId),
						eq(agentVersion.agentId, input.id),
					),
				)
				.limit(1);

			if (!version) {
				throw new NotFoundException(`No version with id ${input.versionId}.`);
			}

			if (version.status !== "READY" && version.status !== "DEPLOYED") {
				throw new BadRequestException(
					"Only a validated agent version can be deployed.",
				);
			}
			const metadata = versionMetadata(version.manifest);

			const now = new Date();
			await tx
				.update(agentVersion)
				.set({ status: "READY" })
				.where(
					and(
						eq(agentVersion.agentId, input.id),
						eq(agentVersion.status, "DEPLOYED"),
						ne(agentVersion.id, input.versionId),
					),
				);

			await tx
				.update(agentVersion)
				.set({ status: "DEPLOYED", approvedAt: now, deployedAt: now })
				.where(eq(agentVersion.id, input.versionId));

			await tx
				.update(agentDefinition)
				.set({
					currentVersionId: input.versionId,
					status: "LIVE",
					archivedAt: null,
					...metadata,
				})
				.where(eq(agentDefinition.id, input.id));

			await tx
				.update(agentTrigger)
				.set({ enabled: false })
				.where(eq(agentTrigger.agentId, input.id));

			await tx
				.update(agentTrigger)
				.set({ enabled: true })
				.where(
					and(
						eq(agentTrigger.agentId, input.id),
						eq(agentTrigger.versionId, input.versionId),
					),
				);

			await tx.insert(agentAuditEvent).values({
				agentId: input.id,
				versionId: input.versionId,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type: "agent.deployed",
				summary: `Made version ${version.number} live for the team`,
				before: { status: agent.status },
				after: { status: "LIVE", version: version.number, ...metadata },
				requestId: input.clientRequestId,
			});

			return { id: input.id, versionId: input.versionId, status: "LIVE" };
		});
	}

	async pause(id: string, userId: string) {
		return this.changeStatus(
			id,
			userId,
			["LIVE"],
			"PAUSED",
			"agent.paused",
			"Paused agent",
			"Only a live agent can be paused.",
		);
	}

	async resume(id: string, userId: string) {
		return this.changeStatus(
			id,
			userId,
			["PAUSED"],
			"LIVE",
			"agent.resumed",
			"Resumed agent",
			"Only a paused agent can be resumed.",
		);
	}

	async archive(id: string, userId: string) {
		return this.changeStatus(
			id,
			userId,
			["LIVE", "PAUSED"],
			"ARCHIVED",
			"agent.archived",
			"Archived agent",
			"Only a live or paused agent can be archived.",
			{ archivedAt: new Date() },
		);
	}

	async restore(id: string, userId: string) {
		return this.changeStatus(
			id,
			userId,
			["ARCHIVED"],
			"PAUSED",
			"agent.restored",
			"Restored agent",
			"Only an archived agent can be restored.",
			{ archivedAt: null },
		);
	}

	async remove(id: string, userId: string) {
		const now = new Date();

		return this.db.transaction(async (tx) => {
			await this.access.assertCanManageInTransaction(tx, id, userId);
			const [current] = await tx
				.select({ id: agentDefinition.id, status: agentDefinition.status })
				.from(agentDefinition)
				.where(eq(agentDefinition.id, id))
				.for("update");

			if (!current || current.status === "DELETED") {
				throw new NotFoundException(`No agent with id ${id}.`);
			}

			const disabledTriggers = (
				await tx
					.update(agentTrigger)
					.set({ enabled: false, nextRunAt: null })
					.where(
						and(eq(agentTrigger.agentId, id), eq(agentTrigger.enabled, true)),
					)
					.returning({ id: agentTrigger.id })
			).length;

			const cancellableRuns = await tx
				.select({ id: agentRun.id })
				.from(agentRun)
				.where(
					and(
						eq(agentRun.agentId, id),
						sql`(${agentRun.status} IN ('QUEUED', 'WAITING_FOR_APPROVAL') OR (${agentRun.status} = 'RUNNING' AND ${agentRun.sessionId} IS NULL))`,
					),
				)
				.orderBy(asc(agentRun.id))
				.for("update");

			for (const run of cancellableRuns) {
				const [cancelled] = await tx
					.update(agentRun)
					.set({
						status: "CANCELLED",
						finishedAt: now,
						errorCode: "AGENT_DELETED",
						errorMessage: "The agent was deleted before this run completed.",
						nextEventSequence: sql`${agentRun.nextEventSequence} + 1`,
					})
					.where(eq(agentRun.id, run.id))
					.returning({ nextEventSequence: agentRun.nextEventSequence });
				if (!cancelled) continue;

				await tx.insert(agentRunEvent).values({
					runId: run.id,
					sequence: cancelled.nextEventSequence,
					type: "run.cancelled",
					data: { reason: "agent.deleted" },
					emittedAt: now,
				});
			}

			const [agent] = await tx
				.update(agentDefinition)
				.set({ status: "DELETED", deletedAt: now })
				.where(eq(agentDefinition.id, id))
				.returning({
					id: agentDefinition.id,
					name: agentDefinition.name,
					status: agentDefinition.status,
					updatedAt: agentDefinition.updatedAt,
				});
			if (!agent) throw new NotFoundException(`No agent with id ${id}.`);

			await tx.insert(agentAuditEvent).values({
				agentId: id,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type: "agent.deleted",
				summary: "Deleted agent",
				before: { status: current.status },
				after: {
					status: "DELETED",
					disabledTriggers,
					cancelledRuns: cancellableRuns.length,
				},
			});

			return {
				...agent,
				updatedAt: agent.updatedAt.toISOString(),
				disabledTriggers,
				cancelledRuns: cancellableRuns.length,
			};
		});
	}

	private async changeStatus(
		id: string,
		userId: string,
		allowedFrom: readonly AgentDefinitionStatus[],
		status: "LIVE" | "PAUSED" | "ARCHIVED",
		type: string,
		summary: string,
		invalidStatusMessage: string,
		extra: Partial<NewAgentDefinition> = {},
	) {
		return this.db.transaction(async (tx) => {
			await this.access.assertCanManageInTransaction(tx, id, userId);
			const before = await this.lockAgent(tx, id);
			if (!allowedFrom.includes(before.status)) {
				throw new BadRequestException(invalidStatusMessage);
			}

			const [agent] = await tx
				.update(agentDefinition)
				.set({ status, ...extra })
				.where(eq(agentDefinition.id, id))
				.returning({
					id: agentDefinition.id,
					name: agentDefinition.name,
					status: agentDefinition.status,
					updatedAt: agentDefinition.updatedAt,
				});
			if (!agent) throw new NotFoundException(`No agent with id ${id}.`);

			await tx.insert(agentAuditEvent).values({
				agentId: id,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type,
				summary,
				before: { status: before.status },
				after: { status },
			});

			return { ...agent, updatedAt: agent.updatedAt.toISOString() };
		});
	}

	private async lockAgent(tx: Executor, id: string) {
		const [agent] = await tx
			.select({
				id: agentDefinition.id,
				status: agentDefinition.status,
				name: agentDefinition.name,
				description: agentDefinition.description,
				currentVersionId: agentDefinition.currentVersionId,
			})
			.from(agentDefinition)
			.where(eq(agentDefinition.id, id))
			.for("update");

		if (!agent || agent.status === "DELETED") {
			throw new NotFoundException(`No agent with id ${id}.`);
		}

		return agent;
	}

	private async canAdmin(userId: string): Promise<boolean> {
		const role = await this.access.assertMember(userId);
		return role === "owner" || role === "admin";
	}
}

function versionMetadata(manifest: JsonValue): VersionMetadata {
	const summary = readAgentManifestSummary(manifest);
	const name = summary.name?.trim() ?? "";
	const description =
		summary.description === undefined
			? undefined
			: summary.description.trim() || null;

	const metadata: VersionMetadata = {};
	if (name) metadata.name = name;
	if (description !== undefined) metadata.description = description;

	return metadata;
}

function readCapabilities(manifest: JsonValue | undefined) {
	const parsed = schemas.agents.capabilities.safeParse(manifest);

	if (!parsed.success) {
		return {
			readable: false as const,
			problem: parsed.error.issues
				.map(
					(issue) => `${issue.path.join(".") || "manifest"} ${issue.message}`,
				)
				.join("; "),
			actions: [],
			mcp: [],
			dataScope: null,
			channel: null,
		};
	}

	const slack = parsed.data.actions.find(
		(action) => action.destination !== undefined,
	);

	return {
		readable: true as const,
		problem: null,
		actions: parsed.data.actions,
		mcp: parsed.data.mcp,
		dataScope: parsed.data.dataScope,
		channel: slack?.destination ?? null,
	};
}

function reviseSummary(input: {
	channel?: { name: string };
	actions?: string[];
	resources?: unknown[];
}): string {
	const parts: string[] = [];
	if (input.channel) parts.push(`moved to #${input.channel.name}`);
	if (input.actions) parts.push(`${input.actions.length} actions`);
	if (input.resources) parts.push(`${input.resources.length} records`);
	return parts.length > 0 ? `Changed ${parts.join(", ")}` : "Changed settings";
}

function reviseValidation(
	validation: JsonValue,
	before: string[],
	after: string[],
): JsonValue {
	const removed = before.filter((type) => !after.includes(type));
	const base = versionValidation.parse(validation);

	const capabilities = base.capabilities.flatMap((entry) => {
		const name = capabilityName.parse(entry);
		return name !== null && !removed.includes(name) ? [name] : [];
	});

	return {
		...base,
		status: "passed",
		checkedAt: new Date().toISOString(),
		capabilities,
	};
}

const runCountExtra = (agent: { id: typeof agentDefinition.id }) => ({
	runCount: relatedCount(agentRun, agentRun.agentId, agent.id).as("runCount"),
});

async function auditReplay(
	tx: Executor,
	agentId: string,
	type: string,
	requestId: string,
) {
	const [row] = await tx
		.select({ versionId: agentAuditEvent.versionId })
		.from(agentAuditEvent)
		.where(
			and(
				eq(agentAuditEvent.agentId, agentId),
				eq(agentAuditEvent.type, type),
				eq(agentAuditEvent.requestId, requestId),
			),
		)
		.limit(1);
	return row ?? null;
}

async function currentVersion(tx: Executor, id: string) {
	const [row] = await tx
		.select({
			status: agentVersion.status,
			instructions: agentVersion.instructions,
			manifest: agentVersion.manifest,
			modelId: agentVersion.modelId,
			modelContextWindowTokens: agentVersion.modelContextWindowTokens,
			sandboxPolicy: agentVersion.sandboxPolicy,
			validation: agentVersion.validation,
			sourceConversationId: agentVersion.sourceConversationId,
			deployedAt: agentVersion.deployedAt,
			approvedAt: agentVersion.approvedAt,
		})
		.from(agentVersion)
		.where(eq(agentVersion.id, id))
		.limit(1);
	if (!row) throw new NotFoundException(`No version with id ${id}.`);
	return row;
}

async function createVersion(
	tx: Executor,
	values: typeof agentVersion.$inferInsert,
): Promise<{ id: string }> {
	const [row] = await tx
		.insert(agentVersion)
		.values(values)
		.returning({ id: agentVersion.id });
	if (!row) throw new Error("The version insert returned no row.");
	return row;
}

async function repointTriggers(
	tx: Executor,
	agentId: string,
	fromVersionId: string,
	toVersionId: string,
): Promise<number> {
	const rows = await tx
		.update(agentTrigger)
		.set({ versionId: toVersionId })
		.where(
			and(
				eq(agentTrigger.agentId, agentId),
				eq(agentTrigger.versionId, fromVersionId),
			),
		)
		.returning({ id: agentTrigger.id });
	return rows.length;
}

async function nextVersionNumber(
	tx: Executor,
	agentId: string,
): Promise<number> {
	const [latest] = await tx
		.select({ number: agentVersion.number })
		.from(agentVersion)
		.where(eq(agentVersion.agentId, agentId))
		.orderBy(desc(agentVersion.number))
		.limit(1);

	return (latest?.number ?? 0) + 1;
}

async function carryArtifactsForward(
	tx: Executor,
	fromVersionId: string,
	toVersionId: string,
): Promise<void> {
	const rows = await tx
		.select()
		.from(agentBuilderArtifact)
		.where(eq(agentBuilderArtifact.versionId, fromVersionId))
		.orderBy(
			asc(agentBuilderArtifact.path),
			desc(agentBuilderArtifact.revision),
		);

	const latest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) if (!latest.has(row.path)) latest.set(row.path, row);

	if (latest.size === 0) return;

	await tx.insert(agentBuilderArtifact).values(
		[...latest.values()].map((row) => ({
			versionId: toVersionId,
			path: row.path,
			language: row.language,
			content: row.content,
			previousContent: row.previousContent,
			revision: row.revision,
			status: row.status,
		})),
	);
}
