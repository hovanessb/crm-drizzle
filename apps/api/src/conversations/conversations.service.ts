import { WORKSPACE_ID } from "@crm/auth/organization";
import {
	AgentConversationPermissionMode,
	account,
	agentBuilderArtifact,
	agentConversation,
	agentConversationAttachment,
	agentConversationFeedback,
	agentConversationShare,
	agentConversationSubmission,
	agentEvent,
	agentTrigger,
	agentVersion,
	and,
	asc,
	company,
	contact,
	contains,
	type Db,
	deal,
	desc,
	type Executor,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	isUniqueViolation,
	type JsonValue,
	member,
	or,
	type PgColumn,
	relatedCount,
	type SQL,
	sql,
} from "@crm/db";
import { type InputRequest, schemas } from "@crm/validation";
import { readAgentManifestSummary } from "@crm/validation/agent-manifest";
import {
	type AgentPermissionMode,
	agentPermissionMode,
	type BuilderToolApproval,
	builderToolApproval,
} from "@crm/validation/agent-permission";
import {
	type BuilderQuestion,
	builderQuestion,
} from "@crm/validation/builder-question";
import {
	type BuilderSessionLimit,
	builderSessionLimit,
} from "@crm/validation/builder-session-limit";
import {
	BadRequestException,
	Injectable,
	Logger,
	NotFoundException,
	Optional,
} from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { InjectDatabase } from "../database/database.constants";
import {
	builderMessageWithAttachments,
	isPreviewableImage,
} from "./conversation-attachments";
import {
	conversationResumeSnapshot,
	publicConversationEvent,
} from "./conversation-resume";
import { conversationShareTokenHash } from "./conversation-share-token";
import type {
	BuilderApprovalResponseInput,
	BuilderConversationCreateInput,
	BuilderConversationSubmitInput,
	BuilderConversationSummary,
	BuilderQuestionResponseInput,
	BuilderSessionLimitResponseInput,
	ConversationEventsInput,
	ConversationListInput,
	ConversationSaveInput,
	ConversationSummary,
} from "./conversations.contracts";

type ReplayedRequest = {
	id: string;
};

type ExistingBuilderRequest = {
	id: string;
	conversationId: string;
	submittedById: string;
	conversation: { id: string; userId: string; kind: string };
};

@Injectable()
export class ConversationsService {
	private readonly logger = new Logger(ConversationsService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Optional() private readonly agent?: AgentTriggerService,
	) {}

	async list(
		input: ConversationListInput,
		userId: string,
	): Promise<ConversationSummary[]> {
		const recordId = this.recordId(input);
		this.logger.debug({ message: "Conversation list read", recordId });

		const rows = await this.db
			.select({
				id: agentConversation.id,
				sessionId: agentConversation.sessionId,
				continuationToken: agentConversation.continuationToken,
				streamIndex: agentConversation.streamIndex,
				title: agentConversation.title,
				messageCount: agentConversation.messageCount,
				lastMessageAt: agentConversation.lastMessageAt,
			})
			.from(agentConversation)
			.where(
				and(
					eq(agentConversation.userId, userId),
					input.contactId
						? eq(agentConversation.contactId, input.contactId)
						: undefined,
					input.companyId
						? eq(agentConversation.companyId, input.companyId)
						: undefined,
					input.dealId ? eq(agentConversation.dealId, input.dealId) : undefined,
				),
			)
			.orderBy(desc(agentConversation.lastMessageAt))
			.limit(20);

		const summaries = rows.flatMap((row) =>
			row.sessionId
				? [
						{
							...row,
							sessionId: row.sessionId,
							lastMessageAt: row.lastMessageAt.toISOString(),
						},
					]
				: [],
		);

		return summaries;
	}

	async listBuilder(userId: string): Promise<BuilderConversationSummary[]> {
		await this.assertWorkspaceMember(userId);
		const rows = await this.db.query.agentConversation.findMany({
			where: and(
				eq(agentConversation.userId, userId),
				eq(agentConversation.kind, "BUILDER"),
			),
			orderBy: [desc(agentConversation.lastMessageAt)],
			limit: 50,
			columns: {
				id: true,
				sessionId: true,
				continuationToken: true,
				streamIndex: true,
				title: true,
				messageCount: true,
				lastMessageAt: true,
				lastAssistantAt: true,
				lastReadAt: true,
			},
			extras: (conversation: { id: typeof agentConversation.id }) => ({
				createAgentSubmissions: relatedCount(
					agentConversationSubmission,
					agentConversationSubmission.conversationId,
					conversation.id,
					[
						{
							column: agentConversationSubmission.commandType,
							value: "CREATE_AGENT",
						},
					],
				).as("createAgentSubmissions"),
			}),
			with: {
				agent: { columns: { id: true, name: true, status: true } },
				submissions: {
					where: inArray(agentConversationSubmission.status, [
						"PENDING",
						"SENDING",
					]),
					columns: { id: true },
					limit: 1,
				},
			},
		});

		return rows.map((row) => {
			const unread = Boolean(
				row.lastAssistantAt &&
					(!row.lastReadAt || row.lastAssistantAt > row.lastReadAt),
			);
			const working =
				row.submissions.length > 0 ||
				Boolean(row.sessionId && !row.continuationToken);

			return {
				id: row.id,
				sessionId: row.sessionId,
				continuationToken: row.continuationToken,
				streamIndex: row.streamIndex,
				title: row.title,
				messageCount: row.messageCount,
				lastMessageAt: row.lastMessageAt.toISOString(),
				lastAssistantAt: row.lastAssistantAt?.toISOString() ?? null,
				unread,
				state:
					row.createAgentSubmissions > 0 && row.agent?.status === "LIVE"
						? "deployed"
						: working
							? "working"
							: unread
								? "unread"
								: "idle",
				agent: row.agent,
			};
		});
	}

