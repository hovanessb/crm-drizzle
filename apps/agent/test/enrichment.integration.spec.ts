import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	agentTask,
	company as companyTable,
	contact as contactTable,
	db,
	EnrichmentStatus,
	eq,
	firstRow,
	requireRow,
	startsWith,
	whereEq,
} from "@crm/db";
import { markRunning, settle } from "../agent/lib/enrichment";

const domain = "lifecycle.example.test";

async function clear() {
	await db.delete(agentTask).where(eq(agentTask.reason, "lifecycle"));
	await db.delete(companyTable).where(whereEq(companyTable.domain, domain));
	await db
		.delete(contactTable)
		.where(startsWith(contactTable.email, "lifecycle-"));
}

beforeEach(clear);
afterEach(clear);

async function company() {
	return requireRow(
		db
			.insert(companyTable)
			.values({ name: "Lifecycle", domain })
			.returning({ id: companyTable.id }),
	);
}

async function contact() {
	return requireRow(
		db
			.insert(contactTable)
			.values({
				firstName: "Lifecycle",
				email: `lifecycle-${crypto.randomUUID()}@example.test`,
			})
			.returning({ id: contactTable.id }),
	);
}

function subjectOf(ids: { contactId?: string; companyId?: string }) {
	return {
		id: "task",
		kind: ids.contactId ? "identify" : "brand",
		contactId: ids.contactId ?? null,
		companyId: ids.companyId ?? null,
	};
}

async function retiredTask(companyId: string) {
	const row = await requireRow(
		db
			.select({ updatedAt: companyTable.updatedAt })
			.from(companyTable)
			.where(whereEq(companyTable.id, companyId))
			.limit(1),
	);

	return requireRow(
		db
			.insert(agentTask)
			.values({
				companyId,
				kind: "company-profile",
				reason: "lifecycle",
				attempts: 3,
				dueAt: row.updatedAt,
				finishedAt: new Date(row.updatedAt.getTime() + 1),
			})
			.returning({ id: agentTask.id }),
	);
}

async function statusOfContact(id: string) {
	const row = await firstRow(
		db
			.select({
				enrichmentStatus: contactTable.enrichmentStatus,
				enrichedAt: contactTable.enrichedAt,
			})
			.from(contactTable)
			.where(whereEq(contactTable.id, id))
			.limit(1),
	);
	return row;
}

