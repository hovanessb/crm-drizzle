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
	inArray,
	isNull,
	requireRow,
	startsWith,
	user,
	whereEq,
} from "@crm/db";
import { PRIORITY } from "@crm/db/agent-tasks";
import { runVisibleLane, VISIBLE_BATCH } from "../../agent/lib/dispatch";
import {
	reasonOf,
	removeAgent,
	removeAgentsNamed,
	removeEventRuns,
} from "./e2e-agents";
import { E2E } from "./e2e-config";

const COUNT = Number(process.env.E2E_LOAD_COUNT ?? E2E.load.defaultCount);
const DRAIN_PASSES = Math.ceil(COUNT / VISIBLE_BATCH) + E2E.load.drainPassSlack;

async function seedAgent() {
	const owner = await requireRow(
		db.select({ id: user.id }).from(user).limit(1),
	);
	const agent = await requireRow(
		db
			.insert(agentDefinition)
			.values({
				name: `${E2E.load.agentPrefix} ${Date.now()}`,
				description: "Seeded for load testing. Safe to delete.",
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
				instructions: "Load test agent. Does nothing.",
				modelId: "test/model",
				sandboxPolicy: {},
				createdById: owner.id,
				manifest: {
					description: "load test",
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
	return { agentId: agent.id, versionId: version.id };
}

async function sweepLeftovers() {
	for (const name of await removeAgentsNamed(E2E.load.agentPrefix)) {
		console.log(`  removed leftover ${name}`);
	}

	const stale = await db
		.select({ id: companyTable.id, name: companyTable.name })
		.from(companyTable)
		.where(
			and(
				and(
					startsWith(companyTable.domain, E2E.load.domainPrefix),
					endsWith(companyTable.domain, E2E.load.domainSuffix),
				),
				startsWith(companyTable.name, E2E.load.companyPrefix),
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
	dealIds: string[],
	taskIds: string[],
) {
	await removeEventRuns(taskIds);
	if (agentId) await removeAgent(agentId);
	if (dealIds.length > 0) {
		await db.delete(agentTask).where(inArray(agentTask.dealId, dealIds));
	}
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

	const dealIds: string[] = [];
	const taskIds: string[] = [];
	let agentId: string | null = null;
	let companyId: string | null = null;
	let ok = false;

	try {
		const seededAgent = await seedAgent();
		agentId = seededAgent.agentId;
		const owner = await requireRow(
			db.select({ id: user.id }).from(user).limit(1),
		);
		const company = await requireRow(
			db
				.insert(companyTable)
				.values({
					name: `Load Co ${Date.now()}`,
					domain: `load-${Date.now()}.test`,
				})
				.returning({ id: companyTable.id }),
		);
		companyId = company.id;

		console.log(`Seeding ${COUNT} deal.created events…`);
		const seedStart = Date.now();
		const deals = await db
			.insert(dealTable)
			.values(
				Array.from({ length: COUNT }, (_, index) => ({
					name: `Load Deal ${index}`,
					companyId: company.id,
					ownerId: owner.id,
					stage: "DEMO_BOOKED" as const,
					stageChangedAt: new Date(),
				})),
			)
			.returning({ id: dealTable.id });
		dealIds.push(...deals.map((deal) => deal.id));
		await db.insert(agentTask).values(
			deals.map((deal) => ({
				dealId: deal.id,
				kind: "agent-event" as const,
				reason: "deal.created",
				payload: {
					type: "deal.created",
					record: { kind: "deal", id: deal.id },
					occurredAt: new Date().toISOString(),
					data: { companyId: company.id, stage: "DEMO_BOOKED" },
				},
				priority: PRIORITY.event,
				budget: 1,
				dueAt: new Date(),
			})),
		);
		const seeded = await db
			.select({ id: agentTask.id })
			.from(agentTask)
			.where(inArray(agentTask.dealId, dealIds));
		taskIds.push(...seeded.map((task) => task.id));
		console.log(`  seeded in ${Date.now() - seedStart}ms`);

		console.log("Draining…");
		const drainStart = Date.now();
		let handled = 0;
		for (let pass = 0; pass < DRAIN_PASSES; pass += 1) {
			const done = await runVisibleLane();
			handled += done;
			if (done === 0) break;
		}
		const drainMs = Date.now() - drainStart;

		const queued = await db.$count(
			agentRun,
			whereEq(agentRun.agentId, seededAgent.agentId),
		);
		const leftover = await db.$count(
			agentTask,
			and(eq(agentTask.kind, "agent-event"), isNull(agentTask.finishedAt)),
		);

		console.log(`\n  tasks drained     ${handled}`);
		console.log(`  runs queued       ${queued}`);
		console.log(`  unclaimed left    ${leftover}`);
		console.log(`  drain time        ${drainMs}ms`);
		console.log(
			`  throughput        ${Math.round((handled / drainMs) * 1000)}/s`,
		);

		ok = handled >= COUNT && leftover === 0 && queued >= COUNT;
	} finally {
		console.log("\nCleaning up…");
		try {
			await cleanUp(agentId, companyId, dealIds, taskIds);
		} catch (error) {
			ok = false;
			console.error(`  cleanup failed — ${reasonOf(error)}`);
		}
	}

	console.log(ok ? "\nPASS  load test" : "\nFAIL  load test");
	process.exit(ok ? 0 : 1);
}

await main();
