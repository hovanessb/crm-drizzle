import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	activity,
	agentTask,
	and,
	company as companyTable,
	contact as contactTable,
	db,
	deal as dealTable,
	endsWith,
	eq,
	inArray,
	type PgColumn,
	suppressedContact,
	user,
} from "@crm/db";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompaniesService } from "../src/companies/companies.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import type { FaviconService } from "../src/companies/favicon.service";
import { ContactsService } from "../src/contacts/contacts.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ConversionService } from "../src/currency/conversion.service";
import { DealsService } from "../src/deals/deals.service";
import { FieldsService } from "../src/fields/fields.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { first, one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "bulk-spec";
const domain = `bulk-${suffix}.test`;
const ownerId = `owner-${suffix}`;
const secondOwnerId = `second-owner-${suffix}`;
const ours = (email: PgColumn) => endsWith(email, `@${domain}`);

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	companyRequested: async () => true,
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;

const stamp = new ActivityStampService(db);
const queue = new AgentQueueService(db);
const conversion = new ConversionService(db);
const directory = new CompanyDirectoryService(agent);

const fields = new FieldsService(db, agent);
const contacts = new ContactsService(
	db,
	directory,
	agent,
	queue,
	stamp,
	fields,
);
const companies = new CompaniesService(
	db,
	agent,
	queue,
	{ backfill: async () => undefined } as unknown as FaviconService,
	stamp,
	conversion,
	fields,
);
const deals = new DealsService(db, agent, stamp, conversion, fields);

let companyId: string;

async function clean() {
	const owned = await db
		.select({ id: companyTable.id })
		.from(companyTable)
		.where(endsWith(companyTable.domain, domain));
	const companyIds = owned.map((row) => row.id);

	await db.delete(dealTable).where(inArray(dealTable.companyId, companyIds));
	await db.delete(activity).where(inArray(activity.companyId, companyIds));
	await db.delete(agentTask).where(inArray(agentTask.companyId, companyIds));
	await db.delete(contactTable).where(ours(contactTable.email));
	await db.delete(suppressedContact).where(ours(suppressedContact.email));
	await db.delete(companyTable).where(endsWith(companyTable.domain, domain));
	await db.delete(user).where(inArray(user.id, [ownerId, secondOwnerId]));
}

beforeAll(async () => {
	await clean();

	await db.insert(user).values([
		{ id: ownerId, name: "First Rep", email: `first@${domain}` },
		{ id: secondOwnerId, name: "Second Rep", email: `second@${domain}` },
	]);

	const company = await one(
		db
			.insert(companyTable)
			.values({ name: `Bulk Co ${suffix}`, domain })
			.returning({ id: companyTable.id }),
	);
	companyId = company.id;
});

afterAll(clean);

describe("assigning an owner to a selection", () => {
	it("moves every record it was given", async () => {
		const first = await contacts.create({
			firstName: "Ada",
			email: `ada@${domain}`,
			ownerId,
		});
		const second = await contacts.create({
			firstName: "Grace",
			email: `grace@${domain}`,
			ownerId,
		});

		expect(
			await contacts.bulkAssignOwner({
				ids: [first.id, second.id],
				ownerId: secondOwnerId,
			}),
		).toEqual({
			requested: 2,
			succeeded: 2,
			skipped: 0,
			failed: 0,
			message: null,
		});

		expect(
			await db.$count(
				contactTable,
				and(
					inArray(contactTable.id, [first.id, second.id]),
					eq(contactTable.ownerId, secondOwnerId),
				),
			),
		).toBe(2);
	});

	it("counts the same record once, however many times it was sent", async () => {
		const only = await contacts.create({
			firstName: "Edsger",
			email: `edsger@${domain}`,
		});

		expect(
			await contacts.bulkAssignOwner({
				ids: [only.id, only.id],
				ownerId,
			}),
		).toEqual({
			requested: 1,
			succeeded: 1,
			skipped: 0,
			failed: 0,
			message: null,
		});
	});

	it("refuses an owner who does not work here", async () => {
		const contact = await contacts.create({
			firstName: "Alan",
			email: `alan@${domain}`,
		});

		let refused: Error | null = null;
		try {
			await contacts.bulkAssignOwner({
				ids: [contact.id],
				ownerId: `nobody-${suffix}`,
			});
		} catch (cause) {
			refused = cause as Error;
		}
		expect(refused?.message).toMatch(/does not work here/);

		expect(
			await first(
				db
					.select({ ownerId: contactTable.ownerId })
					.from(contactTable)
					.where(eq(contactTable.id, contact.id))
					.limit(1),
			),
		).toEqual({ ownerId: null });
	});
});