	async builderResources(q: string, userId: string) {
		await this.assertWorkspaceMember(userId);

		const search = q.trim();
		const matches = (column: Parameters<typeof contains>[0]) =>
			search ? contains(column, search, { insensitive: true }) : undefined;

		const [companies, contacts, deals, [slackAccount]] = await Promise.all([
			this.db
				.select({
					id: company.id,
					name: company.name,
					domain: company.domain,
					logoUrl: company.logoUrl,
				})
				.from(company)
				.where(matches(company.name))
				.orderBy(sql`${company.lastActivityAt} desc nulls last`)
				.limit(6),
			this.db
				.select({
					id: contact.id,
					firstName: contact.firstName,
					lastName: contact.lastName,
					email: contact.email,
					imageUrl: contact.imageUrl,
					company: { name: company.name },
				})
				.from(contact)
				.leftJoin(company, eq(company.id, contact.companyId))
				.where(
					search
						? or(
								matches(contact.firstName),
								matches(contact.lastName),
								matches(contact.email),
							)
						: undefined,
				)
				.orderBy(sql`${contact.lastActivityAt} desc nulls last`)
				.limit(6),
			this.db
				.select({
					id: deal.id,
					name: deal.name,
					company: { name: company.name, logoUrl: company.logoUrl },
				})
				.from(deal)
				.innerJoin(company, eq(company.id, deal.companyId))
				.where(matches(deal.name))
				.orderBy(sql`${deal.lastActivityAt} desc nulls last`)
				.limit(6),
			this.db
				.select({ id: account.id })
				.from(account)
				.where(
					and(eq(account.providerId, "slack"), isNotNull(account.accessToken)),
				)
				.limit(1),
		]);

		return [
			...(slackAccount && (!search || "slack".includes(search.toLowerCase()))
				? [
						{
							kind: "integration" as const,
							id: "slack:workspace",
							label: "Slack",
							detail: "Connected workspace",
							imageUrl: null,
						},
					]
				: []),
			...companies.map((company) => ({
				kind: "company" as const,
				id: company.id,
				label: company.name,
				detail: company.domain,
				imageUrl: company.logoUrl,
			})),
			...contacts.map((contact) => ({
				kind: "contact" as const,
				id: contact.id,
				label: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
				detail: contact.company?.name ?? contact.email,
				imageUrl: contact.imageUrl,
			})),
			...deals.map((deal) => ({
				kind: "deal" as const,
				id: deal.id,
				label: deal.name,
				detail: deal.company.name,
				imageUrl: deal.company.logoUrl,
			})),
		];
	}

