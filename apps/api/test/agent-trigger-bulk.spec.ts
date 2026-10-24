import { describe, expect, it } from "bun:test";
import type { Db, NewAgentTask } from "@crm/db";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";

function service() {
	const writes: NewAgentTask[][] = [];
	const insert = () => ({
		values: (data: NewAgentTask | NewAgentTask[]) => {
			const rows = Array.isArray(data) ? data : [data];
			writes.push(rows);
			const result = Promise.resolve({ rowCount: rows.length });
			return Object.assign(result, {
				returning: async () =>
					rows.map((_, index) => ({ id: `task-${index}` })),
			});
		},
	});
	type Transaction = { insert: typeof insert };
	const transaction: Transaction = { insert };
	const db = {
		insert,
		transaction: async <Result>(work: (tx: Transaction) => Promise<Result>) =>
			work(transaction),
	} as unknown as Db;

	return { trigger: new AgentTriggerService(db), writes };
}

describe("bulk agent task queues", () => {
	it("writes CRM events in one batch", async () => {
		const { trigger, writes } = service();

		await trigger.withCrmEvents(async (_tx, emit) => {
			for (let index = 0; index < 50; index += 1) {
				await emit({
					type: "company.created",
					record: { kind: "company", id: `company-${index}` },
					occurredAt: new Date("2026-10-22T00:00:00.000Z"),
					data: { name: `Company ${index}`, domain: null },
				});
			}
		});

		expect(writes).toHaveLength(1);
		expect(writes[0]).toHaveLength(50);
		expect(writes[0]?.every((row) => row.kind === "agent-event")).toBe(true);
	});

	it("writes new-record field backfills in one batch", async () => {
		const { trigger, writes } = service();
		const ids = Array.from({ length: 50 }, (_, index) => `company-${index}`);

		const result = await trigger.fieldBackfillNewRecords(
			"COMPANY",
			["summary"],
			ids,
			"New record",
		);

		expect(result).toEqual({ queued: 50 });
		expect(writes).toHaveLength(1);
		expect(writes[0]).toHaveLength(50);
		expect(writes[0]?.every((row) => row.kind === "field-backfill")).toBe(true);
	});
});
