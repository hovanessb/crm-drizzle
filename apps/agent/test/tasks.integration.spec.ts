import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	agentTask,
	and,
	contact as contactTable,
	db,
	firstRow,
	inArray,
	isNull,
	requireRow,
	startsWith,
	whereEq,
} from "@crm/db";
import { MAX_ATTEMPTS } from "@crm/db/agent-tasks";
import {
	claimDue,
	completeTask,
	retireExhausted,
	scheduleTask,
} from "../agent/lib/tasks";

const kind = "test-lease";

const TEST_TASKS = { only: [kind] } as const;

async function clear() {
	await db.delete(agentTask).where(whereEq(agentTask.kind, kind));
	await db.delete(contactTable).where(startsWith(contactTable.email, "lease-"));
}

beforeEach(clear);
afterEach(clear);

async function queue(
	overrides: { priority?: number; dueAt?: Date; contactId?: string } = {},
) {
	return requireRow(
		db
			.insert(agentTask)
			.values({
				kind,
				reason: "test",
				dueAt: overrides.dueAt ?? new Date(Date.now() - 1000),
				priority: overrides.priority ?? 0,
				budget: 4,
				contactId: overrides.contactId ?? null,
			})
			.returning({ id: agentTask.id }),
	);
}

async function expire(taskId: string) {
	await requireRow(
		db
			.update(agentTask)
			.set({ leasedUntil: new Date(Date.now() - 1000) })
			.where(whereEq(agentTask.id, taskId))
			.returning(),
	);
}

async function someone() {
	return requireRow(
		db
			.insert(contactTable)
			.values({
				firstName: "Lease",
				email: `lease-${crypto.randomUUID()}@example.test`,
			})
			.returning({ id: contactTable.id }),
	);
}

describe("claimDue", () => {
	it("claims due work and leases it", async () => {
		const task = await queue();

		const claimed = await claimDue(10, TEST_TASKS);
		expect(claimed.map((t) => t.id)).toContain(task.id);

		const row = await firstRow(
			db
				.select()
				.from(agentTask)
				.where(whereEq(agentTask.id, task.id))
				.limit(1),
		);
		expect(row?.leasedUntil).not.toBeNull();
		expect(row?.startedAt).not.toBeNull();
	});

	it("does not hand the same row to two dispatchers", async () => {
		await Promise.all([queue(), queue(), queue()]);

		const [first, second] = await Promise.all([
			claimDue(3, TEST_TASKS),
			claimDue(3, TEST_TASKS),
		]);
		const ids = [...first, ...second].map((t) => t.id);

		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toHaveLength(3);
	});

	it("leaves work that is not due yet", async () => {
		await queue({ dueAt: new Date(Date.now() + 60_000) });
		const claimed = await claimDue(10, TEST_TASKS);
		expect(claimed).toHaveLength(0);
	});

	it("takes the most urgent first", async () => {
		const low = await queue({ priority: 0 });
		const high = await queue({ priority: 100 });

		const claimed = await claimDue(1, TEST_TASKS);
		expect(claimed[0]?.id).toBe(high.id);
		expect(claimed[0]?.id).not.toBe(low.id);
	});

	it("does not re-claim a leased row, and does re-claim an expired one", async () => {
		const task = await queue();
		await claimDue(10, TEST_TASKS);

		expect(await claimDue(10, TEST_TASKS)).toHaveLength(0);

		await requireRow(
			db
				.update(agentTask)
				.set({ leasedUntil: new Date(Date.now() - 1000) })
				.where(whereEq(agentTask.id, task.id))
				.returning(),
		);

		expect((await claimDue(10, TEST_TASKS)).map((t) => t.id)).toContain(
			task.id,
		);
	});

	it("stops handing out a row that has spent its attempts", async () => {
		const task = await queue();

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			expect((await claimDue(10, TEST_TASKS)).map((t) => t.id)).toContain(
				task.id,
			);
			await expire(task.id);
		}

		expect(await claimDue(10, TEST_TASKS)).toHaveLength(0);
	});

	it("counts the attempts it has handed out", async () => {
		const task = await queue();

		expect((await claimDue(10, TEST_TASKS))[0]?.attempts).toBe(1);
		await expire(task.id);
		expect((await claimDue(10, TEST_TASKS))[0]?.attempts).toBe(2);
	});

	it("stops claiming once the work is finished", async () => {
		const task = await queue();
		await claimDue(10, TEST_TASKS);
		await completeTask(task.id, "ran");

		await requireRow(
			db
				.update(agentTask)
				.set({ leasedUntil: null })
				.where(whereEq(agentTask.id, task.id))
				.returning(),
		);

		expect(await claimDue(10, TEST_TASKS)).toHaveLength(0);
	});
});

