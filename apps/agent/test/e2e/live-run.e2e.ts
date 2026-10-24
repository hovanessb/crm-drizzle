import {
	agentAction,
	agentDefinition,
	agentRun,
	agentRunEvent,
	agentVersion,
	and,
	appSetting,
	db,
	eq,
	firstRow,
	requireRow,
	slackChannel,
	user,
	whereEq,
} from "@crm/db";
import { reasonOf, removeAgent } from "./e2e-agents";
import { E2E } from "./e2e-config";

const AGENT_URL = process.env.AGENT_URL ?? E2E.liveRun.agentUrl;
const SECRET = process.env.AGENT_BRIDGE_SECRET?.trim();

if (process.env.E2E_LIVE_MODEL !== "1") {
	console.log(
		"SKIP  live model run — set E2E_LIVE_MODEL=1 to spend credits on this.",
	);
	process.exit(0);
}

async function seedAgent(
	channelId: string,
	channelName: string,
	modelId: string,
) {
	const owner = await requireRow(
		db.select({ id: user.id }).from(user).limit(1),
	);
	const agent = await requireRow(
		db
			.insert(agentDefinition)
			.values({
				name: `${E2E.liveRun.agentPrefix} ${Date.now()}`,
				description: "Seeded by the live run E2E. Safe to delete.",
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
				instructions: `Post exactly one short Slack message to #${channelName} that says "E2E live run — ignore this message." Do nothing else.`,
				modelId,
				sandboxPolicy: {},
				createdById: owner.id,
				manifest: {
					description: "live run",
					triggers: [
						{
							type: "MANUAL",
							name: "Run now",
							summary: "Started by a person",
							config: {},
						},
					],
					dataScope: { mode: "WORKSPACE", summary: "Workspace", resources: [] },
					actions: [
						{
							type: "slack.message.post",
							provider: "slack",
							summary: `Post one message to #${channelName}`,
							destination: {
								kind: "channel",
								resolution: "chosen",
								id: channelId,
								label: `#${channelName}`,
							},
						},
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
	return { agentId: agent.id, versionId: version.id, ownerId: owner.id };
}

async function main() {
	if (!SECRET) {
		console.error("FAIL  AGENT_BRIDGE_SECRET is not set. Cannot dispatch.");
		process.exit(1);
	}

	const channel = await firstRow(
		db
			.select({ id: slackChannel.id, name: slackChannel.name })
			.from(slackChannel)
			.where(
				and(eq(slackChannel.available, true), eq(slackChannel.name, "test")),
			)
			.limit(1),
	);
	if (!channel) {
		console.error("FAIL  No available #test channel. Connect Slack first.");
		process.exit(1);
	}

	const settings = await firstRow(
		db
			.select({ agentModelId: appSetting.agentModelId })
			.from(appSetting)
			.where(eq(appSetting.id, "app"))
			.limit(1),
	);
	if (!settings?.agentModelId) {
		console.error(
			"FAIL  No model is configured. Pick one on the settings page first.",
		);
		process.exit(1);
	}

	const { agentId, versionId, ownerId } = await seedAgent(
		channel.id,
		channel.name,
		settings.agentModelId,
	);
	let ok = false;

	try {
		const run = await requireRow(
			db
				.insert(agentRun)
				.values({
					agentId,
					versionId,
					initiatedById: ownerId,
					triggerType: "MANUAL",
					idempotencyKey: crypto.randomUUID(),
					correlationId: crypto.randomUUID(),
				})
				.returning({ id: agentRun.id }),
		);
		await db
			.insert(agentRunEvent)
			.values({ runId: run.id, sequence: 0, type: "run.queued", data: {} });
		console.log(`Queued run ${run.id}. Dispatching…`);

		const dispatch = await fetch(`${AGENT_URL}/internal/crm/agent-dispatch`, {
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
		});
		if (dispatch.status !== 202) {
			console.error(`FAIL  Dispatch returned ${dispatch.status}.`);
		} else {
			const deadline = Date.now() + E2E.liveRun.giveUpMs;
			let final: { status: string; errorCode: string | null } | null = null;

			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, E2E.liveRun.pollMs));
				const current = await requireRow(
					db
						.select({
							status: agentRun.status,
							errorCode: agentRun.errorCode,
							errorMessage: agentRun.errorMessage,
						})
						.from(agentRun)
						.where(whereEq(agentRun.id, run.id))
						.limit(1),
				);
				if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(current.status)) {
					final = current;
					break;
				}
				await fetch(`${AGENT_URL}/internal/crm/agent-dispatch`, {
					method: "POST",
					headers: { authorization: `Bearer ${SECRET}` },
				}).catch(() => {});
				console.log(`  still ${current.status}…`);
			}

			const actions = await db
				.select({
					type: agentAction.type,
					status: agentAction.status,
					externalId: agentAction.externalId,
					errorMessage: agentAction.errorMessage,
				})
				.from(agentAction)
				.where(whereEq(agentAction.runId, run.id));
			const events = await db.$count(
				agentRunEvent,
				whereEq(agentRunEvent.runId, run.id),
			);

			console.log(`\n  status       ${final?.status ?? "never settled"}`);
			console.log(`  events       ${events}`);
			for (const action of actions) {
				console.log(
					`  action       ${action.type} ${action.status} ${action.externalId ?? action.errorMessage ?? ""}`,
				);
			}

			const posted = actions.some(
				(action) =>
					action.type === "slack.message.post" &&
					action.status === "SUCCEEDED" &&
					Boolean(action.externalId),
			);
			ok = final?.status === "SUCCEEDED" && posted;
		}
	} finally {
		try {
			await removeAgent(agentId);
		} catch (error) {
			ok = false;
			console.error(`  cleanup failed — ${reasonOf(error)}`);
		}
	}

	console.log(ok ? "\nPASS  live model run" : "\nFAIL  live model run");
	process.exit(ok ? 0 : 1);
}

await main();
