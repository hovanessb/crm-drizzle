import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { agentTask, and, company, db, eq, isNull } from "@crm/db";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";

const suffix = process.env.TEST_RUN_ID ?? "company-requested-spec";
const name = `Requested Co ${suffix}`;
const reason = `A rep asked for a fresh look (${suffix})`;

const agent = new AgentTriggerService(db);

let companyId: string;
let bridgeSecret: string | undefined;

async function clean() {
	if (companyId)
		await db.delete(agentTask).where(eq(agentTask.companyId, companyId));
	await db.delete(company).where(eq(company.name, name));
}

beforeAll(async () => {
	bridgeSecret = process.env.AGENT_BRIDGE_SECRET;
	process.env.AGENT_BRIDGE_SECRET = "";

	await db.delete(company).where(eq(company.name, name));
	const [created] = await db
		.insert(company)
		.values({ name, domain: `requested-${suffix}.test`.toLowerCase() })
		.returning({ id: company.id });
	if (!created) throw new Error("Could not seed the company.");
	companyId = created.id;
});

afterAll(async () => {
	await clean();

	if (bridgeSecret === undefined) {
		delete process.env.AGENT_BRIDGE_SECRET;
	} else {
		process.env.AGENT_BRIDGE_SECRET = bridgeSecret;
	}
});

describe("asking for a fresh look", () => {
	it("says what it actually queued", async () => {
		expect(await agent.companyRequested(companyId, reason)).toBe(true);

		expect(await agent.companyRequested(companyId, reason)).toBe(false);

		await db
			.update(agentTask)
			.set({ finishedAt: new Date(), outcome: "done" })
			.where(
				and(
					eq(agentTask.companyId, companyId),
					eq(agentTask.reason, reason),
					isNull(agentTask.finishedAt),
				),
			);

		expect(await agent.companyRequested(companyId, reason)).toBe(true);
	});
});
