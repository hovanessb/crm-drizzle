import { randomUUID } from "node:crypto";
import {
	agentAction,
	agentAuditEvent,
	agentDefinition,
	agentRun,
	agentRunEvent,
	and,
	asc,
	type Db,
	desc,
	type Executor,
	eq,
	inArray,
	relatedCount,
} from "@crm/db";
import type { AgentRunStatus } from "@crm/db/enums";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { AgentAccessService } from "./agent-access.service";
import { AGENT_DISPATCH } from "./agent-dispatch.config";
import { AgentTriggerService } from "./agent-trigger.service";
import type {
	AgentCancelRunInput,
	AgentRetryRunInput,
	AgentRunNowInput,
} from "./agents.contracts";

const CANCELLABLE_STATUSES: readonly AgentRunStatus[] = [
	"QUEUED",
	"RUNNING",
	"WAITING_FOR_APPROVAL",
];

const RUN_EVENT_LIMIT = 200;

@Injectable()
export class AgentRunsService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly access: AgentAccessService,
		private readonly trigger: AgentTriggerService,
	) {}

	async list(agentId: string, limit: number, userId: string) {
		const agent = await this.readableAgent(agentId, userId);

		const rows = await this.db.query.agentRun.findMany({
			where: eq(agentRun.agentId, agentId),
			orderBy: [desc(agentRun.createdAt)],
			limit,
			extras: (run: { id: typeof agentRun.id }) => ({
				totalEvents: relatedCount(
					agentRunEvent,
					agentRunEvent.runId,
					run.id,
				).as("totalEvents"),
			}),
			columns: {
				id: true,
				status: true,
				triggerType: true,
				summary: true,
				modelId: true,
				inputTokens: true,
				outputTokens: true,
				costUsd: true,
				errorCode: true,
				errorMessage: true,
				createdAt: true,
				startedAt: true,
				finishedAt: true,
			},
			with: {
				initiatedBy: { columns: { id: true, name: true, image: true } },
				version: { columns: { id: true, number: true } },
				events: {
					orderBy: [asc(agentRunEvent.sequence)],
					limit: RUN_EVENT_LIMIT,
					columns: {
						id: true,
						sequence: true,
						type: true,
						data: true,
						emittedAt: true,
					},
				},
				actions: {
					orderBy: [asc(agentAction.plannedAt)],
					columns: {
						id: true,
						type: true,
						provider: true,
						targetType: true,
						targetId: true,
						targetLabel: true,
						summary: true,
						status: true,
						externalId: true,
						attemptCount: true,
						errorCode: true,
						errorMessage: true,
						plannedAt: true,
						startedAt: true,
						completedAt: true,
					},
				},
			},
		});

		return rows.map((run) => ({
			...run,
			totalEvents: run.totalEvents,
			eventsTruncated: run.totalEvents > run.events.length,
			canCancel:
				CANCELLABLE_STATUSES.includes(run.status) &&
				(agent.canManage || run.initiatedBy?.id === userId),
			costUsd: run.costUsd?.toString() ?? null,
			createdAt: run.createdAt.toISOString(),
			startedAt: run.startedAt?.toISOString() ?? null,
			finishedAt: run.finishedAt?.toISOString() ?? null,
			events: run.events.map((event) => ({
				...event,
				emittedAt: event.emittedAt.toISOString(),
			})),
			actions: run.actions.map((action) => ({
				...action,
				plannedAt: action.plannedAt.toISOString(),
				startedAt: action.startedAt?.toISOString() ?? null,
				completedAt: action.completedAt?.toISOString() ?? null,
			})),
		}));
	}

	async activity(agentId: string, limit: number, userId: string) {
		await this.readableAgent(agentId, userId);

		const rows = await this.db.query.agentAuditEvent.findMany({
			where: eq(agentAuditEvent.agentId, agentId),
			orderBy: [desc(agentAuditEvent.emittedAt)],
			limit,
			columns: {
				id: true,
				type: true,
				summary: true,
				before: true,
				after: true,
				requestId: true,
				emittedAt: true,
				actorType: true,
				actorId: true,
			},
			with: {
				actorUser: { columns: { id: true, name: true, image: true } },
				version: { columns: { id: true, number: true } },
			},
		});

		return rows.map((event) => ({
			...event,
			emittedAt: event.emittedAt.toISOString(),
		}));
	}

	async runNow(input: AgentRunNowInput, userId: string) {
		await this.access.assertMember(userId);
		const existing = await runByKey(this.db, input.clientRequestId);

		if (existing) {
			this.assertReplayMatches(existing.agentId, input.id);
			this.trigger.deployedAgentRunQueued();
			return { id: existing.id };
		}

		const run = await this.db.transaction(async (tx) => {
			await lockIdempotencyKey(tx, input.clientRequestId);
			const replay = await runByKey(tx, input.clientRequestId);
			if (replay) {
				this.assertReplayMatches(replay.agentId, input.id);
				return { id: replay.id };
			}

			const agent = await lockAgent(tx, input.id);

			if (!agent || agent.status === "DELETED") {
				throw new NotFoundException(`No agent with id ${input.id}.`);
			}

			if (agent.status !== "LIVE" || !agent.currentVersionId) {
				throw new BadRequestException("This agent is not live yet.");
			}

			await assertNoActiveRun(tx, input.id);

			const created = await createRun(tx, {
				agentId: input.id,
				versionId: agent.currentVersionId,
				initiatedById: userId,
				triggerType: "MANUAL",
				idempotencyKey: input.clientRequestId,
				correlationId: randomUUID(),
			});

			await tx.insert(agentAuditEvent).values({
				agentId: input.id,
				versionId: agent.currentVersionId,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type: "run.requested",
				summary: "Requested a manual run",
				requestId: input.clientRequestId,
			});

			return created;
		});

		this.trigger.deployedAgentRunQueued();
		return run;
	}

	async retryRun(input: AgentRetryRunInput, userId: string) {
		await this.access.assertMember(userId);

		const run = await this.db.transaction(async (tx) => {
			await lockIdempotencyKey(tx, input.clientRequestId);
			const replay = await runByKey(tx, input.clientRequestId);
			if (replay) {
				this.assertReplayMatches(replay.agentId, input.id);
				return { id: replay.id };
			}

			const [previous] = await tx
				.select({
					agentId: agentRun.agentId,
					status: agentRun.status,
					versionId: agentRun.versionId,
					triggerId: agentRun.triggerId,
					triggerType: agentRun.triggerType,
					input: agentRun.input,
				})
				.from(agentRun)
				.where(eq(agentRun.id, input.runId))
				.limit(1);
			if (!previous || previous.agentId !== input.id) {
				throw new NotFoundException(`No run with id ${input.runId}.`);
			}
			if (CANCELLABLE_STATUSES.includes(previous.status)) {
				throw new ConflictException("This run has not finished yet.");
			}

			const agent = await lockAgent(tx, input.id);
			if (!agent || agent.status === "DELETED") {
				throw new NotFoundException(`No agent with id ${input.id}.`);
			}
			if (agent.status !== "LIVE" || !agent.currentVersionId) {
				throw new BadRequestException("This agent is not live yet.");
			}

			await assertNoActiveRun(tx, input.id);

			const created = await createRun(tx, {
				agentId: input.id,
				versionId: previous.versionId,
				initiatedById: userId,
				triggerId: previous.triggerId,
				triggerType: previous.triggerType,
				input: previous.input,
				idempotencyKey: input.clientRequestId,
				correlationId: randomUUID(),
			});

			await tx.insert(agentAuditEvent).values({
				agentId: input.id,
				versionId: previous.versionId,
				actorUserId: userId,
				actorType: "USER",
				actorId: userId,
				type: "run.requested",
				summary: `Retried run ${input.runId}`,
				requestId: input.clientRequestId,
			});

			return created;
		});

		this.trigger.deployedAgentRunQueued();
		return run;
	}

	async cancelRun(input: AgentCancelRunInput, userId: string) {
		const agent = await this.readableAgent(input.id, userId);

		const outcome = await this.db.transaction(async (tx) => {
			const [run] = await tx
				.select({
					id: agentRun.id,
					agentId: agentRun.agentId,
					versionId: agentRun.versionId,
					status: agentRun.status,
					initiatedById: agentRun.initiatedById,
					nextEventSequence: agentRun.nextEventSequence,
				})
				.from(agentRun)
				.where(eq(agentRun.id, input.runId))
				.for("update");

			if (!run || run.agentId !== input.id) {
				throw new NotFoundException(`No run with id ${input.runId}.`);
			}

			if (!agent.canManage && run.initiatedById !== userId) {
				throw new ForbiddenException(
					"Only the person who started this run, or a workspace admin, can stop it.",
				);
			}

			if (!CANCELLABLE_STATUSES.includes(run.status)) {
				return { id: run.id, status: run.status, cancelled: false };
			}

			const sequence = run.nextEventSequence + 1;
			const finishedAt = new Date();

			await tx
				.update(agentRun)
				.set({
					status: "CANCELLED",
					errorCode: AGENT_DISPATCH.cancel.errorCode,
					errorMessage: AGENT_DISPATCH.cancel.message,
					finishedAt,
					nextEventSequence: sequence,
				})
				.where(eq(agentRun.id, run.id));

			await tx
				.update(agentAction)
				.set({
					status: "CANCELLED",
					errorCode: AGENT_DISPATCH.cancel.errorCode,
					errorMessage: AGENT_DISPATCH.cancel.message,
					completedAt: finishedAt,
				})
				.where(
					and(
						eq(agentAction.runId, run.id),
						inArray(agentAction.status, ["PLANNED", "RUNNING"]),
					),
				);

			await tx.insert(agentRunEvent).values({
				id: `run-terminal:${run.id}:cancelled`,
				runId: run.id,
				sequence,
				type: "run.cancelled",
				data: { reason: "user.cancelled" },
				emittedAt: finishedAt,
			});

			await tx
				.insert(agentAuditEvent)
				.values({
					agentId: run.agentId,
					versionId: run.versionId,
					actorUserId: userId,
					actorType: "USER",
					actorId: userId,
					type: "run.cancelled",
					summary: "Stopped a run",
					requestId: run.id,
				})
				.onConflictDoNothing({
					target: [
						agentAuditEvent.agentId,
						agentAuditEvent.type,
						agentAuditEvent.requestId,
					],
				});

			return { id: run.id, status: "CANCELLED" as const, cancelled: true };
		});

		if (outcome.cancelled) {
			this.trigger.deployedAgentRunCancelled(outcome.id);
		}

		return outcome;
	}

	private async readableAgent(agentId: string, userId: string) {
		return this.access.assertCanRead(agentId, userId);
	}

	private assertReplayMatches(
		existingAgentId: string,
		requestedAgentId: string,
	) {
		if (existingAgentId !== requestedAgentId) {
			throw new BadRequestException("That run request has already been used.");
		}
	}
}