describe("purging a selection", () => {
	it("suppresses every address, exactly as deleting them one by one would", async () => {
		const first = await contacts.create({
			firstName: "Gone",
			email: `gone@${domain}`,
		});
		const second = await contacts.create({
			firstName: "Also Gone",
			email: `also-gone@${domain}`,
		});

		expect(await contacts.bulkPurge([first.id, second.id])).toEqual({
			requested: 2,
			succeeded: 2,
			skipped: 0,
			failed: 0,
			message: null,
		});

		expect(
			await db.$count(
				suppressedContact,
				inArray(suppressedContact.email, [
					`gone@${domain}`,
					`also-gone@${domain}`,
				]),
			),
		).toBe(2);
	});

	it("finishes the rest and says what it could not do", async () => {
		const survivor = await contacts.create({
			firstName: "Doomed",
			email: `doomed@${domain}`,
		});

		const result = await contacts.bulkPurge([survivor.id, `missing-${suffix}`]);

		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.message).toMatch(/No contact with id/);
		expect(
			await first(
				db
					.select()
					.from(contactTable)
					.where(eq(contactTable.id, survivor.id))
					.limit(1),
			),
		).toBeNull();
	});

	it("takes a company's deals with it", async () => {
		const doomed = await companies.create({
			name: `Doomed Co ${suffix}`,
			domain: `doomed-${domain}`,
		});
		const deal = await deals.create({
			name: `Doomed deal ${suffix}`,
			companyId: doomed.id,
			ownerId,
		});

		expect(await companies.bulkPurge([doomed.id])).toEqual({
			requested: 1,
			succeeded: 1,
			skipped: 0,
			failed: 0,
			message: null,
		});

		expect(
			await first(
				db.select().from(dealTable).where(eq(dealTable.id, deal.id)).limit(1),
			),
		).toBeNull();
	});
});

describe("moving a selection of deals to a stage", () => {
	it("will not close them as lost without a reason", async () => {
		const deal = await deals.create({
			name: `Unreasoned ${suffix}`,
			companyId,
			ownerId,
		});

		let refused: Error | null = null;
		try {
			await deals.bulkSetStage(
				{ ids: [deal.id], stage: "CLOSED_LOST" },
				ownerId,
			);
		} catch (cause) {
			refused = cause as Error;
		}
		expect(refused?.message).toMatch(/teaches nobody anything/);

		expect(
			await first(
				db
					.select({ stage: dealTable.stage })
					.from(dealTable)
					.where(eq(dealTable.id, deal.id))
					.limit(1),
			),
		).toEqual({ stage: "DEMO_BOOKED" });
	});

	it("writes the one reason onto every deal's timeline", async () => {
		const first = await deals.create({
			name: `Lost one ${suffix}`,
			companyId,
			ownerId,
		});
		const second = await deals.create({
			name: `Lost two ${suffix}`,
			companyId,
			ownerId,
		});

		expect(
			await deals.bulkSetStage(
				{
					ids: [first.id, second.id],
					stage: "CLOSED_LOST",
					closedReason: "Budget pulled",
				},
				ownerId,
			),
		).toEqual({
			requested: 2,
			succeeded: 2,
			skipped: 0,
			failed: 0,
			message: null,
		});

		const closed = await db
			.select({
				stage: dealTable.stage,
				closedReason: dealTable.closedReason,
				closedAt: dealTable.closedAt,
			})
			.from(dealTable)
			.where(inArray(dealTable.id, [first.id, second.id]));

		expect(closed.every((deal) => deal.stage === "CLOSED_LOST")).toBe(true);
		expect(closed.every((deal) => deal.closedReason === "Budget pulled")).toBe(
			true,
		);
		expect(closed.every((deal) => deal.closedAt !== null)).toBe(true);

		expect(
			await db.$count(
				activity,
				and(
					inArray(activity.dealId, [first.id, second.id]),
					eq(activity.type, "STAGE_CHANGE"),
					eq(activity.body, "Budget pulled"),
				),
			),
		).toBe(2);
	});
});
