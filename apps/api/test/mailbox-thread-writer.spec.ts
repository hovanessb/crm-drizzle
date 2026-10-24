import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	activity,
	company as companyTable,
	contact,
	db,
	emailMessage,
	emailThread,
	eq,
	inArray,
	type MailboxSync,
	mailboxSync,
	user,
} from "@crm/db";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import {
	type IncomingMessage,
	ThreadWriterService,
} from "../src/mailbox/thread-writer.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { first, one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "thread-writer-spec";
const domain = `threads-${suffix}.test`;
const userId = `user-${suffix}`;
const mailbox = `rep-${suffix}@example.test`;
const person = `buyer@${domain}`;
const rootId = `<root-${suffix}@mail.test>`;
const movedRoot = `outlook-conversation:${suffix}`;

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	withCrmEvents: withDiscardedCrmEvents,
	companyRequested: async () => true,
} as unknown as AgentTriggerService;

const stamp = new ActivityStampService(db);
const directory = new CompanyDirectoryService(agent);
const log = new EnrichmentLogService(db, stamp);
const match = new MailboxMatchService(db, directory, agent, log);
const threads = new ThreadWriterService(db, match, stamp);

let row: MailboxSync;

function message(id: string, sentAt: Date, root = rootId): IncomingMessage {
	return {
		rfcMessageId: id,
		rootId: root,
		subject: "Pricing",
		from: { email: mailbox, name: "Test Rep" },
		recipients: [{ email: person, name: "A Buyer", kind: "to" }],
		body: "The numbers you asked for.",
		sentAt,
		gmailMessageId: null,
		outlookMessageId: null,
		outlookWebLink: null,
	};
}

async function clean() {
	await db
		.delete(emailThread)
		.where(inArray(emailThread.rootMessageId, [rootId, movedRoot]));
	await db.delete(contact).where(eq(contact.email, person));
	await db.delete(companyTable).where(eq(companyTable.domain, domain));
	await db.delete(mailboxSync).where(eq(mailboxSync.userId, userId));
	await db.delete(user).where(eq(user.id, userId));
}

beforeAll(async () => {
	await clean();

	await one(
		db
			.insert(user)
			.values({ id: userId, name: "Test Rep", email: mailbox })
			.returning(),
	);
	row = await one(
		db
			.insert(mailboxSync)
			.values({ userId, source: "gmail", autoCreate: false })
			.returning(),
	);

	const company = await one(
		db
			.insert(companyTable)
			.values({ name: "Buyer Co", domain })
			.returning({ id: companyTable.id }),
	);
	await one(
		db
			.insert(contact)
			.values({
				firstName: "A",
				lastName: "Buyer",
				email: person,
				companyId: company.id,
			})
			.returning(),
	);
});

afterAll(clean);

describe("storing a synced email", () => {
	it("writes the message, the counts and the activity together", async () => {
		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(`<one-${suffix}@mail.test>`, new Date("2026-01-01T10:00:00Z")),
			await threads.context(),
		);

		expect(stored).toBe(true);

		const thread = await db.query.emailThread.findFirst({
			where: eq(emailThread.rootMessageId, rootId),
			columns: { id: true, messageCount: true },
			with: { activity: { columns: { id: true } } },
		});

		expect(thread?.messageCount).toBe(1);
		expect(thread?.activity).not.toBeNull();
	});

	it("repairs a thread whose projection was lost rather than skipping it forever", async () => {
		const thread = await first(
			db
				.select({ id: emailThread.id })
				.from(emailThread)
				.where(eq(emailThread.rootMessageId, rootId))
				.limit(1),
		);
		if (!thread) throw new Error("the first message was not stored");

		await db.delete(activity).where(eq(activity.emailThreadId, thread.id));
		await one(
			db
				.update(emailThread)
				.set({ messageCount: 0 })
				.where(eq(emailThread.id, thread.id))
				.returning(),
		);

		const stored = await threads.store(
			row,
			{ mailbox, origin: "gmail" },
			message(`<one-${suffix}@mail.test>`, new Date("2026-01-01T10:00:00Z")),
			await threads.context(),
		);

		expect(stored).toBe(false);

		const repaired = await db.query.emailThread.findFirst({
			where: eq(emailThread.id, thread.id),
			columns: { messageCount: true },
			with: { activity: { columns: { id: true } } },
		});

		expect(repaired?.messageCount).toBe(1);
		expect(repaired?.activity).not.toBeNull();
	});

	it("lets one of two concurrent syncs win without failing the other", async () => {
		const parsed = message(
			`<race-${suffix}@mail.test>`,
			new Date("2026-01-02T10:00:00Z"),
		);
		const context = await threads.context();

		const results = await Promise.all([
			threads.store(row, { mailbox, origin: "gmail" }, parsed, context),
			threads.store(row, { mailbox, origin: "outlook" }, parsed, context),
		]);

		expect(results.filter(Boolean)).toHaveLength(1);
		expect(
			await db.$count(
				emailMessage,
				eq(emailMessage.rfcMessageId, parsed.rfcMessageId),
			),
		).toBe(1);

		const thread = await db.query.emailThread.findFirst({
			where: eq(emailThread.rootMessageId, rootId),
			columns: { messageCount: true },
			with: { activity: { columns: { id: true } } },
		});

		expect(thread?.messageCount).toBe(2);
		expect(thread?.activity).not.toBeNull();
	});

	it("repairs the thread the message is already on when the root id has moved", async () => {
		const thread = await first(
			db
				.select({ id: emailThread.id })
				.from(emailThread)
				.where(eq(emailThread.rootMessageId, rootId))
				.limit(1),
		);
		if (!thread) throw new Error("the first message was not stored");

		await db.delete(activity).where(eq(activity.emailThreadId, thread.id));
		await one(
			db
				.update(emailThread)
				.set({ messageCount: 0 })
				.where(eq(emailThread.id, thread.id))
				.returning(),
		);

		const stored = await threads.store(
			row,
			{ mailbox, origin: "outlook" },
			message(
				`<race-${suffix}@mail.test>`,
				new Date("2026-01-02T10:00:00Z"),
				movedRoot,
			),
			await threads.context(),
		);

		expect(stored).toBe(false);
		expect(
			await db.$count(emailThread, eq(emailThread.rootMessageId, movedRoot)),
		).toBe(0);

		const repaired = await db.query.emailThread.findFirst({
			where: eq(emailThread.id, thread.id),
			columns: { messageCount: true },
			with: { activity: { columns: { id: true } } },
		});

		expect(repaired?.messageCount).toBe(2);
		expect(repaired?.activity).not.toBeNull();
	});
});