	async builderById(id: string, userId: string) {
		await this.assertWorkspaceMember(userId);
		const row = await this.db.query.agentConversation.findFirst({
			where: this.ownedBuilder(id, userId),
			columns: {
				id: true,
				permissionMode: true,
				sessionId: true,
				continuationToken: true,
				pendingInputRequests: true,
				streamIndex: true,
				title: true,
				messageCount: true,
				lastMessageAt: true,
				lastAssistantAt: true,
				lastReadAt: true,
			},
			with: {
				agent: {
					columns: {
						id: true,
						name: true,
						description: true,
						status: true,
					},
					with: {
						createdBy: { columns: { id: true, name: true } },
						currentVersion: {
							columns: {
								id: true,
								number: true,
								status: true,
								manifest: true,
								modelId: true,
								sandboxPolicy: true,
								deployedAt: true,
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
							},
						},
					},
				},
				createdVersions: {
					orderBy: [desc(agentVersion.number)],
					limit: 1,
					columns: {
						id: true,
						number: true,
						status: true,
						instructions: true,
						manifest: true,
						modelId: true,
						sandboxPolicy: true,
						validation: true,
						createdAt: true,
					},
				},
				builderArtifacts: {
					orderBy: [
						desc(agentBuilderArtifact.createdAt),
						desc(agentBuilderArtifact.revision),
					],
					limit: 100,
					columns: {
						id: true,
						versionId: true,
						path: true,
						language: true,
						content: true,
						previousContent: true,
						revision: true,
						status: true,
						createdAt: true,
					},
				},
				feedback: {
					where: eq(agentConversationFeedback.userId, userId),
					columns: { messageId: true, rating: true },
				},
				submissions: {
					orderBy: [asc(agentConversationSubmission.createdAt)],
					columns: {
						id: true,
						clientRequestId: true,
						commandType: true,
						message: true,
						status: true,
						errorCode: true,
						errorMessage: true,
						createdAt: true,
						sentAt: true,
						acceptedAt: true,
						inputRequestId: true,
					},
					with: {
						attachments: {
							orderBy: [asc(agentConversationAttachment.position)],
							columns: {
								id: true,
								name: true,
								mediaType: true,
								size: true,
							},
						},
					},
				},
			},
		});

		if (!row) {
			throw new NotFoundException(`No builder conversation with id ${id}.`);
		}

		const { pendingInputRequests, ...conversation } = row;
		const activeInputRequest = activeBuilderInputRequest(
			pendingInputRequests,
			row.submissions.flatMap((submission) =>
				submission.inputRequestId ? [submission.inputRequestId] : [],
			),
		);
		const resume = row.sessionId
			? conversationResumeSnapshot(
					row.sessionId,
					await this.db
						.select(EVENT_FIELDS)
						.from(agentEvent)
						.where(
							and(
								eq(agentEvent.conversationId, row.id),
								eq(agentEvent.sessionId, row.sessionId),
								isNotNull(agentEvent.streamIndex),
							),
						)
						.orderBy(asc(agentEvent.streamIndex)),
				)
			: null;

		return {
			...conversation,
			permissionMode: permissionModeOutput(row.permissionMode),
			resume,
			pendingQuestion: pendingBuilderQuestionOf(activeInputRequest),
			pendingApproval: pendingBuilderApprovalOf(activeInputRequest),
			pendingSessionLimit: pendingBuilderSessionLimitOf(activeInputRequest),
			lastMessageAt: row.lastMessageAt.toISOString(),
			lastAssistantAt: row.lastAssistantAt?.toISOString() ?? null,
			lastReadAt: row.lastReadAt?.toISOString() ?? null,
			agent: row.agent
				? {
						...row.agent,
						currentVersion: row.agent.currentVersion
							? {
									...row.agent.currentVersion,
									deployedAt:
										row.agent.currentVersion.deployedAt?.toISOString() ?? null,
								}
							: null,
						triggers: row.agent.triggers.map((trigger) => ({
							...trigger,
							nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
						})),
					}
				: null,
			createdVersions: row.createdVersions.map((version) => ({
				...version,
				manifest: readAgentManifestSummary(version.manifest),
				createdAt: version.createdAt.toISOString(),
			})),
			builderArtifacts: row.builderArtifacts.map((artifact) => ({
				...artifact,
				createdAt: artifact.createdAt.toISOString(),
			})),
			submissions: row.submissions.map(
				({ attachments, inputRequestId: _, ...submission }) => ({
					...submission,
					message: builderMessageWithAttachments(
						submission.message,
						attachments,
					),
					createdAt: submission.createdAt.toISOString(),
					sentAt: submission.sentAt?.toISOString() ?? null,
					acceptedAt: submission.acceptedAt?.toISOString() ?? null,
				}),
			),
		};
	}

	async createBuilder(
		input: BuilderConversationCreateInput,
		userId: string,
	): Promise<{ id: string }> {
		await this.assertWorkspaceMember(userId);
		const existing = await this.requestByClientId(input.clientRequestId);

		if (existing) {
			return this.replayBuilderCreation(existing, userId);
		}

		const now = new Date();
		try {
			const conversation = await this.db.transaction(async (tx) => {
				const [created] = await tx
					.insert(agentConversation)
					.values({
						kind: "BUILDER",
						userId,
						title: null,
						lastReadAt: now,
						lastMessageAt: now,
					})
					.returning({ id: agentConversation.id });
				if (!created)
					throw new Error("The conversation insert returned no row.");

				await this.insertSubmission(
					tx,
					{
						conversationId: created.id,
						submittedById: userId,
						clientRequestId: input.clientRequestId,
						commandType: input.commandType,
						message: this.builderMessage(input),
					},
					this.attachmentWrites(input.attachments),
				);

				return created;
			});

			this.agent?.builderConversationQueued();
			return conversation;
		} catch (error) {
			if (!isUniqueConstraint(error)) throw error;
			const winner = await this.requestByClientId(input.clientRequestId);
			if (!winner) throw error;
			return this.replayBuilderCreation(winner, userId);
		}
	}

	async submitBuilder(
		input: BuilderConversationSubmitInput,
		userId: string,
	): Promise<{ id: string }> {
		await this.assertWorkspaceMember(userId);
		const existing = await this.requestByClientId(input.clientRequestId);

		if (existing) {
			return this.replayBuilderSubmission(existing, input.id, userId);
		}

		const conversation = await this.builderId(input.id, userId);

		if (!conversation) {
			throw new NotFoundException(
				`No builder conversation with id ${input.id}.`,
			);
		}

		try {
			const attachmentWrites = await this.submissionAttachmentWrites(
				input,
				userId,
			);
			const submission = await this.db.transaction(async (tx) => {
				const created = await this.insertSubmission(
					tx,
					{
						conversationId: input.id,
						submittedById: userId,
						clientRequestId: input.clientRequestId,
						commandType: input.commandType,
						message: this.builderMessage(input),
					},
					attachmentWrites,
				);

				await this.touchConversation(tx, input.id);

				return created;
			});

			this.agent?.builderConversationQueued();
			return submission;
		} catch (error) {
			if (!isUniqueConstraint(error)) throw error;
			const winner = await this.requestByClientId(input.clientRequestId);
			if (!winner) throw error;
			return this.replayBuilderSubmission(winner, input.id, userId);
		}
	}

