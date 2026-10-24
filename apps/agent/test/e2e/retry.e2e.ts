import {
	agentTask,
	and,
	company as companyTable,
	db,
	firstRow,
	gte,
	inArray,
	isNull,
	lt,
	ne,
	or,
	requireRow,
	whereEq,
} from "@crm/db";
import { MAX_ATTEMPTS, RETIRED_OUTCOME } from "@crm/db/agent-tasks";
import { retireAbandoned } from "../../agent/lib/stale-tasks";
import { claimDue } from "../../agent/lib/tasks";
import { reasonOf } from "./e2e-agents";
import { E2E } from "./e2e-config";

type HeldTask = { id: string; leasedUntil: Date | null };

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function claimMine() {
	return claimDue(
		E2E.retry.claimLimit,
		{ only: [E2E.retry.kind] },
		E2E.retry.leaseMs,
	);
}

async function expireLease(taskId: string) {
	await requireRow(
		db
			.update(agentTask)
			.set({ leasedUntil: new Date(Date.now() - E2E.retry.expiredLeaseMs) })
			.where(whereEq(agentTask.id, taskId))
			.returning(),
	);
}

async function holdBackOtherExhausted(taskId: string): Promise<HeldTask[]> {
	const now = new Date();
	const others = await db
		.select({ id: agentTask.id, leasedUntil: agentTask.leasedUntil })
		.from(agentTask)
		.where(
			and(
				ne(agentTask.id, taskId),
				isNull(agentTask.finishedAt),
				gte(agentTask.attempts, MAX_ATTEMPTS),
				or(isNull(agentTask.leasedUntil), lt(agentTask.leasedUntil, now)),
			),
		);

	if (others.length === 0) return [];

	await db
		.update(agentTask)
		.set({ leasedUntil: new Date(Date.now() + E2E.retry.holdBackMs) })
		.where(
			inArray(
				agentTask.id,
				others.map((row) => row.id),
			),
		);
	console.log(`  held back ${others.length} exhausted task(s) owned by nobody`);

	return others;
}

async function releaseHeldBack(held: readonly HeldTask[]) {
	for (const task of held) {
		await db
			.update(agentTask)
			.set({ leasedUntil: task.leasedUntil })
			.where(whereEq(agentTask.id, task.id));
	}
}

async function main() {
	const stamp = Date.now();
	const company = await requireRow(
		db
			.insert(companyTable)
			.values({
				name: `${E2E.retry.companyPrefix} ${stamp}`,
				domain: `retry-${stamp}.test`,
			})
			.returning({ id: companyTable.id }),
	);
	let held: HeldTask[] = [];

	try {
		const task = await requireRow(
			db
				.insert(agentTask)
				.values({
					companyId: company.id,
					kind: E2E.retry.kind,
					reason: E2E.retry.reason,
					priority: E2E.retry.priority,
					budget: 1,
					dueAt: new Date(),
				})
				.returning({ id: agentTask.id }),
		);

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			const claimed = await claimMine();
			const mine = claimed.find((row) => row.id === task.id);
			record(
				`attempt ${attempt} is claimable`,
				mine?.attempts === attempt,
				mine ? `attempts=${mine.attempts}` : "not claimed",
			);
			await expireLease(task.id);
		}

		const afterLimit = await claimMine();
		record(
			`no claim past ${MAX_ATTEMPTS} attempts`,
			afterLimit.length === 0,
			`${afterLimit.length} task(s) claimed`,
		);

		held = await holdBackOtherExhausted(task.id);
		await retireAbandoned();

		const retired = await firstRow(
			db
				.select({
					finishedAt: agentTask.finishedAt,
					outcome: agentTask.outcome,
				})
				.from(agentTask)
				.where(whereEq(agentTask.id, task.id))
				.limit(1),
		);
		record(
			"exhausted task is retired, not left queued",
			Boolean(retired?.finishedAt) && retired?.outcome === RETIRED_OUTCOME,
			retired?.outcome ?? "still queued",
		);

		const enrichment = await firstRow(
			db
				.select({
					enrichmentStatus: companyTable.enrichmentStatus,
					enrichmentError: companyTable.enrichmentError,
				})
				.from(companyTable)
				.where(whereEq(companyTable.id, company.id))
				.limit(1),
		);
		record(
			"the record says why it gave up",
			enrichment?.enrichmentStatus === "FAILED",
			enrichment?.enrichmentError ?? "no reason recorded",
		);
	} finally {
		try {
			await releaseHeldBack(held);
			await db
				.delete(agentTask)
				.where(whereEq(agentTask.companyId, company.id));
			await requireRow(
				db
					.delete(companyTable)
					.where(whereEq(companyTable.id, company.id))
					.returning(),
			);
		} catch (error) {
			record("cleanup leaves nothing behind", false, reasonOf(error));
		}
	}

	const failed = results.filter((row) => !row.ok).length;
	console.log(
		failed === 0
			? `\nAll ${results.length} retry checks passed.`
			: `\n${failed} of ${results.length} retry checks failed.`,
	);
	process.exit(failed === 0 ? 0 : 1);
}

await main();
