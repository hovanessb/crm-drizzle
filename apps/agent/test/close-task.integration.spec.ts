import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	agentTask,
	contact as contactTable,
	db,
	EnrichmentStatus,
	firstRow,
	inArray,
	requireRow,
	whereEq,
} from "@crm/db";
import { closeTask, taskToken } from "../agent/channels/crm";

const kind = "identify";
const email = `close-task-${crypto.randomUUID()}@example.test`;

const taskIds: string[] = [];

async function clear() {
	if (taskIds.length > 0) {
		await db.delete(agentTask).where(inArray(agentTask.id, taskIds.splice(0)));
	}
	await db.delete(contactTable).where(whereEq(contactTable.email, email));
}

beforeEach(clear);
afterEach(clear);

async function running() {
	const contact = await requireRow(
		db
			.insert(contactTable)
			.values({
				firstName: "Close",
				email,
				enrichmentStatus: EnrichmentStatus.RUNNING,
			})
			.returning({ id: contactTable.id }),
	);

	const task = await requireRow(
		db
			.insert(agentTask)
			.values({
				kind,
				reason: "test",
				dueAt: new Date(Date.now() - 1000),
				budget: 4,
				contactId: contact.id,
				startedAt: new Date(),
				attempts: 1,
			})
			.returning({ id: agentTask.id }),
	);

	taskIds.push(task.id);

	return { contactId: contact.id, taskId: task.id };
}

describe("closeTask", () => {
	it("closes the row and marks the record complete", async () => {
		const { contactId, taskId } = await running();

		expect(await closeTask(taskToken(taskId), "ran")).toBe(true);

		const task = await firstRow(
			db.select().from(agentTask).where(whereEq(agentTask.id, taskId)).limit(1),
		);
		expect(task?.finishedAt).not.toBeNull();
		expect(task?.outcome).toBe("ran");

		const contact = await firstRow(
			db
				.select()
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.enrichmentStatus).toBe(EnrichmentStatus.COMPLETE);
		expect(contact?.enrichedAt).not.toBeNull();
	});

	it("marks the record skipped when the turn is stopped", async () => {
		const { contactId, taskId } = await running();

		expect(
			await closeTask(taskToken(taskId), "stopped", EnrichmentStatus.SKIPPED),
		).toBe(true);

		const contact = await firstRow(
			db
				.select()
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.enrichmentStatus).toBe(EnrichmentStatus.SKIPPED);
	});

	it("claims a task token it has already closed", async () => {
		const { taskId } = await running();

		await closeTask(taskToken(taskId), "ran");
		expect(await closeTask(taskToken(taskId), "ran again")).toBe(true);

		const task = await firstRow(
			db.select().from(agentTask).where(whereEq(agentTask.id, taskId)).limit(1),
		);
		expect(task?.outcome).toBe("ran");
	});

	it("leaves a token that names no task alone", async () => {
		expect(await closeTask("crm:adhoc:1234", "ran")).toBe(false);
		expect(await closeTask(undefined, "ran")).toBe(false);
	});
});