	async answerBuilderQuestion(
		input: BuilderQuestionResponseInput,
		userId: string,
	): Promise<{ id: string }> {
		await this.assertWorkspaceMember(userId);
		const existing = await this.requestByClientId(input.clientRequestId);

		if (existing) {
			return this.replayBuilderSubmission(existing, input.id, userId);
		}

		const conversation = await this.pendingConversation(input.id, userId);

		if (!conversation) {
			throw new NotFoundException(
				`No builder conversation with id ${input.id}.`,
			);
		}

		if (!conversation.sessionId || !conversation.continuationToken) {
			throw new BadRequestException(
				"The agent is no longer waiting for that answer.",
			);
		}

		const question = pendingBuilderQuestionOf(
			activeBuilderInputRequest(
				conversation.pendingInputRequests,
				conversation.submissions.flatMap((submission) =>
					submission.inputRequestId ? [submission.inputRequestId] : [],
				),
			),
		);
		if (!question) {
			throw new BadRequestException(
				"The agent is no longer waiting for that answer.",
			);
		}
		if (question.requestId !== input.requestId) {
			throw new BadRequestException(
				"That follow-up question is no longer active.",
			);
		}

		const options = question.options;
		const selected = input.optionId
			? options.find((option) => option.id === input.optionId)
			: null;

		if (input.optionId && !selected) {
			throw new BadRequestException(
				"That answer is not available for this question.",
			);
		}

		const acceptsText = question.allowFreeform || question.display === "text";
		if (input.text && !acceptsText) {
			throw new BadRequestException(
				"Choose one of the available answers for this question.",
			);
		}

		const answer = input.optionId ?? input.text;
		if (!answer) {
			throw new BadRequestException("Choose an answer before submitting.");
		}

		const displayText = selected?.label ?? answer;
		const inputResponse = input.optionId
			? { requestId: input.requestId, optionId: input.optionId }
			: { requestId: input.requestId, text: input.text };
		try {
			const submission = await this.db.transaction(async (tx) => {
				const created = await this.insertSubmission(
					tx,
					{
						conversationId: input.id,
						submittedById: userId,
						clientRequestId: input.clientRequestId,
						inputRequestId: input.requestId,
						commandType: "CREATE_AGENT",
						message: {
							text: displayText,
							resources: [],
							attachments: [],
							inputResponse,
						},
					},
					[],
				);

				await this.touchConversation(tx, input.id);

				return created;
			});

			this.agent?.builderConversationQueued();
			return submission;
		} catch (error) {
			if (!isUniqueConstraint(error)) throw error;

			const winner = await this.requestByClientId(input.clientRequestId);
			if (winner) {
				return this.replayBuilderSubmission(winner, input.id, userId);
			}

			const [answered] = await this.db
				.select({ id: agentConversationSubmission.id })
				.from(agentConversationSubmission)
				.where(
					and(
						eq(agentConversationSubmission.conversationId, input.id),
						eq(agentConversationSubmission.inputRequestId, input.requestId),
					),
				)
				.limit(1);
			if (answered) {
				throw new BadRequestException(
					"That follow-up question has already been answered.",
				);
			}

			throw error;
		}
	}

	async answerBuilderApproval(
		input: BuilderApprovalResponseInput,
		userId: string,
	): Promise<{ id: string }> {
		await this.assertWorkspaceMember(userId);
		const existing = await this.requestByClientId(input.clientRequestId);

		if (existing) {
			return this.replayBuilderSubmission(existing, input.id, userId);
		}

		const conversation = await this.pendingConversation(input.id, userId);

		if (!conversation) {
			throw new NotFoundException(
				`No builder conversation with id ${input.id}.`,
			);
		}

		if (!conversation.sessionId || !conversation.continuationToken) {
			throw new BadRequestException(
				"The agent is no longer waiting for that approval.",
			);
		}

		const approval = pendingBuilderApprovalOf(
			activeBuilderInputRequest(
				conversation.pendingInputRequests,
				conversation.submissions.flatMap((submission) =>
					submission.inputRequestId ? [submission.inputRequestId] : [],
				),
			),
		);
		if (!approval || approval.requestId !== input.requestId) {
			throw new BadRequestException(
				"That approval request is no longer active.",
			);
		}

		if (!approval.options.some((option) => option.id === input.decision)) {
			throw new BadRequestException("That approval decision is not available.");
		}

		try {
			const submission = await this.db.transaction(async (tx) => {
				const created = await this.insertSubmission(
					tx,
					{
						conversationId: input.id,
						submittedById: userId,
						clientRequestId: input.clientRequestId,
						inputRequestId: input.requestId,
						commandType: "CHAT",
						message: {
							text: input.decision === "approve" ? "Approved" : "Declined",
							resources: [],
							attachments: [],
							inputResponse: {
								requestId: input.requestId,
								optionId: input.decision,
							},
						},
					},
					[],
				);

				await this.touchConversation(tx, input.id);

				return created;
			});

			this.agent?.builderConversationQueued();
			return submission;
		} catch (error) {
			if (!isUniqueConstraint(error)) throw error;

			const winner = await this.requestByClientId(input.clientRequestId);
			if (winner) {
				return this.replayBuilderSubmission(winner, input.id, userId);
			}

			throw new BadRequestException(
				"That approval request has already been answered.",
			);
		}
	}

