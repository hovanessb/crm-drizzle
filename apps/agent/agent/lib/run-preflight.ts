import {
	agentVersion,
	and,
	db,
	eq,
	firstRow,
	mcpConnection,
	mcpToolSnapshot,
	or,
	orNull,
	whereEq,
} from "@crm/db";
import { WORKSPACE_ID } from "@crm/db/workspace";
import {
	type AgentManifest,
	InvalidAgentManifest,
	parseAgentManifest,
} from "@crm/validation/agent-manifest";
import {
	type AgentActionDependencyId,
	actionDependency,
} from "./agent-actions";
import { slackConnected } from "./slack-connection";

export const DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE";

const CHECKS = {
	slack: slackConnected,
} satisfies Record<AgentActionDependencyId, () => Promise<boolean>>;

export async function missingRunDependencies(
	manifest: AgentManifest,
): Promise<string[]> {
	const required = new Map<AgentActionDependencyId, string>();

	for (const action of manifest.actions) {
		const dependency = actionDependency(action.type);
		if (dependency) required.set(dependency.id, dependency.fix);
	}

	const missing: string[] = [];
	for (const [id, fix] of required) {
		if (!(await CHECKS[id]())) missing.push(fix);
	}
	for (const grant of manifest.mcp) {
		const connection = await db.query.mcpConnection
			.findFirst({
				where: and(
					eq(mcpConnection.organizationId, WORKSPACE_ID),
					eq(mcpConnection.platformSlug, grant.platformSlug),
				),
				columns: { status: true, accessMode: true },
				with: {
					toolSnapshots: {
						where: or(
							...grant.tools.map((tool) =>
								and(
									eq(mcpToolSnapshot.name, tool.name),
									eq(mcpToolSnapshot.fingerprint, tool.fingerprint),
									eq(mcpToolSnapshot.reviewState, "REVIEWED"),
								),
							),
						),
						columns: { name: true, fingerprint: true },
					},
				},
			})
			.then(orNull);
		const current = new Set(
			connection?.toolSnapshots.map(
				(tool) => `${tool.name}:${tool.fingerprint}`,
			) ?? [],
		);
		const unavailable =
			connection?.status !== "CONNECTED" ||
			grant.tools.some(
				(tool) =>
					!current.has(`${tool.name}:${tool.fingerprint}`) ||
					(connection.accessMode === "READ_ONLY" && tool.callKind !== "read"),
			);
		if (unavailable) {
			missing.push(
				`Reconnect ${grant.platformSlug} and review its tools in Settings → Connections.`,
			);
		}
	}

	return missing;
}

export async function runDependencyFailure(
	versionId: string,
): Promise<string | null> {
	const version = await firstRow(
		db
			.select({ manifest: agentVersion.manifest })
			.from(agentVersion)
			.where(whereEq(agentVersion.id, versionId))
			.limit(1),
	);
	if (!version) return null;

	let manifest: AgentManifest;
	try {
		manifest = parseAgentManifest(version.manifest);
	} catch (error) {
		return error instanceof InvalidAgentManifest ? error.message : null;
	}

	const missing = await missingRunDependencies(manifest);
	if (missing.length === 0) return null;

	return `This agent cannot run yet. ${missing.join(" ")}`;
}