describe("the record follows the task", () => {
	it("takes a contact off PENDING, which nothing used to do", async () => {
		const person = await contact();
		const subject = subjectOf({ contactId: person.id });

		expect((await statusOfContact(person.id))?.enrichmentStatus).toBe(
			"PENDING",
		);

		await markRunning(subject);
		expect((await statusOfContact(person.id))?.enrichmentStatus).toBe(
			"RUNNING",
		);

		await settle(subject, EnrichmentStatus.COMPLETE);
		const done = await statusOfContact(person.id);
		expect(done?.enrichmentStatus).toBe("COMPLETE");
		expect(done?.enrichedAt).not.toBeNull();
	});

	it("does the same for a company", async () => {
		const org = await company();
		const subject = subjectOf({ companyId: org.id });

		await markRunning(subject);
		await settle(subject, EnrichmentStatus.COMPLETE);

		const row = await firstRow(
			db
				.select({ enrichmentStatus: companyTable.enrichmentStatus })
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("COMPLETE");
	});

	it("lets a tool's more specific answer win over the queue's", async () => {
		const org = await company();
		const subject = subjectOf({ companyId: org.id });

		await markRunning(subject);

		await requireRow(
			db
				.update(companyTable)
				.set({
					enrichmentStatus: EnrichmentStatus.SKIPPED,
					enrichmentError: "No domain to look up.",
				})
				.where(whereEq(companyTable.id, org.id))
				.returning(),
		);

		await settle(subject, EnrichmentStatus.COMPLETE);

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichmentError: companyTable.enrichmentError,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("SKIPPED");
		expect(row?.enrichmentError).toBe("No domain to look up.");
	});

	it("puts a failed record back to work on a retry", async () => {
		const person = await contact();
		const subject = subjectOf({ contactId: person.id });

		await markRunning(subject);
		await settle(subject, EnrichmentStatus.FAILED, "the vendor refused");
		expect((await statusOfContact(person.id))?.enrichmentStatus).toBe("FAILED");

		await markRunning(subject);
		const retried = await statusOfContact(person.id);
		expect(retried?.enrichmentStatus).toBe("RUNNING");

		const row = await firstRow(
			db
				.select({ enrichmentError: contactTable.enrichmentError })
				.from(contactTable)
				.where(whereEq(contactTable.id, person.id))
				.limit(1),
		);
		expect(row?.enrichmentError).toBeNull();
	});

	it("records the failure of a task that was retired before it ran", async () => {
		const org = await company();
		const task = await retiredTask(org.id);

		await settle(
			{ ...subjectOf({ companyId: org.id }), id: task.id },
			EnrichmentStatus.FAILED,
			"Research was attempted several times and never completed.",
		);

		const row = await firstRow(
			db
				.select({ enrichmentStatus: companyTable.enrichmentStatus })
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("FAILED");
	});

	it("leaves a fresh request alone when a retired task settles late", async () => {
		const org = await company();
		const task = await retiredTask(org.id);

		await requireRow(
			db
				.update(companyTable)
				.set({
					enrichmentStatus: EnrichmentStatus.PENDING,
					enrichmentError: null,
				})
				.where(whereEq(companyTable.id, org.id))
				.returning(),
		);

		await settle(
			{ ...subjectOf({ companyId: org.id }), id: task.id },
			EnrichmentStatus.FAILED,
			"Research was attempted several times and never completed.",
		);

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichmentError: companyTable.enrichmentError,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("PENDING");
		expect(row?.enrichmentError).toBeNull();
	});

	it("leaves a queued record alone when a task that never ended fails late", async () => {
		const org = await company();
		const open = await requireRow(
			db
				.insert(agentTask)
				.values({
					companyId: org.id,
					kind: "company-profile",
					reason: "lifecycle",
					dueAt: new Date(),
				})
				.returning({ id: agentTask.id }),
		);

		await requireRow(
			db
				.update(companyTable)
				.set({
					enrichmentStatus: EnrichmentStatus.PENDING,
					enrichmentError: null,
				})
				.where(whereEq(companyTable.id, org.id))
				.returning(),
		);

		await settle(
			{ ...subjectOf({ companyId: org.id }), id: open.id },
			EnrichmentStatus.FAILED,
			"The agent turn failed.",
		);

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichmentError: companyTable.enrichmentError,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("PENDING");
		expect(row?.enrichmentError).toBeNull();
	});

	it("leaves the record to a newer request when an ended task settles late", async () => {
		const org = await company();
		const task = await retiredTask(org.id);
		await requireRow(
			db
				.insert(agentTask)
				.values({
					companyId: org.id,
					kind: "recheck",
					reason: "lifecycle",
					dueAt: new Date(),
				})
				.returning({ id: agentTask.id }),
		);

		await settle(
			{ ...subjectOf({ companyId: org.id }), id: task.id },
			EnrichmentStatus.FAILED,
			"Research was attempted several times and never completed.",
		);

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichmentError: companyTable.enrichmentError,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("PENDING");
		expect(row?.enrichmentError).toBeNull();
	});

	it("survives a record deleted while the agent was still reading about it", async () => {
		const person = await contact();
		const subject = subjectOf({ contactId: person.id });

		await markRunning(subject);
		await requireRow(
			db
				.delete(contactTable)
				.where(whereEq(contactTable.id, person.id))
				.returning(),
		);

		await settle(subject, EnrichmentStatus.COMPLETE);
	});

	it("leaves a company the brand task already finished alone", async () => {
		const org = await company();
		const brand = subjectOf({ companyId: org.id });

		await markRunning(brand);
		await settle(brand, EnrichmentStatus.COMPLETE);

		const profile = {
			...brand,
			id: "company-profile",
			kind: "company-profile",
		};
		await markRunning(profile);

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichedAt: companyTable.enrichedAt,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("COMPLETE");
		expect(row?.enrichedAt).not.toBeNull();
	});

	it("still stamps the hour a recheck finished on a complete contact", async () => {
		const person = await contact();
		const identify = subjectOf({ contactId: person.id });

		await markRunning(identify);
		await settle(identify, EnrichmentStatus.COMPLETE);

		const first = await requireRow(
			db
				.select({ enrichedAt: contactTable.enrichedAt })
				.from(contactTable)
				.where(whereEq(contactTable.id, person.id))
				.limit(1),
		);

		const recheck = { ...identify, id: "recheck", kind: "recheck" };
		await settle(recheck, EnrichmentStatus.COMPLETE);

		const second = await requireRow(
			db
				.select({
					enrichmentStatus: contactTable.enrichmentStatus,
					enrichedAt: contactTable.enrichedAt,
				})
				.from(contactTable)
				.where(whereEq(contactTable.id, person.id))
				.limit(1),
		);
		expect(second.enrichmentStatus).toBe("COMPLETE");
		expect(second.enrichedAt?.getTime()).toBeGreaterThanOrEqual(
			first.enrichedAt?.getTime() ?? 0,
		);
	});

	it("lets a finished run land on the fresh look that asked for it", async () => {
		const person = await contact();

		const row = await requireRow(
			db
				.select({ updatedAt: contactTable.updatedAt })
				.from(contactTable)
				.where(whereEq(contactTable.id, person.id))
				.limit(1),
		);

		const task = await requireRow(
			db
				.insert(agentTask)
				.values({
					contactId: person.id,
					kind: "identify",
					reason: "lifecycle",
					attempts: 1,
					dueAt: row.updatedAt,
					finishedAt: new Date(row.updatedAt.getTime() + 1),
				})
				.returning({ id: agentTask.id }),
		);

		await settle(
			{ ...subjectOf({ contactId: person.id }), id: task.id },
			EnrichmentStatus.COMPLETE,
		);

		const done = await statusOfContact(person.id);
		expect(done?.enrichmentStatus).toBe("COMPLETE");
		expect(done?.enrichedAt).not.toBeNull();
	});

	it("leaves a fresh look to the newer task a late run cannot satisfy", async () => {
		const person = await contact();

		const row = await requireRow(
			db
				.select({ updatedAt: contactTable.updatedAt })
				.from(contactTable)
				.where(whereEq(contactTable.id, person.id))
				.limit(1),
		);

		const ended = await requireRow(
			db
				.insert(agentTask)
				.values({
					contactId: person.id,
					kind: "identify",
					reason: "lifecycle",
					attempts: 1,
					dueAt: row.updatedAt,
					finishedAt: new Date(row.updatedAt.getTime() + 1),
				})
				.returning({ id: agentTask.id }),
		);

		await requireRow(
			db
				.insert(agentTask)
				.values({
					contactId: person.id,
					kind: "recheck",
					reason: "lifecycle",
					dueAt: new Date(),
				})
				.returning({ id: agentTask.id }),
		);

		await settle(
			{ ...subjectOf({ contactId: person.id }), id: ended.id },
			EnrichmentStatus.COMPLETE,
		);

		expect((await statusOfContact(person.id))?.enrichmentStatus).toBe(
			"PENDING",
		);
	});

	it("never lets a company-profile session touch the company column", async () => {
		const org = await company();
		const brand = subjectOf({ companyId: org.id });

		await markRunning(brand);

		const profile = {
			...brand,
			id: "company-profile",
			kind: "company-profile",
		};
		await settle(profile, EnrichmentStatus.FAILED, "the agent turn failed");

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichmentError: companyTable.enrichmentError,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("RUNNING");
		expect(row?.enrichmentError).toBeNull();
	});

	it("never lets a portrait timeout mark a person failed", async () => {
		const person = await contact();
		const identify = subjectOf({ contactId: person.id });

		await markRunning(identify);

		const portrait = { ...identify, id: "portrait", kind: "portrait" };
		await settle(portrait, EnrichmentStatus.FAILED, "the picture timed out");

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: contactTable.enrichmentStatus,
					enrichmentError: contactTable.enrichmentError,
				})
				.from(contactTable)
				.where(whereEq(contactTable.id, person.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("RUNNING");
		expect(row?.enrichmentError).toBeNull();
	});

	it("keeps that company complete when the later session fails", async () => {
		const org = await company();
		const brand = subjectOf({ companyId: org.id });

		await markRunning(brand);
		await settle(brand, EnrichmentStatus.COMPLETE);

		const profile = {
			...brand,
			id: "company-profile",
			kind: "company-profile",
		};
		await markRunning(profile);
		await settle(profile, EnrichmentStatus.FAILED, "the agent turn failed");

		const row = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichmentError: companyTable.enrichmentError,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, org.id))
				.limit(1),
		);
		expect(row?.enrichmentStatus).toBe("COMPLETE");
		expect(row?.enrichmentError).toBeNull();
	});
});