	async answerBuilderSessionLimit(
		input: BuilderSessionLimitResponseInput,
		userId: string,
	): Promise<{ id: string }> {
		await this.assertWorkspaceMember(userId);
		const existing = await this.requestByClientId(input.clientRequestId);

		if (existing) {
			return this.replayBuilderSubmission(existing, input.id, userId);
		}

		const conversation = await this.pendingConversation(input.id, userId);

		if (!conversation) {
			throw new NotFoundException(
				`No builder conversation with id ${input.id}.`,
			);
		}

		if (!conversation.sessionId || !conversation.continuationToken) {
			throw new BadRequestException(
				"The agent is no longer waiting for that decision.",
			);
		}

		const limit = pendingBuilderSessionLimitOf(
			activeBuilderInputRequest(
				conversation.pendingInputRequests,
				conversation.submissions.flatMap((submission) =>
					submission.inputRequestId ? [submission.inputRequestId] : [],
				),
			),
		);
		if (!limit || limit.requestId !== input.requestId) {
			throw new BadRequestException(
				"That session limit request is no longer active.",
			);
		}

		const option = limit.options?.find(
			(candidate) => candidate.id === input.decision,
		);
		if (!option) {
			throw new BadRequestException("That decision is not available.");
		}

		try {
			const submission = await this.db.transaction(async (tx) => {
				const created = await this.insertSubmission(
					tx,
					{
						conversationId: input.id,
						submittedById: userId,
						clientRequestId: input.clientRequestId,
						inputRequestId: input.requestId,
						commandType: "CHAT",
						message: {
							text: option.label,
							resources: [],
							attachments: [],
							inputResponse: {
								requestId: input.requestId,
								optionId: input.decision,
							},
						},
					},
					[],
				);

				await this.touchConversation(tx, input.id);

				return created;
			});

			this.agent?.builderConversationQueued();
			return submission;
		} catch (error) {
			if (!isUniqueConstraint(error)) throw error;

			const winner = await this.requestByClientId(input.clientRequestId);
			if (winner) {
				return this.replayBuilderSubmission(winner, input.id, userId);
			}

			throw new BadRequestException(
				"That session limit request has already been answered.",
			);
		}
	}

	async setBuilderPermissionMode(
		input: { id: string; permissionMode: AgentPermissionMode },
		userId: string,
	): Promise<{ id: string }> {
		await this.assertWorkspaceMember(userId);
		const updated = await this.db
			.update(agentConversation)
			.set({ permissionMode: permissionModeInput(input.permissionMode) })
			.where(this.ownedBuilder(input.id, userId))
			.returning({ id: agentConversation.id });

		if (updated.length !== 1) {
			throw new NotFoundException(
				`No builder conversation with id ${input.id}.`,
			);
		}

		return { id: input.id };
	}

	async markRead(id: string, userId: string): Promise<{ id: string }> {
		await this.assertWorkspaceMember(userId);
		const updated = await this.db
			.update(agentConversation)
			.set({ lastReadAt: new Date() })
			.where(this.ownedBuilder(id, userId))
			.returning({ id: agentConversation.id });

		if (updated.length === 0) {
			throw new NotFoundException(`No builder conversation with id ${id}.`);
		}

		return { id };
	}

	async attachment(
		id: string,
		userId: string,
		shareToken?: string,
	): Promise<{
		name: string;
		mediaType: string;
		content: Uint8Array;
		previewable: boolean;
	}> {
		await this.assertWorkspaceMember(userId);
		const share = shareToken?.trim();
		const [row] = await this.db
			.select({
				name: agentConversationAttachment.name,
				mediaType: agentConversationAttachment.mediaType,
				content: agentConversationAttachment.content,
			})
			.from(agentConversationAttachment)
			.innerJoin(
				agentConversationSubmission,
				eq(
					agentConversationSubmission.id,
					agentConversationAttachment.submissionId,
				),
			)
			.innerJoin(
				agentConversation,
				eq(agentConversation.id, agentConversationSubmission.conversationId),
			)
			.where(
				and(
					eq(agentConversationAttachment.id, id),
					eq(agentConversation.kind, "BUILDER"),
					or(
						eq(agentConversation.userId, userId),
						share
							? exists(
									this.db
										.select({ id: agentConversationShare.id })
										.from(agentConversationShare)
										.where(
											and(
												eq(
													agentConversationShare.conversationId,
													agentConversation.id,
												),
												eq(
													agentConversationShare.tokenHash,
													conversationShareTokenHash(share),
												),
												isNull(agentConversationShare.revokedAt),
												or(
													isNull(agentConversationShare.expiresAt),
													gt(agentConversationShare.expiresAt, new Date()),
												),
											),
										),
								)
							: undefined,
					),
				),
			)
			.limit(1);

		if (!row) {
			throw new NotFoundException("That attachment is unavailable.");
		}

		return {
			...row,
			previewable: isPreviewableImage(row.mediaType),
		};
	}

