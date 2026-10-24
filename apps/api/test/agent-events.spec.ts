import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	activity,
	agentTask,
	and,
	company as companyTable,
	db,
	deal as dealTable,
	eq,
	inArray,
	or,
	sql,
	user,
} from "@crm/db";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ConversionService } from "../src/currency/conversion.service";
import { DealsService } from "../src/deals/deals.service";
import { FieldsService } from "../src/fields/fields.service";
import { first, one } from "./rows";

const suffix = crypto.randomUUID();
const dealId = `event-deal-${suffix}`;
const contactId = `event-contact-${suffix}`;
const companyId = `event-company-${suffix}`;
const service = new AgentTriggerService(db);
const stamp = new ActivityStampService(db);
const conversion = new ConversionService(db);
const fields = new FieldsService(db, service);
const deals = new DealsService(db, service, stamp, conversion, fields);
const channelId = `event-channel-${suffix}`;
const ownerId = `event-owner-${suffix}`;
const domain = `event-${suffix}.example.test`;
let persistedCompanyId = "";
let persistedDealId = "";
let previousBridgeSecret: string | undefined;

beforeAll(async () => {
	previousBridgeSecret = process.env.AGENT_BRIDGE_SECRET;
	delete process.env.AGENT_BRIDGE_SECRET;
	await db
		.delete(agentTask)
		.where(
			or(eq(agentTask.dealId, dealId), eq(agentTask.contactId, contactId)),
		);
	await one(
		db
			.insert(user)
			.values({
				id: ownerId,
				name: "Event Test Owner",
				email: `${ownerId}@example.test`,
			})
			.returning(),
	);
	const company = await one(
		db
			.insert(companyTable)
			.values({ name: "Event Test Company", domain })
			.returning({ id: companyTable.id }),
	);
	persistedCompanyId = company.id;
});

afterAll(async () => {
	await db
		.delete(agentTask)
		.where(
			or(
				inArray(agentTask.dealId, [dealId, persistedDealId].filter(Boolean)),
				eq(agentTask.contactId, contactId),
			),
		);
	await db
		.delete(agentTask)
		.where(
			and(
				eq(agentTask.kind, "slack-channel-join"),
				sql`${agentTask.payload} #>> '{channelId}' = ${channelId}`,
			),
		);
	if (persistedDealId) {
		await db.delete(activity).where(eq(activity.dealId, persistedDealId));
		await db.delete(dealTable).where(eq(dealTable.id, persistedDealId));
	}
	if (persistedCompanyId) {
		await db
			.delete(companyTable)
			.where(eq(companyTable.id, persistedCompanyId));
	}
	await db.delete(user).where(eq(user.id, ownerId));
	if (previousBridgeSecret === undefined) {
		delete process.env.AGENT_BRIDGE_SECRET;
	} else {
		process.env.AGENT_BRIDGE_SECRET = previousBridgeSecret;
	}
});

