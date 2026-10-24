import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	activity,
	and,
	company,
	contact as contactTable,
	contains,
	db,
	endsWith,
	eq,
	formSubmission,
	inArray,
	startsWith,
	suppressedContact,
	suppressedDomain,
	trackedVisitor,
	trackingCounter,
	user as userTable,
} from "@crm/db";
import {
	CONTACT_CAP_REASON,
	CONTACTS_PER_HOUR,
	contactWindowKey,
} from "@crm/db/tracking";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { TrackingCounterService } from "../src/tracking/tracking-counter.service";
import { TrackingFilingService } from "../src/tracking/tracking-filing.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { first, one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "filing-spec";
const domain = `visitors-${suffix}.test`;
const host = `www.${domain}`;

const queued: string[] = [];

const agent = {
	contactCreated: async (id: string) => {
		queued.push(id);
		return true;
	},
	companyCreated: async () => undefined,
	companyRequested: async () => true,
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;

const stamp = new ActivityStampService(db);
const counters = new TrackingCounterService(db);
const directory = new CompanyDirectoryService(agent);
const filing = new TrackingFilingService(db, counters, directory, agent, stamp);

let userId: string;

async function submit(email: string | null, name: string | null = "Dana Reed") {
	const row = await one(
		db
			.insert(formSubmission)
			.values({
				host,
				path: "/pricing",
				email,
				fields: name ? { name, email: email ?? "" } : {},
				dedupeKey: `${suffix}-${Math.random().toString(36).slice(2)}`,
			})
			.returning({ id: formSubmission.id }),
	);

	const outcome = await filing.file({
		id: row.id,
		email,
		host,
		visitorId: `visitor-${Math.random().toString(36).slice(2, 12)}`,
		name,
	});

	const stored = await first(
		db
			.select({
				contactId: formSubmission.contactId,
				filedAt: formSubmission.filedAt,
				skipReason: formSubmission.skipReason,
			})
			.from(formSubmission)
			.where(eq(formSubmission.id, row.id))
			.limit(1),
	);

	return { outcome, stored };
}

async function clean() {
	await db.delete(activity).where(contains(activity.body, host));
	await db.delete(formSubmission).where(eq(formSubmission.host, host));
	await db
		.delete(trackedVisitor)
		.where(startsWith(trackedVisitor.id, "visitor-"));
	await db
		.delete(contactTable)
		.where(endsWith(contactTable.email, `@${domain}`));
	await db
		.delete(contactTable)
		.where(eq(contactTable.email, `free-${suffix}@gmail.com`));
	await db.delete(company).where(eq(company.domain, domain));
	await db
		.delete(suppressedContact)
		.where(endsWith(suppressedContact.email, `@${domain}`));
	await db.delete(suppressedDomain).where(eq(suppressedDomain.domain, domain));
	await db.delete(trackingCounter);
}

beforeAll(async () => {
	await clean();

	const user = await first(
		db.select({ id: userTable.id }).from(userTable).limit(1),
	);
	userId =
		user?.id ??
		(
			await one(
				db
					.insert(userTable)
					.values({
						id: `user-${suffix}`,
						name: "Test Rep",
						email: `rep-${suffix}@example.test`,
					})
					.returning({ id: userTable.id }),
			)
		).id;
});

beforeEach(async () => {
	queued.length = 0;
	await db.delete(trackingCounter);
});

afterAll(async () => {
	await clean();
	if (userId.startsWith(`user-${suffix}`)) {
		await db.delete(userTable).where(eq(userTable.id, userId));
	}
});

describe("filing a form submission", () => {
	it("refuses an address no human reads", async () => {
		const { outcome, stored } = await submit(`noreply@${domain}`);

		expect(outcome.filed).toBe(false);
		expect(stored?.contactId).toBeNull();
		expect(stored?.skipReason).toBeTruthy();
	});

	it("refuses a submission with no address at all", async () => {
		const { outcome, stored } = await submit(null);

		expect(outcome.filed).toBe(false);
		expect(stored?.skipReason).toBe("No email address");
	});

	it("refuses an address a rep has deleted", async () => {
		const email = `deleted@${domain}`;
		await one(db.insert(suppressedContact).values({ email }).returning());

		const { outcome, stored } = await submit(email);

		expect(outcome.filed).toBe(false);
		expect(stored?.skipReason).toContain("deleted");
	});

	it("refuses a suppressed domain", async () => {
		await one(db.insert(suppressedDomain).values({ domain }).returning());

		const { outcome, stored } = await submit(`someone@${domain}`);

		expect(outcome.filed).toBe(false);
		expect(stored?.skipReason).toContain("suppressed");

		await db
			.delete(suppressedDomain)
			.where(eq(suppressedDomain.domain, domain));
	});

	it("files a free-mail address as a contact with no company", async () => {
		const { outcome, stored } = await submit(`free-${suffix}@gmail.com`);

		expect(outcome.filed).toBe(true);
		expect(stored?.filedAt).not.toBeNull();

		const contact = await first(
			db
				.select({
					companyId: contactTable.companyId,
					source: contactTable.source,
				})
				.from(contactTable)
				.where(eq(contactTable.email, `free-${suffix}@gmail.com`))
				.limit(1),
		);

		expect(contact?.companyId).toBeNull();
		expect(contact?.source).toBe("TRACKING");
	});

	it("files a work address and queues the agent once", async () => {
		const email = `dana@${domain}`;
		const { outcome, stored } = await submit(email);

		expect(outcome.filed).toBe(true);
		expect(stored?.contactId).toBeTruthy();
		expect(queued).toHaveLength(1);

		const contact = await first(
			db
				.select({
					companyId: contactTable.companyId,
					firstName: contactTable.firstName,
				})
				.from(contactTable)
				.where(eq(contactTable.email, email))
				.limit(1),
		);

		expect(contact?.companyId).toBeTruthy();
		expect(contact?.firstName).toBe("Dana");
	});

	it("writes one note when the same submission is filed twice at once", async () => {
		const email = `raced@${domain}`;
		const row = await one(
			db
				.insert(formSubmission)
				.values({
					host,
					path: "/pricing",
					email,
					fields: { email },
					dedupeKey: `${suffix}-raced`,
				})
				.returning({ id: formSubmission.id }),
		);

		const file = () =>
			filing.file({
				id: row.id,
				email,
				host,
				visitorId: `visitor-raced-${suffix}`.slice(0, 64),
				name: "Dana Reed",
			});

		const [first, second] = await Promise.all([file(), file()]);

		expect(first.filed).toBe(true);
		expect(second.filed).toBe(true);
		expect(await db.$count(contactTable, eq(contactTable.email, email))).toBe(
			1,
		);

		const notes = await db.$count(
			activity,
			and(
				contains(activity.body, host),
				inArray(
					activity.contactId,
					db
						.select({ id: contactTable.id })
						.from(contactTable)
						.where(eq(contactTable.email, email)),
				),
			),
		);

		expect(notes).toBe(1);
	});

	it("gives the cap slot back to the delivery that lost the create", async () => {
		const email = `refunded@${domain}`;
		const rows = await Promise.all(
			[1, 2].map((n) =>
				one(
					db
						.insert(formSubmission)
						.values({
							host,
							path: "/pricing",
							email,
							fields: { email },
							dedupeKey: `${suffix}-refunded-${n}`,
						})
						.returning({ id: formSubmission.id }),
				),
			),
		);

		await Promise.all(
			rows.map((row) =>
				filing.file({
					id: row.id,
					email,
					host,
					visitorId: null,
					name: "Dana Reed",
				}),
			),
		);

		expect(await db.$count(contactTable, eq(contactTable.email, email))).toBe(
			1,
		);

		const counter = await first(
			db
				.select({ value: trackingCounter.value })
				.from(trackingCounter)
				.where(eq(trackingCounter.key, contactWindowKey()))
				.limit(1),
		);

		expect(counter?.value).toBe(1);
	});

	it("attaches a second submission to the contact already there", async () => {
		const email = `repeat@${domain}`;

		const first = await submit(email);
		queued.length = 0;
		const second = await submit(email);

		expect(first.outcome.filed).toBe(true);
		expect(second.outcome.filed).toBe(true);
		expect(second.stored?.contactId).toBe(first.stored?.contactId ?? "");
		expect(queued).toHaveLength(0);

		const count = await db.$count(contactTable, eq(contactTable.email, email));
		expect(count).toBe(1);
	});

	it("stores but does not file once the hourly cap is reached", async () => {
		await db
			.insert(trackingCounter)
			.values({
				key: contactWindowKey(),
				value: CONTACTS_PER_HOUR,
				expiresAt: new Date(Date.now() + 3_600_000),
			})
			.onConflictDoUpdate({
				target: trackingCounter.key,
				set: { value: CONTACTS_PER_HOUR },
			});

		const { outcome, stored } = await submit(`capped@${domain}`);

		expect(outcome.filed).toBe(false);
		expect(stored?.contactId).toBeNull();
		expect(stored?.skipReason).toBe(CONTACT_CAP_REASON);
	});
});

describe("the hourly counter", () => {
	it("counts up and refuses past the limit", async () => {
		const key = `contacts:test-${suffix}`;

		expect(await counters.take(key, 2)).toBe(true);
		expect(await counters.take(key, 2)).toBe(true);
		expect(await counters.take(key, 2)).toBe(false);
		expect(await counters.take(key, 2)).toBe(false);

		await db.delete(trackingCounter).where(eq(trackingCounter.key, key));
	});

	it("keeps a fixed window rather than sliding on every write", async () => {
		const key = contactWindowKey();

		await counters.take(key, 10);
		const initial = await first(
			db
				.select()
				.from(trackingCounter)
				.where(eq(trackingCounter.key, key))
				.limit(1),
		);

		await counters.take(key, 10);
		const second = await first(
			db
				.select()
				.from(trackingCounter)
				.where(eq(trackingCounter.key, key))
				.limit(1),
		);

		expect(second?.expiresAt.getTime()).toBe(initial?.expiresAt.getTime() ?? 0);
		expect(second?.value).toBe(2);
	});
});
