import {
	and,
	db,
	desc,
	firstRow,
	type JsonValue,
	mcpConnection,
	mcpToolSnapshot,
	ne,
	notInArray,
	requireRow,
	whereEq,
} from "@crm/db";
import { vendorAccess, vendorBySlug } from "@crm/mcp-integrations/catalog";
import {
	classifyTool,
	mcpToolSchema,
	toolFingerprint,
} from "@crm/mcp-integrations/tool";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { MCP } from "./mcp-config";
import { mcpConnectionToken } from "./mcp-token";

const discoveryPayload = z.object({
	connectionId: z.string().min(1),
	platformSlug: z.string().min(1),
});

const toolsReply = z.object({
	tools: z.array(mcpToolSchema).max(MCP.discovery.maxTools),
});

export async function runMcpToolDiscovery(
	payload: JsonValue | null,
): Promise<string> {
	const input = discoveryPayload.parse(payload);
	const vendor = vendorBySlug(input.platformSlug);
	if (!vendor) throw new Error("The MCP platform is unavailable.");

	const connection = await firstRow(
		db
			.select({
				id: mcpConnection.id,
				platformSlug: mcpConnection.platformSlug,
				status: mcpConnection.status,
				accessMode: mcpConnection.accessMode,
			})
			.from(mcpConnection)
			.where(whereEq(mcpConnection.id, input.connectionId))
			.limit(1),
	);
	if (
		!connection ||
		connection.platformSlug !== vendor.slug ||
		(connection.status !== "CONNECTING" && connection.status !== "CONNECTED")
	) {
		throw new Error("The MCP connection is not active.");
	}

	try {
		const token = await mcpConnectionToken(connection.id);
		const mode =
			connection.accessMode === "READ_ONLY" ? "read_only" : "read_write";
		const tools = await listTools(vendorAccess(vendor, mode).url, token.token);
		await storeTools(connection.id, vendor, tools);
		await requireRow(
			db
				.update(mcpConnection)
				.set({
					status: "CONNECTED",
					lastSuccessfulCallAt: new Date(),
					lastErrorCode: null,
				})
				.where(whereEq(mcpConnection.id, connection.id))
				.returning(),
		);
		return `Discovered ${tools.length} ${vendor.name} MCP tools.`;
	} catch (error) {
		const message = error instanceof Error ? error.message : "discovery_failed";
		await requireRow(
			db
				.update(mcpConnection)
				.set({ status: "ERROR", lastErrorCode: message.slice(0, 120) })
				.where(whereEq(mcpConnection.id, connection.id))
				.returning(),
		);
		throw error;
	}
}

async function listTools(url: string, token: string) {
	const client = new Client({ name: "crm-agent", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: {
			headers: { authorization: `Bearer ${token}` },
		},
	});

	try {
		await client.connect(transport);
		return toolsReply.parse(await client.listTools()).tools;
	} finally {
		await client.close().catch(() => undefined);
	}
}

async function storeTools(
	connectionId: string,
	vendor: NonNullable<ReturnType<typeof vendorBySlug>>,
	tools: z.infer<typeof toolsReply>["tools"],
): Promise<void> {
	const existing = await db
		.select()
		.from(mcpToolSnapshot)
		.where(whereEq(mcpToolSnapshot.connectionId, connectionId))
		.orderBy(desc(mcpToolSnapshot.createdAt));
	const latest = new Map<string, (typeof existing)[number]>();
	for (const snapshot of existing) {
		if (!latest.has(snapshot.name)) latest.set(snapshot.name, snapshot);
	}
	const seen = new Set(tools.map((tool) => tool.name));
	const now = new Date();

	await db.transaction(async (tx) => {
		for (const tool of tools) {
			const fingerprint = toolFingerprint(tool);
			const previous = latest.get(tool.name);
			if (previous?.fingerprint === fingerprint) {
				await requireRow(
					tx
						.update(mcpToolSnapshot)
						.set({
							lastSeenAt: now,
							reviewState:
								previous.reviewState === "REMOVED" ? "PENDING" : undefined,
						})
						.where(whereEq(mcpToolSnapshot.id, previous.id))
						.returning(),
				);
				continue;
			}

			await tx
				.update(mcpToolSnapshot)
				.set({ reviewState: "CHANGED" })
				.where(
					and(
						whereEq(mcpToolSnapshot.connectionId, connectionId),
						whereEq(mcpToolSnapshot.name, tool.name),
						ne(mcpToolSnapshot.reviewState, "REMOVED"),
					),
				);
			await requireRow(
				tx
					.insert(mcpToolSnapshot)
					.values({
						connectionId,
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
						annotations: tool.annotations,
						fingerprint,
						callKind: classifyTool(vendor, tool),
						reviewState: "PENDING",
						lastSeenAt: now,
					})
					.onConflictDoUpdate({
						target: [
							mcpToolSnapshot.connectionId,
							mcpToolSnapshot.name,
							mcpToolSnapshot.fingerprint,
						],
						set: {
							description: tool.description,
							inputSchema: tool.inputSchema,
							annotations: tool.annotations,
							callKind: classifyTool(vendor, tool),
							reviewState: "PENDING",
							lastSeenAt: now,
						},
					})
					.returning(),
			);
		}

		await tx
			.update(mcpToolSnapshot)
			.set({ reviewState: "REMOVED" })
			.where(
				and(
					whereEq(mcpToolSnapshot.connectionId, connectionId),
					notInArray(mcpToolSnapshot.name, [...seen]),
					ne(mcpToolSnapshot.reviewState, "REMOVED"),
				),
			);
	});
}