describe("CRM agent events", () => {
	it("routes every event to its catalog record kind", async () => {
		const occurredAt = new Date("2026-08-10T09:00:00.000Z");
		await service.withCrmEvents(async (_tx, emit) => {
			await emit({
				type: "contact.created",
				record: { kind: "contact", id: contactId },
				occurredAt,
				data: { email: "person@example.test" },
			});
		});

		expect(
			await one(
				db
					.select({
						contactId: agentTask.contactId,
						companyId: agentTask.companyId,
						dealId: agentTask.dealId,
						payload: agentTask.payload,
					})
					.from(agentTask)
					.where(
						and(
							eq(agentTask.contactId, contactId),
							eq(agentTask.kind, "agent-event"),
						),
					)
					.limit(1),
			),
		).toEqual({
			contactId,
			companyId: null,
			dealId: null,
			payload: {
				type: "contact.created",
				record: { kind: "contact", id: contactId },
				occurredAt: occurredAt.toISOString(),
				data: { email: "person@example.test" },
			},
		});
	});

	it("writes durable created and closed events for the agent worker", async () => {
		const createdAt = new Date("2026-08-10T10:00:00.000Z");
		const closedAt = new Date("2026-08-10T11:00:00.000Z");

		await service.withCrmEvents(async (_tx, emit) => {
			await emit({
				type: "deal.created",
				record: { kind: "deal", id: dealId },
				occurredAt: createdAt,
				data: { companyId, stage: "DEMO_BOOKED" },
			});
			await emit({
				type: "deal.closed",
				record: { kind: "deal", id: dealId },
				occurredAt: closedAt,
				data: { companyId, from: "NEGOTIATION", to: "CLOSED_WON" },
			});
		});

		const tasks = await db
			.select({
				dealId: agentTask.dealId,
				reason: agentTask.reason,
				payload: agentTask.payload,
				finishedAt: agentTask.finishedAt,
			})
			.from(agentTask)
			.where(
				and(eq(agentTask.dealId, dealId), eq(agentTask.kind, "agent-event")),
			);

		expect(tasks).toHaveLength(2);
		expect(tasks.find((task) => task.reason === "deal.created")).toEqual({
			dealId,
			reason: "deal.created",
			payload: {
				type: "deal.created",
				record: { kind: "deal", id: dealId },
				occurredAt: createdAt.toISOString(),
				data: { companyId, stage: "DEMO_BOOKED" },
			},
			finishedAt: null,
		});
		expect(tasks.find((task) => task.reason === "deal.closed")).toEqual({
			dealId,
			reason: "deal.closed",
			payload: {
				type: "deal.closed",
				record: { kind: "deal", id: dealId },
				occurredAt: closedAt.toISOString(),
				data: { companyId, from: "NEGOTIATION", to: "CLOSED_WON" },
			},
			finishedAt: null,
		});
	});

	it("queues one Slack join for a channel that is renamed", async () => {
		await service.slackChannelJoinRequested(channelId, "deal-room");
		await service.slackChannelJoinRequested(channelId, "deal-room-renamed");

		expect(
			await db
				.select({ reason: agentTask.reason })
				.from(agentTask)
				.where(
					and(
						eq(agentTask.kind, "slack-channel-join"),
						sql`${agentTask.payload} #>> '{channelId}' = ${channelId}`,
					),
				),
		).toEqual([{ reason: "Add Comp AI to #deal-room" }]);
	});

	it("rolls back the record when its event cannot commit", async () => {
		const rollbackCompanyId = `event-rollback-company-${suffix}`;
		let error: Error | null = null;

		try {
			await service.withCrmEvents(async (tx, emit) => {
				const company = await one(
					tx
						.insert(companyTable)
						.values({
							id: rollbackCompanyId,
							name: "Rollback Event Company",
						})
						.returning({
							id: companyTable.id,
							createdAt: companyTable.createdAt,
						}),
				);
				await emit({
					type: "company.created",
					record: { kind: "company", id: company.id },
					occurredAt: company.createdAt,
					data: { name: "Rollback Event Company", domain: null },
				});
				throw new Error("Rollback the record and outbox together.");
			});
		} catch (caught) {
			error = caught as Error;
		}

		expect(error?.message).toBe("Rollback the record and outbox together.");
		expect(
			await first(
				db
					.select()
					.from(companyTable)
					.where(eq(companyTable.id, rollbackCompanyId))
					.limit(1),
			),
		).toBeNull();
		expect(
			await db.$count(
				agentTask,
				and(
					eq(agentTask.companyId, rollbackCompanyId),
					eq(agentTask.kind, "agent-event"),
				),
			),
		).toBe(0);
	});

	it("emits each real deal lifecycle transition exactly once", async () => {
		const deal = await deals.create({
			name: "Event-driven deal",
			companyId: persistedCompanyId,
			ownerId,
			amountCents: 25_000,
			currency: "USD",
		});
		persistedDealId = deal.id;

		const transitions = await Promise.all([
			deals.setStage({ id: deal.id, stage: "CLOSED_WON" }, ownerId),
			deals.setStage({ id: deal.id, stage: "CLOSED_WON" }, ownerId),
		]);

		expect(transitions.map((transition) => transition.changed).sort()).toEqual([
			false,
			true,
		]);
		await deals.setStage({ id: deal.id, stage: "QUALIFIED_TO_BUY" }, ownerId);

		const reasons = (
			await db
				.select({ reason: agentTask.reason })
				.from(agentTask)
				.where(
					and(eq(agentTask.dealId, deal.id), eq(agentTask.kind, "agent-event")),
				)
		)
			.map((task) => task.reason)
			.sort();
		expect(reasons).toEqual([
			"deal.closed",
			"deal.created",
			"deal.opened",
			"deal.stage.changed",
			"deal.stage.changed",
		]);
		expect(
			await db.$count(
				activity,
				and(eq(activity.dealId, deal.id), eq(activity.type, "STAGE_CHANGE")),
			),
		).toBe(2);
	});
});
