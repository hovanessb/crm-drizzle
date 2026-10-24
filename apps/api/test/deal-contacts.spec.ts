import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	company as companyTable,
	contact,
	contact as contactTable,
	db,
	deal as dealTable,
	eq,
	inArray,
	user,
} from "@crm/db";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ConversionService } from "../src/currency/conversion.service";
import { DealsService } from "../src/deals/deals.service";
import { FieldsService } from "../src/fields/fields.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "deal-contacts-spec";
const userId = `user-${suffix}`;
const domain = `dealpeople-${suffix}.test`;
const otherDomain = `elsewhere-${suffix}.test`;

const agent = {
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;

const deals = new DealsService(
	db,
	agent,
	new ActivityStampService(db),
	new ConversionService(db),
	new FieldsService(db, { fieldBackfill: async () => undefined } as never),
);

let companyId: string;
let dealId: string;
let championId: string;
let colleagueId: string;
let outsiderId: string;

async function clean() {
	await db
		.delete(dealTable)
		.where(
			inArray(
				dealTable.companyId,
				db
					.select({ id: companyTable.id })
					.from(companyTable)
					.where(eq(companyTable.domain, domain)),
			),
		);
	await db.delete(contactTable).where(
		inArray(
			contactTable.companyId,
			db
				.select({ id: companyTable.id })
				.from(companyTable)
				.where(inArray(companyTable.domain, [domain, otherDomain])),
		),
	);
	await db
		.delete(companyTable)
		.where(inArray(companyTable.domain, [domain, otherDomain]));
	await db.delete(user).where(eq(user.id, userId));
}

beforeAll(async () => {
	await clean();

	await one(
		db
			.insert(user)
			.values({
				id: userId,
				name: "Deal Rep",
				email: `${userId}@example.test`,
				emailVerified: true,
			})
			.returning(),
	);

	const company = await one(
		db
			.insert(companyTable)
			.values({ name: `People Co ${suffix}`, domain })
			.returning({ id: companyTable.id }),
	);
	companyId = company.id;

	const other = await one(
		db
			.insert(companyTable)
			.values({ name: `Other Co ${suffix}`, domain: otherDomain })
			.returning({ id: companyTable.id }),
	);

	const champion = await one(
		db
			.insert(contact)
			.values({ firstName: "Ada", lastName: "Champion", companyId })
			.returning({ id: contact.id }),
	);
	championId = champion.id;

	const colleague = await one(
		db
			.insert(contact)
			.values({ firstName: "Beau", lastName: "Colleague", companyId })
			.returning({ id: contact.id }),
	);
	colleagueId = colleague.id;

	const outsider = await one(
		db
			.insert(contact)
			.values({ firstName: "Cass", lastName: "Outsider", companyId: other.id })
			.returning({ id: contact.id }),
	);
	outsiderId = outsider.id;

	const deal = await deals.create({
		name: `Renewal ${suffix}`,
		companyId,
		ownerId: userId,
	});
	dealId = deal.id;
});

afterAll(clean);

describe("bringing a contact onto a deal", () => {
	it("offers the people at the deal's company and nobody else", async () => {
		const options = await deals.contactOptions(dealId);
		const ids = options.map((option) => option.id);

		expect(ids).toContain(championId);
		expect(ids).toContain(colleagueId);
		expect(ids).not.toContain(outsiderId);
	});

	it("attaches with a role and reads back on the deal", async () => {
		await deals.attachContact({
			dealId,
			contactId: championId,
			role: "Champion",
		});

		const deal = await deals.byId(dealId);

		expect(deal.contacts).toHaveLength(1);
		expect(deal.contacts[0]?.id).toBe(championId);
		expect(deal.contacts[0]?.role).toBe("Champion");
	});

	it("stops offering somebody already on it", async () => {
		const options = await deals.contactOptions(dealId);

		expect(options.map((option) => option.id)).not.toContain(championId);
	});

	it("attaching twice keeps the role it already has", async () => {
		await deals.attachContact({ dealId, contactId: championId });

		const deal = await deals.byId(dealId);

		expect(deal.contacts).toHaveLength(1);
		expect(deal.contacts[0]?.role).toBe("Champion");
	});

	it("refuses somebody who works somewhere else", async () => {
		await expect(
			deals.attachContact({ dealId, contactId: outsiderId }),
		).rejects.toThrow(`That contact does not work at People Co ${suffix}.`);
	});

	it("blanks a role rather than storing an empty string", async () => {
		await deals.setContactRole({ dealId, contactId: championId, role: "  " });

		const deal = await deals.byId(dealId);

		expect(deal.contacts[0]?.role).toBeNull();
	});

	it("will not set a role on somebody who is not on the deal", async () => {
		await expect(
			deals.setContactRole({
				dealId,
				contactId: colleagueId,
				role: "Blocker",
			}),
		).rejects.toThrow("That contact is not on this deal.");
	});

	it("takes them off again, leaving the contact in the CRM", async () => {
		await deals.detachContact({ dealId, contactId: championId });

		const deal = await deals.byId(dealId);

		expect(deal.contacts).toHaveLength(0);
		expect(await db.$count(contact, eq(contact.id, championId))).toBe(1);
	});

	it("says so when they were never on it", async () => {
		await expect(
			deals.detachContact({ dealId, contactId: championId }),
		).rejects.toThrow("That contact is not on this deal.");
	});
});
