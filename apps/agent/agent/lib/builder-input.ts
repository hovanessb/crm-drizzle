import {
	agentConversation,
	agentEvent,
	and,
	db,
	desc,
	firstRow,
	type JsonValue,
	requireRow,
	startsWith,
	whereEq,
} from "@crm/db";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { type InputRequested, parse, schemas } from "@crm/validation";
import type { ChannelEvents } from "eve/channels";
import { readBuilderEvent, storeBuilderEvent } from "./builder-event-storage";
import {
	builderIdFromToken,
	builderToken,
	lockBuilderConversation,
} from "./custom-agent-dispatch";

const BUILDER_INPUT = {
	eventType: "input.requested",
	idPrefix: "builder-input",
} as const;

export const BUILDER_INPUT_EVENT_PREFIX = `${BUILDER_INPUT.idPrefix}:`;

type InputRequestedEvent = Parameters<
	NonNullable<ChannelEvents["input.requested"]>
>[0];

export async function persistBuilderInputRequest(
	data: InputRequestedEvent,
	continuationToken: string | undefined,
	authenticatedConversationId?: string | null,
): Promise<boolean> {
	const conversationId =
		authenticatedConversationId?.trim() ||
		builderIdFromToken(continuationToken);
	if (!conversationId) return false;

	const event = parse(
		schemas.agents.inputRequested,
		data,
		BUILDER_INPUT.eventType,
	);
	if (event.requests.length === 0) return false;

	const eventId = `${eventPrefix(conversationId)}${event.turnId}:${event.sequence}:${event.stepIndex}`;

	return db.transaction(async (tx) => {
		await lockIdempotencyKey(tx, eventId);

		const replay = await firstRow(
			tx
				.select({ id: agentEvent.id })
				.from(agentEvent)
				.where(whereEq(agentEvent.id, eventId))
				.limit(1),
		);
		if (replay) return false;

		const conversation = await lockBuilderConversation(tx, conversationId);
		if (conversation?.kind !== "BUILDER" || !conversation.sessionId) {
			return false;
		}

		const recorded = await firstRow(
			tx
				.select({
					id: agentEvent.id,
					data: agentEvent.data,
					encryptedData: agentEvent.encryptedData,
				})
				.from(agentEvent)
				.where(
					and(
						whereEq(agentEvent.conversationId, conversation.id),
						startsWith(agentEvent.id, eventPrefix(conversation.id)),
					),
				)
				.orderBy(desc(agentEvent.emittedAt), desc(agentEvent.id))
				.limit(1),
		);
		const recordedData = recorded
			? readBuilderEvent(recorded, {
					conversationId: conversation.id,
					eventId: recorded.id,
				})
			: null;
		if (
			recorded &&
			recordedData &&
			!supersedes(
				event,
				parse(schemas.agents.inputRequested, recordedData, recorded.id),
			)
		) {
			return false;
		}
		if (recorded && !recordedData) return false;

		const storedEvent = storeBuilderEvent(event as JsonValue, {
			conversationId: conversation.id,
			eventId,
		});

		await requireRow(
			tx
				.insert(agentEvent)
				.values({
					id: eventId,
					sessionId: conversation.sessionId,
					conversationId: conversation.id,
					type: BUILDER_INPUT.eventType,
					data: storedEvent.data,
					encryptedData: storedEvent.encryptedData,
					emittedAt: new Date(),
				})
				.returning(),
		);

		await requireRow(
			tx
				.update(agentConversation)
				.set({
					continuationToken: builderToken(conversation.id),
					pendingInputRequests: event.requests as JsonValue,
				})
				.where(whereEq(agentConversation.id, conversation.id))
				.returning(),
		);

		return true;
	});
}

function eventPrefix(conversationId: string): string {
	return `${BUILDER_INPUT_EVENT_PREFIX}${conversationId}:`;
}

function supersedes(event: InputRequested, current: InputRequested): boolean {
	if (event.sequence !== current.sequence) {
		return event.sequence > current.sequence;
	}
	return event.stepIndex > current.stepIndex;
}
