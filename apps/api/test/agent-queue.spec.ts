import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	agentTask,
	company as companyTable,
	contact as contactTable,
	db,
	eq,
} from "@crm/db";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import { one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "agent-queue-spec";
const email = `badge-${suffix}@example.test`;
const name = `Badge Co ${suffix}`;
const kind = "test-queue-badge";

const queue = new AgentQueueService(db);

const DAY_MS = 86_400_000;

let contactId: string;
let companyId: string;

async function clean() {
	await db.delete(agentTask).where(eq(agentTask.kind, kind));
	await db.delete(contactTable).where(eq(contactTable.email, email));
	await db.delete(companyTable).where(eq(companyTable.name, name));
}

beforeAll(async () => {
	await clean();

	const contact = await one(
		db
			.insert(contactTable)
			.values({ firstName: "Badge", lastName: "Later", email })
			.returning({ id: contactTable.id }),
	);
	const company = await one(
		db.insert(companyTable).values({ name }).returning({ id: companyTable.id }),
	);

	contactId = contact.id;
	companyId = company.id;

	await one(
		db
			.insert(agentTask)
			.values({
				kind,
				reason: "recheck in three months",
				dueAt: new Date(Date.now() + 90 * DAY_MS),
				budget: 4,
				contactId,
			})
			.returning(),
	);

	await one(
		db
			.insert(agentTask)
			.values({
				kind,
				reason: "due now",
				dueAt: new Date(Date.now() - 60_000),
				budget: 4,
				companyId,
			})
			.returning(),
	);
});

afterAll(clean);

describe("the queued badge", () => {
	it("ignores a recheck booked for a later date", async () => {
		expect(await queue.queuedContacts([contactId])).not.toContain(contactId);
		expect(await queue.isQueued({ contactId })).toBe(false);
	});

	it("marks work that is due now", async () => {
		expect(await queue.queuedCompanies([companyId])).toContain(companyId);
		expect(await queue.isQueued({ companyId })).toBe(true);
	});

	it("asks for nothing when given no records", async () => {
		expect((await queue.queuedContacts([])).size).toBe(0);
		expect((await queue.queuedCompanies([])).size).toBe(0);
	});
});
