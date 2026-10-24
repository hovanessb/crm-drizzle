import { randomBytes } from "node:crypto";
import { WORKSPACE_ID } from "@crm/auth/organization";
import {
	agentBuilderArtifact,
	agentConversation,
	agentConversationAttachment,
	agentConversationShare,
	agentConversationSubmission,
	agentEvent,
	and,
	asc,
	type Db,
	desc,
	type Executor,
	eq,
	gt,
	isNull,
	member,
	or,
} from "@crm/db";
import {
	ForbiddenException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { builderMessageWithAttachments } from "./conversation-attachments";
import { publicConversationEvent } from "./conversation-resume";
import { conversationShareTokenHash } from "./conversation-share-token";

@Injectable()
export class ConversationSharingService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async status(conversationId: string, userId: string) {
		await this.ownedBuilder(conversationId, userId);

		const [share] = await this.db
			.select({
				createdAt: agentConversationShare.createdAt,
				expiresAt: agentConversationShare.expiresAt,
			})
			.from(agentConversationShare)
			.where(
				and(
					eq(agentConversationShare.conversationId, conversationId),
					isNull(agentConversationShare.revokedAt),
					or(
						isNull(agentConversationShare.expiresAt),
						gt(agentConversationShare.expiresAt, new Date()),
					),
				),
			)
			.limit(1);

		return {
			enabled: share !== undefined,
			createdAt: share?.createdAt.toISOString() ?? null,
			expiresAt: share?.expiresAt?.toISOString() ?? null,
		};
	}

	async create(conversationId: string, userId: string) {
		const token = randomBytes(32).toString("base64url");
		const tokenHash = conversationShareTokenHash(token);

		const created = await this.db.transaction(async (tx) => {
			if (!(await this.lockOwnedBuilder(tx, conversationId, userId))) {
				return false;
			}

			await this.revokeActive(tx, conversationId);

			await tx
				.insert(agentConversationShare)
				.values({ conversationId, createdById: userId, tokenHash });

			return true;
		});
		if (!created) this.missingBuilder(conversationId);

		return { token };
	}

	async revoke(conversationId: string, userId: string) {
		const revoked = await this.db.transaction(async (tx) => {
			if (!(await this.lockOwnedBuilder(tx, conversationId, userId))) {
				return false;
			}

			await this.revokeActive(tx, conversationId);

			return true;
		});
		if (!revoked) this.missingBuilder(conversationId);

		return { id: conversationId };
	}

	async resolve(token: string, userId: string) {
		await this.assertWorkspaceMember(userId);

		const [shared] = await this.db
			.select({ conversationId: agentConversationShare.conversationId })
			.from(agentConversationShare)
			.innerJoin(
				agentConversation,
				eq(agentConversation.id, agentConversationShare.conversationId),
			)
			.where(
				and(
					eq(
						agentConversationShare.tokenHash,
						conversationShareTokenHash(token),
					),
					isNull(agentConversationShare.revokedAt),
					or(
						isNull(agentConversationShare.expiresAt),
						gt(agentConversationShare.expiresAt, new Date()),
					),
					eq(agentConversation.kind, "BUILDER"),
				),
			)
			.limit(1);

		const conversationRow = shared
			? await this.db.query.agentConversation.findFirst({
					where: eq(agentConversation.id, shared.conversationId),
					columns: {
						id: true,
						title: true,
						sessionId: true,
						lastMessageAt: true,
					},
					with: {
						user: { columns: { name: true } },
						agent: { columns: { id: true, name: true, status: true } },
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
						submissions: {
							orderBy: [asc(agentConversationSubmission.createdAt)],
							columns: {
								id: true,
								commandType: true,
								message: true,
								status: true,
								errorMessage: true,
								createdAt: true,
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
				})
			: undefined;

		if (!conversationRow) {
			throw new NotFoundException("That shared conversation is unavailable.");
		}

		const conversation = conversationRow;
		const events = await this.db
			.select({
				id: agentEvent.id,
				type: agentEvent.type,
				data: agentEvent.data,
				encryptedData: agentEvent.encryptedData,
				conversationId: agentEvent.conversationId,
				emittedAt: agentEvent.emittedAt,
				streamIndex: agentEvent.streamIndex,
				deliveryIds: agentEvent.deliveryIds,
			})
			.from(agentEvent)
			.where(
				or(
					eq(agentEvent.conversationId, conversation.id),
					conversation.sessionId
						? eq(agentEvent.sessionId, conversation.sessionId)
						: undefined,
				),
			)
			.orderBy(desc(agentEvent.emittedAt), desc(agentEvent.id))
			.limit(5000);

		return {
			id: conversation.id,
			title: conversation.title,
			ownerName: conversation.user.name,
			lastMessageAt: conversation.lastMessageAt.toISOString(),
			agent: conversation.agent,
			builderArtifacts: conversation.builderArtifacts.map((artifact) => ({
				...artifact,
				createdAt: artifact.createdAt.toISOString(),
			})),
			submissions: conversation.submissions.map(
				({ attachments, ...submission }) => ({
					...submission,
					message: builderMessageWithAttachments(
						submission.message,
						attachments,
						token,
					),
					createdAt: submission.createdAt.toISOString(),
				}),
			),
			events: events.reverse().map(publicConversationEvent),
		};
	}

	private async ownedBuilder(conversationId: string, userId: string) {
		const [conversation] = await this.db
			.select({ id: agentConversation.id })
			.from(agentConversation)
			.where(
				and(
					eq(agentConversation.id, conversationId),
					eq(agentConversation.userId, userId),
					eq(agentConversation.kind, "BUILDER"),
				),
			)
			.limit(1);

		if (!conversation) {
			this.missingBuilder(conversationId);
		}

		return conversation;
	}

	private async lockOwnedBuilder(
		tx: Executor,
		conversationId: string,
		userId: string,
	): Promise<boolean> {
		const rows = await tx
			.select({ id: agentConversation.id })
			.from(agentConversation)
			.where(eq(agentConversation.id, conversationId))
			.for("update");
		if (rows.length === 0) return false;

		return (
			(await tx.$count(
				agentConversation,
				and(
					eq(agentConversation.id, conversationId),
					eq(agentConversation.userId, userId),
					eq(agentConversation.kind, "BUILDER"),
				),
			)) === 1
		);
	}

	private async revokeActive(
		tx: Executor,
		conversationId: string,
	): Promise<void> {
		await tx
			.update(agentConversationShare)
			.set({ revokedAt: new Date() })
			.where(
				and(
					eq(agentConversationShare.conversationId, conversationId),
					isNull(agentConversationShare.revokedAt),
				),
			);
	}

	private missingBuilder(conversationId: string): never {
		throw new NotFoundException(
			`No builder conversation with id ${conversationId}.`,
		);
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
			throw new ForbiddenException(
				"This conversation belongs to another team.",
			);
		}
	}
}