	async rateBuilderResponse(
		input: { id: string; messageId: string; rating: "UP" | "DOWN" | null },
		userId: string,
	) {
		await this.assertWorkspaceMember(userId);
		const conversation = await this.builderId(input.id, userId);

		if (!conversation) {
			throw new NotFoundException(
				`No builder conversation with id ${input.id}.`,
			);
		}

		if (!input.rating) {
			await this.db
				.delete(agentConversationFeedback)
				.where(
					and(
						eq(agentConversationFeedback.conversationId, input.id),
						eq(agentConversationFeedback.userId, userId),
						eq(agentConversationFeedback.messageId, input.messageId),
					),
				);
			return { id: input.messageId, rating: null };
		}

		await this.db
			.insert(agentConversationFeedback)
			.values({
				conversationId: input.id,
				userId,
				messageId: input.messageId,
				rating: input.rating,
			})
			.onConflictDoUpdate({
				target: [
					agentConversationFeedback.conversationId,
					agentConversationFeedback.userId,
					agentConversationFeedback.messageId,
				],
				set: { rating: input.rating },
			});

		return { id: input.messageId, rating: input.rating };
	}

	async save(
		input: ConversationSaveInput,
		userId: string,
	): Promise<{ id: string }> {
		const recordId = this.recordId(input);
		const updateExisting = async (existing: {
			id: string;
			kind: string;
			userId: string;
			contactId: string | null;
			companyId: string | null;
			dealId: string | null;
		}) => {
			if (existing.userId !== userId || existing.kind !== "RECORD") {
				throw new NotFoundException(
					`No record conversation with session ${input.sessionId}.`,
				);
			}

			const existingRecordId =
				existing.contactId ?? existing.companyId ?? existing.dealId;
			if (existingRecordId !== recordId) {
				throw new BadRequestException(
					"A conversation cannot be moved to another CRM record.",
				);
			}

			const matchesRecord = (column: PgColumn, value?: string | null) =>
				value ? eq(column, value) : isNull(column);
			const updated = await this.db
				.update(agentConversation)
				.set({
					continuationToken: input.continuationToken ?? null,
					streamIndex: input.streamIndex ?? 0,
					messageCount: input.messageCount ?? 0,
					lastMessageAt: new Date(),
				})
				.where(
					and(
						eq(agentConversation.id, existing.id),
						eq(agentConversation.kind, "RECORD"),
						eq(agentConversation.userId, userId),
						matchesRecord(agentConversation.contactId, input.contactId),
						matchesRecord(agentConversation.companyId, input.companyId),
						matchesRecord(agentConversation.dealId, input.dealId),
					),
				)
				.returning({ id: agentConversation.id });

			if (updated.length !== 1) {
				throw new NotFoundException(
					`No record conversation with session ${input.sessionId}.`,
				);
			}

			return { id: existing.id };
		};

		const existing = await this.bySession(input.sessionId);
		let conversation: { id: string };

		if (existing) {
			conversation = await updateExisting(existing);
		} else {
			try {
				const [created] = await this.db
					.insert(agentConversation)
					.values({
						sessionId: input.sessionId,
						continuationToken: input.continuationToken ?? null,
						streamIndex: input.streamIndex ?? 0,
						title: input.title?.slice(0, 120) ?? null,
						messageCount: input.messageCount ?? 0,
						userId,
						contactId: input.contactId ?? null,
						companyId: input.companyId ?? null,
						dealId: input.dealId ?? null,
					})
					.returning({ id: agentConversation.id });
				if (!created)
					throw new Error("The conversation insert returned no row.");
				conversation = created;
			} catch (error) {
				if (!isUniqueConstraint(error)) throw error;
				const winner = await this.bySession(input.sessionId);
				if (!winner) throw error;
				conversation = await updateExisting(winner);
			}
		}

		return conversation;
	}

	async events(input: ConversationEventsInput, userId: string) {
		const [conversation] = await this.db
			.select({
				kind: agentConversation.kind,
				sessionId: agentConversation.sessionId,
				userId: agentConversation.userId,
			})
			.from(agentConversation)
			.where(eq(agentConversation.id, input.id))
			.limit(1);

		if (!conversation || conversation.userId !== userId) {
			throw new NotFoundException(`No conversation with id ${input.id}.`);
		}
		if (conversation.kind === "BUILDER") {
			await this.assertWorkspaceMember(userId);
		}

		const eventWhere: SQL | undefined =
			conversation.kind === "BUILDER"
				? or(
						eq(agentEvent.conversationId, input.id),
						conversation.sessionId
							? eq(agentEvent.sessionId, conversation.sessionId)
							: undefined,
					)
				: conversation.sessionId
					? eq(agentEvent.sessionId, conversation.sessionId)
					: sql`false`;

		const events = await this.db
			.select(EVENT_FIELDS)
			.from(agentEvent)
			.where(eventWhere)
			.orderBy(desc(agentEvent.emittedAt), desc(agentEvent.id))
			.limit(input.limit);

		return events.reverse().map(publicConversationEvent);
	}

