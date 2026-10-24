import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	agentTask,
	company,
	contact as contactTable,
	db,
	EnrichmentStatus,
	eq,
	firstRow,
	requireRow,
	startsWith,
	whereEq,
} from "@crm/db";
import { MAX_ATTEMPTS, RETIRED_OUTCOME } from "@crm/db/agent-tasks";
import { reconcileStaleTasks } from "../agent/lib/stale-tasks";

const kind = "recheck";

const REASON = "stale-spec";

const MINUTE_MS = 60_000;

async function clear() {
	await db.delete(agentTask).where(eq(agentTask.reason, REASON));
	await db.delete(contactTable).where(startsWith(contactTable.email, "stale-"));
	await db.delete(company).where(startsWith(company.name, "Stale Co "));
}

beforeEach(clear);
afterEach(clear);

async function someone(status: EnrichmentStatus, enrichedAt?: Date) {
	return requireRow(
		db
			.insert(contactTable)
			.values({
				firstName: "Stale",
				email: `stale-${crypto.randomUUID()}@example.test`,
				enrichmentStatus: status,
				enrichedAt: enrichedAt ?? null,
			})
			.returning({ id: contactTable.id }),
	);
}

async function anAccount(status: EnrichmentStatus, enrichedAt?: Date) {
	return requireRow(
		db
			.insert(company)
			.values({
				name: `Stale Co ${crypto.randomUUID()}`,
				enrichmentStatus: status,
				enrichedAt: enrichedAt ?? null,
			})
			.returning({ id: company.id }),
	);
}

async function queue(overrides: {
	kind?: string;
	contactId?: string;
	companyId?: string;
	attempts?: number;
	dueAt?: Date;
	startedAt?: Date | null;
	leasedUntil?: Date | null;
}) {
	return requireRow(
		db
			.insert(agentTask)
			.values({
				kind: overrides.kind ?? (overrides.companyId ? "brand" : kind),
				reason: REASON,
				dueAt: overrides.dueAt ?? new Date(Date.now() - MINUTE_MS),
				priority: 0,
				budget: 4,
				contactId: overrides.contactId ?? null,
				companyId: overrides.companyId ?? null,
				attempts: overrides.attempts ?? 0,
				startedAt: overrides.startedAt ?? null,
				leasedUntil: overrides.leasedUntil ?? null,
			})
			.returning({ id: agentTask.id }),
	);
}

async function row(id: string) {
	return firstRow(
		db
			.select({
				finishedAt: agentTask.finishedAt,
				outcome: agentTask.outcome,
				leasedUntil: agentTask.leasedUntil,
			})
			.from(agentTask)
			.where(whereEq(agentTask.id, id))
			.limit(1),
	);
}

