import {
	agentDefinition,
	agentRun,
	agentTask,
	agentTrigger,
	agentVersion,
	and,
	company as companyTable,
	db,
	deal as dealTable,
	endsWith,
	eq,
	firstRow,
	inArray,
	isNull,
	requireRow,
	startsWith,
	user,
	whereEq,
} from "@crm/db";
import { PRIORITY } from "@crm/db/agent-tasks";
import { runVisibleLane } from "../../agent/lib/dispatch";
import {
	reasonOf,
	removeAgent,
	removeAgentsNamed,
	removeEventRuns,
} from "./e2e-agents";
import { E2E } from "./e2e-config";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function seedAgent() {
	const owner = await requireRow(
		db.select({ id: user.id }).from(user).limit(1),
	);
	const agent = await requireRow(
		db
			.insert(agentDefinition)
			.values({
				name: `${E2E.dispatch.agentPrefix} ${Date.now()}`,
				description: "Seeded by the dispatch E2E. Safe to delete.",
				status: "LIVE",
				createdById: owner.id,
			})
			.returning({ id: agentDefinition.id }),
	);
	const version = await requireRow(
		db
			.insert(agentVersion)
			.values({
				agentId: agent.id,
				number: 1,
				status: "DEPLOYED",
				instructions: "Dispatch test agent. Does nothing.",
				modelId: "test/model",
				sandboxPolicy: {},
				createdById: owner.id,
				manifest: {
					description: "dispatch test",
					triggers: [
						{
							type: "EVENT",
							name: "Deal created",
							summary: "Fires on deal creation",
							config: { event: "deal.created" },
						},
					],
					dataScope: { mode: "WORKSPACE", summary: "Workspace", resources: [] },
					actions: [
						{ type: "run.summary", provider: "crm", summary: "Log the result" },
					],
				},
			})
			.returning({ id: agentVersion.id }),
	);
	await requireRow(
		db
			.update(agentDefinition)
			.set({ currentVersionId: version.id })
			.where(whereEq(agentDefinition.id, agent.id))
			.returning(),
	);
	await requireRow(
		db
			.insert(agentTrigger)
			.values({
				agentId: agent.id,
				versionId: version.id,
				type: "EVENT",
				name: "Deal created",
				config: { event: "deal.created" },
				enabled: true,
				createdById: owner.id,
			})
			.returning(),
	);
	return { agentId: agent.id };
}

async function seedDeal() {
	const stamp = Date.now();
	const company = await requireRow(
		db
			.insert(companyTable)
			.values({
				name: `${E2E.dispatch.companyPrefix} ${stamp}`,
				domain: `${E2E.dispatch.domainPrefix}${stamp}${E2E.dispatch.domainSuffix}`,
			})
			.returning({ id: companyTable.id }),
	);
	const owner = await requireRow(
		db.select({ id: user.id }).from(user).limit(1),
	);
	return requireRow(
		db
			.insert(dealTable)
			.values({
				name: `E2E Deal ${Date.now()}`,
				companyId: company.id,
				ownerId: owner.id,
				stage: "DEMO_BOOKED",
				stageChangedAt: new Date(),
			})
			.returning({ id: dealTable.id, companyId: dealTable.companyId }),
	);
}

async function sweepLeftovers() {
	for (const name of await removeAgentsNamed(E2E.dispatch.agentPrefix)) {
		console.log(`  removed leftover ${name}`);
	}

	const stale = await db
		.select({ id: companyTable.id, name: companyTable.name })
		.from(companyTable)
		.where(
			and(
				and(
					startsWith(companyTable.domain, E2E.dispatch.domainPrefix),
					endsWith(companyTable.domain, E2E.dispatch.domainSuffix),
				),
				startsWith(companyTable.name, E2E.dispatch.companyPrefix),
			),
		);

	for (const company of stale) {
		const deals = await db
			.select({ id: dealTable.id })
			.from(dealTable)
			.where(whereEq(dealTable.companyId, company.id));
		await db.delete(agentTask).where(
			inArray(
				agentTask.dealId,
				deals.map((deal) => deal.id),
			),
		);
		await db.delete(dealTable).where(whereEq(dealTable.companyId, company.id));
		await requireRow(
			db
				.delete(companyTable)
				.where(whereEq(companyTable.id, company.id))
				.returning(),
		);
		console.log(`  removed leftover ${company.name}`);
	}
}

async function cleanUp(
	agentId: string | null,
	companyId: string | null,
	dealId: string | null,
	taskId: string | null,
) {
	await removeEventRuns(taskId ? [taskId] : []);
	if (agentId) await removeAgent(agentId);
	if (dealId)
		await db.delete(agentTask).where(whereEq(agentTask.dealId, dealId));
	if (!companyId) return;
	await db.delete(dealTable).where(whereEq(dealTable.companyId, companyId));
	await requireRow(
		db
			.delete(companyTable)
			.where(whereEq(companyTable.id, companyId))
			.returning(),
	);
}

async function main() {
	await sweepLeftovers();

	let agentId: string | null = null;
	let companyId: string | null = null;
	let dealId: string | null = null;
	let taskId: string | null = null;

	try {
		const seededAgent = await seedAgent();
		agentId = seededAgent.agentId;
		const deal = await seedDeal();
		companyId = deal.companyId;
		dealId = deal.id;
		const task = await requireRow(
			db
				.insert(agentTask)
				.values({
					dealId: deal.id,
					kind: "agent-event",
					reason: "deal.created",
					payload: {
						type: "deal.created",
						record: { kind: "deal", id: deal.id },
						occurredAt: new Date().toISOString(),
						data: { companyId: deal.companyId, stage: "DEMO_BOOKED" },
					},
					priority: PRIORITY.event,
					budget: 1,
					dueAt: new Date(),
				})
				.returning({ id: agentTask.id }),
		);
		taskId = task.id;

		const before = await db.$count(agentRun);
		const handled = await runVisibleLane();
		const after = await db.$count(agentRun);

		record(
			"drain claims a queued event",
			handled > 0,
			`visible lane handled ${handled} task(s)`,
		);

		const settled = await firstRow(
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
			"drain settles the task",
			Boolean(settled?.finishedAt),
			settled?.outcome ?? "not settled",
		);

		const live = await db.$count(
			agentDefinition,
			eq(agentDefinition.status, "LIVE"),
		);
		record(
			"event matched against live agents",
			after > before,
			`${after - before} run(s) queued from ${live} live agent(s)`,
		);

		const stuck = await db.$count(
			agentTask,
			and(eq(agentTask.kind, "agent-event"), isNull(agentTask.finishedAt)),
		);
		record("no agent-event backlog", stuck === 0, `${stuck} unclaimed`);
	} finally {
		const failure = await cleanUp(agentId, companyId, dealId, taskId).then(
			() => null,
			(cause: unknown) => reasonOf(cause),
		);
		record(
			"cleanup leaves no seeded rows",
			failure === null,
			failure ?? "agent, run, task, deal and company removed",
		);
	}

	const failed = results.filter((row) => !row.ok).length;
	console.log(
		failed === 0
			? `\nAll ${results.length} dispatch checks passed.`
			: `\n${failed} of ${results.length} dispatch checks failed.`,
	);
	process.exit(failed === 0 ? 0 : 1);
}

await main();