	async remove(id: string, userId: string): Promise<{ id: string }> {
		const [conversation] = await this.db
			.select({
				id: agentConversation.id,
				kind: agentConversation.kind,
				userId: agentConversation.userId,
				sessionId: agentConversation.sessionId,
			})
			.from(agentConversation)
			.where(eq(agentConversation.id, id))
			.limit(1);

		if (!conversation || conversation.userId !== userId) {
			throw new NotFoundException(`No conversation with id ${id}.`);
		}
		if (conversation.kind === "BUILDER") {
			await this.assertWorkspaceMember(userId);
		}

		await this.db.transaction(async (tx) => {
			await tx
				.delete(agentBuilderArtifact)
				.where(
					and(
						eq(agentBuilderArtifact.conversationId, id),
						isNull(agentBuilderArtifact.versionId),
					),
				);
			await tx
				.delete(agentEvent)
				.where(
					or(
						eq(agentEvent.conversationId, id),
						conversation.sessionId
							? eq(agentEvent.sessionId, conversation.sessionId)
							: undefined,
					),
				);

			const removed = await tx
				.delete(agentConversation)
				.where(eq(agentConversation.id, id))
				.returning({ id: agentConversation.id });
			if (removed.length === 0)
				throw new NotFoundException(`No conversation with id ${id}.`);
		});

		this.logger.log({ message: "Conversation removed", conversationId: id });

		return { id };
	}

	private recordId(input: {
		contactId?: string;
		companyId?: string;
		dealId?: string;
	}): string {
		const recordIds = [input.contactId, input.companyId, input.dealId].filter(
			(recordId): recordId is string => Boolean(recordId),
		);
		const [recordId] = recordIds;

		if (!recordId || recordIds.length !== 1) {
			throw new BadRequestException(
				"Choose exactly one contact, company or deal.",
			);
		}

		return recordId;
	}

	private builderMessage(input: {
		message: string;
		resources: BuilderConversationCreateInput["resources"];
		attachments:
			| BuilderConversationCreateInput["attachments"]
			| BuilderConversationSubmitInput["attachments"];
	}): JsonValue {
		return {
			text: input.message,
			resources: input.resources,
			attachments: input.attachments.map(({ name, type, size }) => ({
				name,
				type,
				size,
			})),
		};
	}

	private attachmentWrites(
		attachments: BuilderConversationCreateInput["attachments"],
	) {
		return attachments.map((attachment, position) => ({
			name: attachment.name,
			mediaType: attachment.type,
			size: attachment.size,
			content: Buffer.from(attachment.contentBase64, "base64"),
			position,
		}));
	}

	private async submissionAttachmentWrites(
		input: BuilderConversationSubmitInput,
		userId: string,
	) {
		const referencedIds = input.attachments.flatMap((attachment) =>
			"contentBase64" in attachment ? [] : [attachment.id],
		);
		const referenced =
			referencedIds.length > 0
				? await this.db
						.select({
							id: agentConversationAttachment.id,
							name: agentConversationAttachment.name,
							mediaType: agentConversationAttachment.mediaType,
							size: agentConversationAttachment.size,
							content: agentConversationAttachment.content,
						})
						.from(agentConversationAttachment)
						.innerJoin(
							agentConversationSubmission,
							eq(
								agentConversationSubmission.id,
								agentConversationAttachment.submissionId,
							),
						)
						.innerJoin(
							agentConversation,
							eq(
								agentConversation.id,
								agentConversationSubmission.conversationId,
							),
						)
						.where(
							and(
								inArray(agentConversationAttachment.id, referencedIds),
								this.ownedBuilder(input.id, userId),
							),
						)
				: [];
		const referencedById = new Map(referenced.map((row) => [row.id, row]));

		if (referencedIds.some((id) => !referencedById.has(id))) {
			throw new BadRequestException(
				"One or more attachments are no longer available.",
			);
		}

		return input.attachments.map((attachment, position) => {
			if ("contentBase64" in attachment) {
				return {
					name: attachment.name,
					mediaType: attachment.type,
					size: attachment.size,
					content: Buffer.from(attachment.contentBase64, "base64"),
					position,
				};
			}

			const stored = referencedById.get(attachment.id);
			if (!stored) {
				throw new BadRequestException(
					"One or more attachments are no longer available.",
				);
			}
			return {
				name: stored.name,
				mediaType: stored.mediaType,
				size: stored.size,
				content: stored.content,
				position,
			};
		});
	}

	private async assertWorkspaceMember(userId: string): Promise<void> {
		const [membership] = await this.db
			.select({ id: member.id })
			.from(member)
			.where(
				and(eq(member.organizationId, WORKSPACE_ID), eq(member.userId, userId)),
			)
			.limit(1);

		if (!membership) {
			throw new NotFoundException("No workspace membership was found.");
		}
	}

	private async requestByClientId(
		clientRequestId: string,
	): Promise<ExistingBuilderRequest | null> {
		const row = await this.db.query.agentConversationSubmission.findFirst({
			where: eq(agentConversationSubmission.clientRequestId, clientRequestId),
			columns: { id: true, conversationId: true, submittedById: true },
			with: {
				conversation: { columns: { id: true, userId: true, kind: true } },
			},
		});
		return row ?? null;
	}

