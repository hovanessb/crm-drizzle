import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	ActivityType,
	activity,
	calendarAttendee,
	calendarEvent,
	company as companyTable,
	contact,
	DealStage,
	Decimal,
	db,
	dealContact,
	deal as dealTable,
	EmailDirection,
	emailMessage,
	emailThread,
	firstRow,
	requireRow,
	user as userTable,
	whereEq,
} from "@crm/db";
import { readCompanyHistory, readDealHistory } from "../agent/lib/accounts";

const suffix = process.env.TEST_RUN_ID ?? "accounts-spec";
const domain = `fernhill-${suffix}.test`;

let companyId: string;
let dealId: string;
let paulaId: string;
let placeholderId: string;
let userId: string;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const daysAhead = (days: number) => new Date(Date.now() + days * 86_400_000);

beforeAll(async () => {
	await cleanup();

	const user = await requireRow(
		db
			.insert(userTable)
			.values({
				id: `user-${suffix}`,
				name: "Rep One",
				email: `rep.${suffix}@example.test`,
				emailVerified: true,
			})
			.returning({ id: userTable.id }),
	);
	userId = user.id;

	const company = await requireRow(
		db
			.insert(companyTable)
			.values({
				name: `Fernhill Systems ${suffix}`,
				domain,
				industry: "Security software",
				lastActivityAt: daysAgo(1),
			})
			.returning({ id: companyTable.id }),
	);
	companyId = company.id;

	const paula = await requireRow(
		db
			.insert(contact)
			.values({
				firstName: "Paula",
				lastName: "Marchetti",
				title: "Growth Specialist",
				email: `paula.marchetti@${domain}`,
				companyId,
				lastActivityAt: daysAgo(1),
			})
			.returning({ id: contact.id }),
	);
	paulaId = paula.id;

	const placeholder = await requireRow(
		db
			.insert(contact)
			.values({
				firstName: "Tsomerville",
				lastName: null,
				email: `tsomerville@${domain}`,
				companyId,
				lastActivityAt: daysAgo(30),
			})
			.returning({ id: contact.id }),
	);
	placeholderId = placeholder.id;

	const deal = await requireRow(
		db
			.insert(dealTable)
			.values({
				name: `Fernhill platform ${suffix}`,
				companyId,
				ownerId: userId,
				stage: DealStage.CONTRACT_SENT,
				stageChangedAt: daysAgo(42),
				amount: new Decimal(48_000),
				currency: "USD",
				expectedCloseDate: daysAhead(14),
				lastActivityAt: daysAgo(3),
			})
			.returning({ id: dealTable.id }),
	);
	await db
		.insert(dealContact)
		.values({ dealId: deal.id, contactId: paulaId, role: "Champion" });
	dealId = deal.id;

	await db.insert(activity).values([
		{
			type: ActivityType.STAGE_CHANGE,
			subject: "Stage changed",
			companyId,
			dealId,
			createdById: userId,
			createdAt: daysAgo(60),
			meta: { from: "DEMO_BOOKED", to: "QUALIFIED_TO_BUY" },
		},
		{
			type: ActivityType.STAGE_CHANGE,
			subject: "Stage changed",
			companyId,
			dealId,
			createdById: userId,
			createdAt: daysAgo(42),
			meta: { from: "QUALIFIED_TO_BUY", to: "CONTRACT_SENT" },
		},
		{
			type: ActivityType.NOTE,
			subject: "Pricing pushback",
			body: "They want the security review done before signing.",
			occurredAt: daysAgo(5),
			companyId,
			dealId,
			createdById: userId,
		},
		{
			type: ActivityType.EMAIL,
			subject: "Re: Contract",
			companyId,
			dealId,
			createdById: userId,
		},
	]);

	const thread = await requireRow(
		db
			.insert(emailThread)
			.values({
				rootMessageId: `<root.${suffix}@example.test>`,
				subject: "Re: Contract",
				companyId,
				contactId: paulaId,
				firstMessageAt: daysAgo(9),
				lastMessageAt: daysAgo(3),
				messageCount: 2,
			})
			.returning({ id: emailThread.id }),
	);

	await db.insert(emailMessage).values([
		{
			threadId: thread.id,
			rfcMessageId: `<out.${suffix}@example.test>`,
			direction: EmailDirection.OUTBOUND,
			fromEmail: `rep.${suffix}@example.test`,
			recipients: [],
			subject: "Contract",
			body: "Sending the paperwork over.",
			sentAt: daysAgo(9),
		},
		{
			threadId: thread.id,
			rfcMessageId: `<in.${suffix}@example.test>`,
			direction: EmailDirection.INBOUND,
			fromEmail: `paula.marchetti@${domain}`,
			fromName: "Paula Marchetti",
			recipients: [],
			subject: "Re: Contract",
			body: "Thanks — Paula Marchetti, Growth Specialist, Fernhill.",
			sentAt: daysAgo(3),
		},
	]);

	const event = await requireRow(
		db
			.insert(calendarEvent)
			.values({
				iCalUid: `event.${suffix}@example.test`,
				originalStartTime: daysAhead(4),
				title: "Security review",
				startsAt: daysAhead(4),
				endsAt: daysAhead(4),
				status: "confirmed",
				companyId,
				contactId: paulaId,
			})
			.returning(),
	);
	await db.insert(calendarAttendee).values({
		eventId: event.id,
		email: `paula.marchetti@${domain}`,
		name: "Paula Marchetti",
	});
});

afterAll(cleanup);