describe("a task whose lease ran out", () => {
	it("gives up once the attempts are gone, and says so on the record", async () => {
		const contact = await someone(EnrichmentStatus.RUNNING);
		const task = await queue({
			contactId: contact.id,
			attempts: MAX_ATTEMPTS,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		await reconcileStaleTasks();

		const closed = await row(task.id);
		expect(closed?.finishedAt).not.toBeNull();
		expect(closed?.outcome).toBe(RETIRED_OUTCOME);

		const settled = await firstRow(
			db
				.select({ enrichmentStatus: contactTable.enrichmentStatus })
				.from(contactTable)
				.where(whereEq(contactTable.id, contact.id))
				.limit(1),
		);
		expect(settled?.enrichmentStatus).toBe(EnrichmentStatus.FAILED);
	});

	it("waits again when it still has attempts left", async () => {
		const contact = await someone(EnrichmentStatus.RUNNING);
		const task = await queue({
			contactId: contact.id,
			attempts: 1,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		const sweep = await reconcileStaleTasks();
		expect(sweep.released).toBeGreaterThanOrEqual(1);

		const waiting = await row(task.id);
		expect(waiting?.finishedAt).toBeNull();
		expect(waiting?.leasedUntil).toBeNull();
	});
});

describe("a task that is still being worked on", () => {
	it("leaves a live lease alone", async () => {
		const contact = await someone(EnrichmentStatus.RUNNING);
		const task = await queue({
			contactId: contact.id,
			attempts: MAX_ATTEMPTS,
			startedAt: new Date(Date.now() - MINUTE_MS),
			leasedUntil: new Date(Date.now() + 10 * MINUTE_MS),
		});

		await reconcileStaleTasks();

		const held = await row(task.id);
		expect(held?.finishedAt).toBeNull();
		expect(held?.leasedUntil).not.toBeNull();
	});

	it("leaves a live lease alone even once the record reads complete", async () => {
		const account = await anAccount(EnrichmentStatus.COMPLETE, new Date());
		const task = await queue({
			companyId: account.id,
			attempts: 1,
			startedAt: new Date(Date.now() - MINUTE_MS),
			leasedUntil: new Date(Date.now() + 10 * MINUTE_MS),
		});

		await reconcileStaleTasks();
		expect((await row(task.id))?.finishedAt).toBeNull();
	});
});

describe("a task whose record is already done", () => {
	it("closes the row the work never closed", async () => {
		const startedAt = new Date(Date.now() - 30 * MINUTE_MS);
		const account = await anAccount(
			EnrichmentStatus.COMPLETE,
			new Date(Date.now() - 29 * MINUTE_MS),
		);
		const task = await queue({
			companyId: account.id,
			attempts: 1,
			startedAt,
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		const sweep = await reconcileStaleTasks();
		expect(sweep.closed).toBeGreaterThanOrEqual(1);

		const closed = await row(task.id);
		expect(closed?.finishedAt).not.toBeNull();
		expect(closed?.outcome).toContain("already up to date");
	});

	it("keeps research work on a company the brand task just finished", async () => {
		const account = await anAccount(
			EnrichmentStatus.COMPLETE,
			new Date(Date.now() - 29 * MINUTE_MS),
		);
		const task = await queue({
			kind: "company-profile",
			companyId: account.id,
			attempts: 1,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		const sweep = await reconcileStaleTasks();
		expect(sweep.released).toBeGreaterThanOrEqual(1);

		const kept = await row(task.id);
		expect(kept?.finishedAt).toBeNull();
		expect(kept?.leasedUntil).toBeNull();
	});

	it("keeps meeting prep for a contact another task just enriched", async () => {
		const contact = await someone(
			EnrichmentStatus.COMPLETE,
			new Date(Date.now() - 29 * MINUTE_MS),
		);
		const task = await queue({
			kind: "meeting-prep",
			contactId: contact.id,
			attempts: 1,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		const sweep = await reconcileStaleTasks();
		expect(sweep.released).toBeGreaterThanOrEqual(1);

		const kept = await row(task.id);
		expect(kept?.finishedAt).toBeNull();
		expect(kept?.leasedUntil).toBeNull();
	});

	it("keeps event work that names a record the agent just enriched", async () => {
		const account = await anAccount(
			EnrichmentStatus.COMPLETE,
			new Date(Date.now() - 29 * MINUTE_MS),
		);
		const task = await queue({
			kind: "agent-event",
			companyId: account.id,
			attempts: 1,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		await reconcileStaleTasks();

		expect((await row(task.id))?.finishedAt).toBeNull();
	});

	it("never closes a row another sweep is holding", async () => {
		const account = await anAccount(
			EnrichmentStatus.COMPLETE,
			new Date(Date.now() - 29 * MINUTE_MS),
		);
		const task = await queue({
			companyId: account.id,
			attempts: 1,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		const select = db.select;
		let renewed = false;
		db.select = ((fields: Parameters<typeof select>[0]) => {
			const builder = select.call(db, fields);
			const from = builder.from.bind(builder);
			builder.from = ((table: Parameters<typeof from>[0]) => {
				const query = from(table);
				if (table !== agentTask || renewed) return query;
				renewed = true;
				const execute = query.execute.bind(query);
				query.execute = (async (...args: Parameters<typeof execute>) => {
					const rows = await execute(...args);
					await db
						.update(agentTask)
						.set({ leasedUntil: new Date(Date.now() + 10 * MINUTE_MS) })
						.where(eq(agentTask.id, task.id));
					return rows;
				}) as typeof query.execute;
				return query;
			}) as typeof builder.from;
			return builder;
		}) as typeof db.select;

		try {
			await reconcileStaleTasks();
		} finally {
			db.select = select;
		}

		expect((await row(task.id))?.finishedAt).toBeNull();
	});

	it("keeps a record that finished before this work started", async () => {
		const account = await anAccount(
			EnrichmentStatus.COMPLETE,
			new Date(Date.now() - 60 * MINUTE_MS),
		);
		const task = await queue({
			companyId: account.id,
			attempts: 1,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		await reconcileStaleTasks();
		expect((await row(task.id))?.finishedAt).toBeNull();
	});

	it("keeps work that is booked for a later day", async () => {
		const contact = await someone(EnrichmentStatus.COMPLETE, new Date());
		const task = await queue({
			contactId: contact.id,
			attempts: 0,
			dueAt: new Date(Date.now() + 90 * 24 * 60 * MINUTE_MS),
		});

		await reconcileStaleTasks();
		expect((await row(task.id))?.finishedAt).toBeNull();
	});

	it("keeps work nothing has picked up yet", async () => {
		const contact = await someone(EnrichmentStatus.COMPLETE, new Date());
		const task = await queue({ contactId: contact.id, attempts: 0 });

		await reconcileStaleTasks();
		expect((await row(task.id))?.finishedAt).toBeNull();
	});
});

describe("running it twice", () => {
	it("changes nothing the second time", async () => {
		const startedAt = new Date(Date.now() - 30 * MINUTE_MS);
		const account = await anAccount(
			EnrichmentStatus.COMPLETE,
			new Date(Date.now() - 29 * MINUTE_MS),
		);

		await queue({
			companyId: account.id,
			attempts: 1,
			startedAt,
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});
		await queue({
			contactId: (await someone(EnrichmentStatus.RUNNING)).id,
			attempts: 1,
			startedAt,
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});
		await queue({
			contactId: (await someone(EnrichmentStatus.RUNNING)).id,
			attempts: MAX_ATTEMPTS,
			startedAt,
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		const first = await reconcileStaleTasks();
		expect(first.closed).toBeGreaterThanOrEqual(1);
		expect(first.released).toBeGreaterThanOrEqual(1);
		expect(first.retired).toBeGreaterThanOrEqual(1);

		const second = await reconcileStaleTasks();
		expect(second.closed).toBe(0);
		expect(second.released).toBe(0);
		expect(second.retired).toBe(0);
	});

	it("reports a database failure instead of throwing", async () => {
		const count = db.$count;
		db.$count = (() => {
			throw new Error("the database is unreachable");
		}) as typeof db.$count;

		try {
			const sweep = await reconcileStaleTasks();
			expect(sweep.error).toBe("the database is unreachable");
			expect(sweep.scanned).toBe(0);
		} finally {
			db.$count = count;
		}

		expect((await reconcileStaleTasks()).error).toBeNull();
	});

	it("keeps the counters a failed sweep already reached", async () => {
		await queue({
			contactId: (await someone(EnrichmentStatus.RUNNING)).id,
			attempts: 1,
			startedAt: new Date(Date.now() - 30 * MINUTE_MS),
			leasedUntil: new Date(Date.now() - MINUTE_MS),
		});

		const update = db.update;
		db.update = (() => {
			throw new Error("the write failed");
		}) as typeof db.update;

		let sweep: Awaited<ReturnType<typeof reconcileStaleTasks>>;
		try {
			sweep = await reconcileStaleTasks();
		} finally {
			db.update = update;
		}

		expect(sweep.error).toBe("the write failed");
		expect(sweep.scanned).toBeGreaterThanOrEqual(1);
	});
});