async function runByKey(client: Executor, idempotencyKey: string) {
	const [row] = await client
		.select({ id: agentRun.id, agentId: agentRun.agentId })
		.from(agentRun)
		.where(eq(agentRun.idempotencyKey, idempotencyKey))
		.limit(1);
	return row ?? null;
}

async function lockAgent(tx: Executor, id: string) {
	const [agent] = await tx
		.select({
			id: agentDefinition.id,
			status: agentDefinition.status,
			currentVersionId: agentDefinition.currentVersionId,
		})
		.from(agentDefinition)
		.where(eq(agentDefinition.id, id))
		.for("update");
	return agent;
}

async function assertNoActiveRun(tx: Executor, agentId: string): Promise<void> {
	const [active] = await tx
		.select({ id: agentRun.id })
		.from(agentRun)
		.where(
			and(
				eq(agentRun.agentId, agentId),
				inArray(agentRun.status, [...CANCELLABLE_STATUSES]),
			),
		)
		.limit(1);
	if (active) {
		throw new ConflictException(
			"This agent already has an active run. Stop it or wait for it to finish.",
		);
	}
}

async function createRun(
	tx: Executor,
	values: typeof agentRun.$inferInsert,
): Promise<{ id: string }> {
	const [created] = await tx
		.insert(agentRun)
		.values(values)
		.returning({ id: agentRun.id });
	if (!created) throw new Error("The run insert returned no row.");
	await tx
		.insert(agentRunEvent)
		.values({ runId: created.id, sequence: 0, type: "run.queued", data: {} });
	return created;
}
