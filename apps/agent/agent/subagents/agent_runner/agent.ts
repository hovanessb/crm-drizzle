import { agentRun, db, orNull, whereEq } from "@crm/db";
import { defineAgent, defineDynamic } from "eve";
import { fallbackModel, modelEvents } from "../../lib/model";
import { attribute, purposeOf } from "../../lib/session-purpose";

export default defineAgent({
	description:
		"Execute one immutable deployed CRM agent version and persist its result and every side effect.",
	model: defineDynamic({
		events: modelEvents(async (ctx) => {
			if (purposeOf(ctx) !== "team-agent") {
				return fallbackModel();
			}
			const runId = attribute(ctx, "runId");
			if (!runId) {
				return fallbackModel();
			}

			const run = await db.query.agentRun
				.findFirst({
					where: whereEq(agentRun.id, runId),
					columns: {},
					with: {
						version: {
							columns: { modelId: true, modelContextWindowTokens: true },
						},
					},
				})
				.then(orNull);
			return run
				? {
						model: run.version.modelId,
						modelContextWindowTokens: run.version.modelContextWindowTokens,
					}
				: fallbackModel();
		}),
	}),
	limits: {
		maxInputTokensPerSession: 500_000,
		maxOutputTokensPerSession: 40_000,
		sessionTimeoutMs: 24 * 60 * 60 * 1000,
	},
});