async function cleanup(): Promise<void> {
	const company = await firstRow(
		db
			.select({ id: companyTable.id })
			.from(companyTable)
			.where(whereEq(companyTable.domain, domain))
			.limit(1),
	);

	if (company) {
		await db.delete(activity).where(whereEq(activity.companyId, company.id));
		await db
			.delete(calendarEvent)
			.where(whereEq(calendarEvent.companyId, company.id));
		await db
			.delete(emailThread)
			.where(whereEq(emailThread.companyId, company.id));
		await db.delete(dealTable).where(whereEq(dealTable.companyId, company.id));
		await db.delete(contact).where(whereEq(contact.companyId, company.id));
		await requireRow(
			db
				.delete(companyTable)
				.where(whereEq(companyTable.id, company.id))
				.returning(),
		);
	}

	await db
		.delete(userTable)
		.where(whereEq(userTable.email, `rep.${suffix}@example.test`));
}

describe("readCompanyHistory", () => {
	it("names every contact at the company, with their id", async () => {
		const history = await readCompanyHistory(companyId);

		expect(history?.people.map((person) => person.id).sort()).toEqual(
			[paulaId, placeholderId].sort(),
		);
		expect(history?.people.find((person) => person.id === paulaId)?.title).toBe(
			"Growth Specialist",
		);
	});

	it("flags a contact still named after their email address", async () => {
		const history = await readCompanyHistory(companyId);
		const people = Object.fromEntries(
			(history?.people ?? []).map((person) => [
				person.id,
				person.needsIdentity,
			]),
		);

		expect(people[placeholderId]).toBe(true);
		expect(people[paulaId]).toBe(false);
	});

	it("returns the deals with stage, value and who is on them", async () => {
		const history = await readCompanyHistory(companyId);
		const deal = history?.deals.find((row) => row.id === dealId);

		expect(deal?.stage).toBe("CONTRACT_SENT");
		expect(deal?.open).toBe(true);
		expect(deal?.amount).toBe(48_000);
		expect(deal?.contacts).toEqual([
			{ id: paulaId, name: "Paula Marchetti", role: "Champion" },
		]);
		expect(history?.stats.openDeals).toBe(1);
	});

	it("reads the correspondence and knows they replied", async () => {
		const history = await readCompanyHistory(companyId);

		expect(history?.threads[0]?.subject).toBe("Re: Contract");
		expect(history?.threads[0]?.contact?.id).toBe(paulaId);
		expect(history?.threads[0]?.messages[0]?.body).toContain(
			"Growth Specialist",
		);
		expect(history?.stats.theyReplied).toBe(true);
		expect(history?.stats.lastReplyFrom).toBe("Paula Marchetti");
		expect(history?.stats.nextMeetingAt).not.toBeNull();
	});

	it("leaves email and meeting projections out of the notes", async () => {
		const history = await readCompanyHistory(companyId);

		expect(history?.notes.map((note) => note.subject)).toEqual([
			"Pricing pushback",
		]);
	});

	it("omits connected history when the caller did not approve those sources", async () => {
		const history = await readCompanyHistory(companyId, {
			includeEmail: false,
			includeCalendar: false,
		});

		expect(history?.threads).toEqual([]);
		expect(history?.meetings).toEqual([]);
		expect(history?.stats.emails).toBe(0);
		expect(history?.stats.meetings).toBe(0);
		expect(history?.stats.lastReplyAt).toBeNull();
		expect(history?.stats.nextMeetingAt).toBeNull();
		expect(
			history?.people.every(
				(person) => person.threads === 0 && person.meetings === 0,
			),
		).toBe(true);
	});

	it("returns null for a company that does not exist", async () => {
		expect(await readCompanyHistory("nope")).toBeNull();
	});
});

describe("readDealHistory", () => {
	it("reports the stage clock, not just the stage", async () => {
		const history = await readDealHistory(dealId);

		expect(history?.deal.stage).toBe("CONTRACT_SENT");
		expect(history?.deal.open).toBe(true);
		expect(history?.deal.daysInStage).toBeGreaterThanOrEqual(41);
	});

	it("returns every stage it moved through, oldest first", async () => {
		const history = await readDealHistory(dealId);

		expect(history?.stageHistory.map((change) => change.to)).toEqual([
			"QUALIFIED_TO_BUY",
			"CONTRACT_SENT",
		]);
	});

	it("names who is on it, with ids and roles", async () => {
		const history = await readDealHistory(dealId);

		expect(history?.people).toEqual([
			{
				id: paulaId,
				name: "Paula Marchetti",
				title: "Growth Specialist",
				email: `paula.marchetti@${domain}`,
				role: "Champion",
			},
		]);
		expect(history?.company.id).toBe(companyId);
	});

	it("says the correspondence is the account's, not the deal's", async () => {
		const history = await readDealHistory(dealId);

		expect(history?.threads).toHaveLength(1);
		expect(history?.stats.theyReplied).toBe(true);
		expect(history?.note).toContain("never against a deal");
	});

	it("omits deal correspondence when connected sources are not approved", async () => {
		const history = await readDealHistory(dealId, {
			includeEmail: false,
			includeCalendar: false,
		});

		expect(history?.threads).toEqual([]);
		expect(history?.meetings).toEqual([]);
		expect(history?.stats.theyReplied).toBe(false);
		expect(history?.stats.nextMeetingAt).toBeNull();
		expect(history?.note).toContain("outside this agent version");
	});

	it("returns null for a deal that does not exist", async () => {
		expect(await readDealHistory("nope")).toBeNull();
	});
});
