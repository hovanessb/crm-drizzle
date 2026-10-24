import {
	agentConversation,
	and,
	db,
	eq,
	firstRow,
	isNull,
	whereEq,
} from "@crm/db";

export const BUILDER_CONVERSATION_TITLE_MAX_LENGTH = 60;

export async function setBuilderConversationTitle(
	conversationId: string,
	userId: string,
	title: string,
) {
	const normalized = title
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.slice(0, BUILDER_CONVERSATION_TITLE_MAX_LENGTH)
		.trim();

	if (!normalized) throw new Error("A chat title cannot be empty.");

	const updated = await db
		.update(agentConversation)
		.set({ title: normalized })
		.where(
			and(
				whereEq(agentConversation.id, conversationId),
				whereEq(agentConversation.userId, userId),
				eq(agentConversation.kind, "BUILDER"),
				isNull(agentConversation.title),
			),
		);

	if (updated.rowCount === 0) {
		const conversation = await firstRow(
			db
				.select({ title: agentConversation.title })
				.from(agentConversation)
				.where(
					and(
						whereEq(agentConversation.id, conversationId),
						whereEq(agentConversation.userId, userId),
						eq(agentConversation.kind, "BUILDER"),
					),
				)
				.limit(1),
		);
		if (!conversation)
			throw new Error("This builder conversation is unavailable.");
		return { saved: false as const, title: conversation.title };
	}

	return { saved: true as const, title: normalized };
}