	private ownedBuilder(id: string, userId: string): SQL | undefined {
		return and(
			eq(agentConversation.id, id),
			eq(agentConversation.userId, userId),
			eq(agentConversation.kind, "BUILDER"),
		);
	}

	private async builderId(
		id: string,
		userId: string,
	): Promise<{ id: string } | null> {
		const [row] = await this.db
			.select({ id: agentConversation.id })
			.from(agentConversation)
			.where(this.ownedBuilder(id, userId))
			.limit(1);
		return row ?? null;
	}

	private async pendingConversation(id: string, userId: string) {
		const row = await this.db.query.agentConversation.findFirst({
			where: this.ownedBuilder(id, userId),
			columns: {
				id: true,
				sessionId: true,
				continuationToken: true,
				pendingInputRequests: true,
			},
			with: { submissions: { columns: { inputRequestId: true } } },
		});
		return row ?? null;
	}

	private async bySession(sessionId: string) {
		const [row] = await this.db
			.select({
				id: agentConversation.id,
				kind: agentConversation.kind,
				userId: agentConversation.userId,
				contactId: agentConversation.contactId,
				companyId: agentConversation.companyId,
				dealId: agentConversation.dealId,
			})
			.from(agentConversation)
			.where(eq(agentConversation.sessionId, sessionId))
			.limit(1);
		return row ?? null;
	}

	private async insertSubmission(
		tx: Executor,
		values: typeof agentConversationSubmission.$inferInsert,
		attachments: Omit<
			typeof agentConversationAttachment.$inferInsert,
			"submissionId"
		>[],
	): Promise<{ id: string }> {
		const [created] = await tx
			.insert(agentConversationSubmission)
			.values(values)
			.returning({ id: agentConversationSubmission.id });
		if (!created) throw new Error("The submission insert returned no row.");

		if (attachments.length > 0) {
			await tx.insert(agentConversationAttachment).values(
				attachments.map((attachment) => ({
					...attachment,
					submissionId: created.id,
				})),
			);
		}

		return created;
	}

	private async touchConversation(tx: Executor, id: string): Promise<void> {
		await tx
			.update(agentConversation)
			.set({ lastMessageAt: new Date(), lastReadAt: new Date() })
			.where(eq(agentConversation.id, id));
	}

	private replayBuilderCreation(
		existing: ExistingBuilderRequest,
		userId: string,
	): ReplayedRequest {
		if (
			existing.conversation.userId !== userId ||
			existing.conversation.kind !== "BUILDER"
		) {
			throw new BadRequestException("That request has already been used.");
		}

		return { id: existing.conversation.id };
	}

	private replayBuilderSubmission(
		existing: ExistingBuilderRequest,
		conversationId: string,
		userId: string,
	): ReplayedRequest {
		if (
			existing.conversationId !== conversationId ||
			existing.submittedById !== userId
		) {
			throw new BadRequestException("That request has already been used.");
		}

		return { id: existing.id };
	}
}

const EVENT_FIELDS = {
	id: agentEvent.id,
	type: agentEvent.type,
	data: agentEvent.data,
	encryptedData: agentEvent.encryptedData,
	conversationId: agentEvent.conversationId,
	emittedAt: agentEvent.emittedAt,
	streamIndex: agentEvent.streamIndex,
	deliveryIds: agentEvent.deliveryIds,
};

function isUniqueConstraint(cause: unknown): boolean {
	return isUniqueViolation(cause);
}

function pendingBuilderQuestionOf(value: JsonValue): BuilderQuestion | null {
	return builderQuestion.parse(value);
}

function pendingBuilderApprovalOf(
	value: JsonValue,
): BuilderToolApproval | null {
	return builderToolApproval.parse(value);
}

function pendingBuilderSessionLimitOf(
	value: JsonValue,
): BuilderSessionLimit | null {
	return builderSessionLimit.parse(value);
}

const BUILDER_INPUT_PRIORITY = {
	"session-limit": 0,
	"tool-approval": 1,
	question: 2,
} as const satisfies Record<InputRequest["kind"], number>;

function activeBuilderInputRequest(
	value: JsonValue,
	answeredRequestIds: readonly string[],
): InputRequest | null {
	const answered = new Set(answeredRequestIds);
	const requests = schemas.agents.inputRequests.parse(value ?? []);
	return requests.reduce<InputRequest | null>((active, request) => {
		if (answered.has(request.requestId)) return active;
		if (!active) return request;
		return BUILDER_INPUT_PRIORITY[request.kind] <
			BUILDER_INPUT_PRIORITY[active.kind]
			? request
			: active;
	}, null);
}

function permissionModeInput(
	mode: AgentPermissionMode,
): AgentConversationPermissionMode {
	const parsed = agentPermissionMode.parse(mode);
	if (parsed === "auto") return AgentConversationPermissionMode.AUTO;
	if (parsed === "bypass") return AgentConversationPermissionMode.BYPASS;
	return AgentConversationPermissionMode.MANUAL;
}

function permissionModeOutput(
	mode: AgentConversationPermissionMode,
): AgentPermissionMode {
	if (mode === AgentConversationPermissionMode.AUTO) return "auto";
	if (mode === AgentConversationPermissionMode.BYPASS) return "bypass";
	return "manual";
}