describe("retireExhausted", () => {
	it("gives up on a row that never reported back, and says who it was about", async () => {
		const contact = await someone();
		const task = await queue({ contactId: contact.id });

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			await claimDue(10, TEST_TASKS);
			await expire(task.id);
		}

		const retired = await retireExhausted();
		expect(retired.map((t) => t.id)).toContain(task.id);
		expect(retired.find((t) => t.id === task.id)?.contactId).toBe(contact.id);

		const row = await firstRow(
			db
				.select()
				.from(agentTask)
				.where(whereEq(agentTask.id, task.id))
				.limit(1),
		);
		expect(row?.finishedAt).not.toBeNull();
		expect(row?.outcome).toContain("Gave up");
	});

	it("leaves a row that is still leased on its last attempt alone", async () => {
		const task = await queue();

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			await claimDue(10, TEST_TASKS);
			if (attempt < MAX_ATTEMPTS - 1) await expire(task.id);
		}

		expect(await retireExhausted()).toHaveLength(0);
	});

	it("leaves work that still has attempts left", async () => {
		await queue();
		await claimDue(10, TEST_TASKS);

		expect(await retireExhausted()).toHaveLength(0);
	});

	it("retires no more rows than the limit allows", async () => {
		const mine: string[] = [];
		for (let row = 0; row < 3; row++) mine.push((await queue()).id);

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const claimed = await claimDue(10, TEST_TASKS);
			for (const task of claimed) await expire(task.id);
		}

		for (let pass = 0; pass < 3; pass++) {
			expect((await retireExhausted(2)).length).toBeLessThanOrEqual(2);
		}

		const open = await db.$count(
			agentTask,
			and(inArray(agentTask.id, mine), isNull(agentTask.finishedAt)),
		);
		expect(open).toBe(0);
	});
});

describe("completeTask", () => {
	it("retires a row once, and reports who it was about", async () => {
		const contact = await someone();
		const task = await queue({ contactId: contact.id });
		await claimDue(10, TEST_TASKS);

		const subject = await completeTask(task.id, "ran");
		expect(subject?.contactId).toBe(contact.id);

		expect(await completeTask(task.id, "ran again")).toBeNull();
		const row = await firstRow(
			db
				.select()
				.from(agentTask)
				.where(whereEq(agentTask.id, task.id))
				.limit(1),
		);
		expect(row?.outcome).toBe("ran");
	});
});

describe("scheduleTask", () => {
	it("books work with the agent's own reason", async () => {
		const dueAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
		const { id } = await scheduleTask({
			kind,
			reason: "a job change here would move the Acme deal",
			dueAt,
		});

		const row = await firstRow(
			db.select().from(agentTask).where(whereEq(agentTask.id, id)).limit(1),
		);
		expect(row?.reason).toContain("Acme");
	});

	it("moves the existing booking rather than queueing a second one", async () => {
		const soon = new Date(Date.now() + 1000);
		const later = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

		const first = await scheduleTask({ kind, reason: "first", dueAt: soon });
		const second = await scheduleTask({ kind, reason: "second", dueAt: later });

		expect(second.id).toBe(first.id);
		expect(await db.$count(agentTask, whereEq(agentTask.kind, kind))).toBe(1);
	});
});
