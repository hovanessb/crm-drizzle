import { describe, expect, it } from "bun:test";
import type { WorkspaceRole } from "@crm/auth/organization";
import { SLACK_INVENTORY } from "@crm/db/slack-inventory";
import type { AgentAccessService } from "../src/agent/agent-access.service";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import type { SlackChannelsService } from "../src/slack/slack-channels.service";
import { SlackConnectionService } from "../src/slack/slack-connection.service";
import { fakeDb, type Row, rendered } from "./fake-db";

const userId = "crm-1";

function serviceFor(input: {
	accountUpdatedAt?: Date;
	matches?: Array<{ slackUserId: string | null; updatedAt: Date }>;
	members?: Array<{
		user: {
			id: string;
			name: string;
			email: string;
			slackMemberMatch: {
				slackUserId: string | null;
				slackHandle: string | null;
				slackEmail: string | null;
			} | null;
		};
	}>;
	memberCount?: number;
	agents?: Row[];
	syncingTask?: {
		createdAt: Date;
		startedAt: Date | null;
		leasedUntil: Date | null;
	};
	lastFill?: { finishedAt: Date | null };
	channels?: Array<{
		id: string;
		name: string;
		memberCount: number;
		isPrivate: boolean;
		isMember: boolean;
		classifiedAt: Date | null;
		inviteRequestedAt: Date | null;
	}>;
	grant?: boolean;
	role?: WorkspaceRole;
}) {
	const requested: Array<{ reason: string; required: boolean | undefined }> =
		[];
	const deleted: string[] = [];
	const { db } = fakeDb({
		select: (table, call) => {
			if (table === "account")
				return input.accountUpdatedAt
					? [
							{
								id: "account-1",
								accountId: "slack-user",
								updatedAt: input.accountUpdatedAt,
								scope: null,
							},
						]
					: [];
			if (table === "agentDefinition") return input.agents ?? [];
			if (table === "slackMemberMatch") return input.matches ?? [];
			if (table === "slackWorkspaceGrant")
				return input.grant ? [{ id: "grant-1", teamName: null }] : [];
			if (table === "member")
				return (input.members ?? []).map(({ user }) => ({
					user: { id: user.id, name: user.name, email: user.email },
					match: user.slackMemberMatch
						? { ...user.slackMemberMatch, id: `match-${user.id}` }
						: null,
				}));
			if (table === "agentTask") {
				const open = rendered(call.where)?.sql.includes(
					'"agentTask"."finishedAt" is null',
				);
				const row = open ? input.syncingTask : input.lastFill;
				return row ? [row] : [];
			}
			if (table === "slackChannel") return input.channels ?? [];
			return [];
		},
		count: () => input.memberCount ?? 0,
		delete: (call) => {
			deleted.push(call.table);
			return call.table === "account" && input.accountUpdatedAt
				? [{ id: "account-1" }]
				: [];
		},
	});
	const agent = {
		slackPeopleRequested: async (reason: string, required?: boolean) => {
			requested.push({ reason, required });
		},
	} as AgentTriggerService;
	const channels = {} as SlackChannelsService;
	const access = {
		assertMember: async () => input.role ?? "member",
	} as unknown as AgentAccessService;

	return {
		service: new SlackConnectionService(db, agent, channels, access),
		requested,
		deleted,
	};
}

describe("Slack connection", () => {
	it("requests one inventory refresh when the connected account is newer", async () => {
		const connectedAt = new Date("2026-08-10T10:00:00.000Z");
		const { service, requested } = serviceFor({
			accountUpdatedAt: connectedAt,
			memberCount: 2,
			matches: [
				{
					slackUserId: "U1",
					updatedAt: new Date("2026-08-10T09:00:00.000Z"),
				},
			],
		});

		const status = await service.status(userId);

		expect(status.connected).toBe(true);
		expect(status.people).toEqual({ matched: 1, reviewed: 1 });
		expect(requested).toEqual([
			{
				reason: "Match workspace members to Slack accounts by exact email",
				required: undefined,
			},
		]);
	});

	it("does not refresh a complete inventory that was read after connecting", async () => {
		const connectedAt = new Date("2026-08-10T10:00:00.000Z");
		const reviewedAt = new Date("2026-08-10T10:00:01.000Z");
		const { service, requested } = serviceFor({
			accountUpdatedAt: connectedAt,
			memberCount: 2,
			matches: [
				{ slackUserId: "U1", updatedAt: reviewedAt },
				{ slackUserId: null, updatedAt: reviewedAt },
			],
		});

		const status = await service.status(userId);

		expect(status.people).toEqual({ matched: 1, reviewed: 2 });
		expect(requested).toEqual([]);
	});

	it("returns only real CRM members and their stored exact-email matches", async () => {
		const { service } = serviceFor({
			members: [
				{
					user: {
						id: "crm-1",
						name: "Grim",
						email: "grim@example.test",
						slackMemberMatch: {
							slackUserId: "U1",
							slackHandle: "@grim",
							slackEmail: "grim@example.test",
						},
					},
				},
			],
			syncingTask: {
				createdAt: new Date(),
				startedAt: null,
				leasedUntil: null,
			},
		});

		expect(await service.matches(userId)).toEqual({
			rows: [
				{
					crmUserId: "crm-1",
					name: "Grim",
					email: "grim@example.test",
					match: {
						slackUserId: "U1",
						slackHandle: "@grim",
						slackEmail: "grim@example.test",
					},
				},
			],
			sync: "syncing",
		});
	});

	it("reports a stalled sync when nothing picks the task up", async () => {
		const { service } = serviceFor({
			syncingTask: {
				createdAt: new Date(Date.now() - 10 * 60_000),
				startedAt: null,
				leasedUntil: null,
			},
		});

		expect((await service.matches(userId)).sync).toBe("stalled");
	});

	it("reports a running sync while the agent holds the lease", async () => {
		const { service } = serviceFor({
			syncingTask: {
				createdAt: new Date(Date.now() - 10 * 60_000),
				startedAt: null,
				leasedUntil: new Date(Date.now() + 60_000),
			},
		});

		expect((await service.matches(userId)).sync).toBe("syncing");
	});

	it("reports an idle sync when no task waits", async () => {
		const { service } = serviceFor({});

		expect((await service.matches(userId)).sync).toBe("idle");
	});

	it("refuses to disconnect the workspace for a member", async () => {
		const { service, deleted } = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			role: "member",
		});

		await expect(service.disconnect(userId)).rejects.toThrow(
			"Only an owner or an admin can disconnect Slack.",
		);
		expect(deleted).toEqual([]);
	});

	it("tells a member that they cannot disconnect", async () => {
		const { service } = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			role: "member",
		});

		expect((await service.status(userId)).canManage).toBe(false);
	});

	it("disconnects the workspace for an admin", async () => {
		const { service, deleted } = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			role: "admin",
		});

		expect(await service.disconnect(userId)).toEqual({ disconnected: true });
		expect(deleted).toEqual(["account", "slackChannel", "slackWorkspaceGrant"]);
	});
});

const channel = {
	id: "C1",
	name: "deals",
	memberCount: 2,
	isPrivate: false,
	isMember: true,
	classifiedAt: new Date("2026-08-10T10:00:00.000Z"),
	inviteRequestedAt: null,
};

describe("Slack channel inventory recovery", () => {
	it("queues a durable fill when a connected workspace has no channels", async () => {
		const { service, requested } = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			channels: [],
		});

		const result = await service.channels({}, userId);

		expect(result.rows).toEqual([]);
		expect(result.sync).toBe("syncing");
		expect(requested).toEqual([
			{
				reason: "Fill the Slack channel inventory for the connections page",
				required: undefined,
			},
		]);
	});

	it("does not refill a populated inventory", async () => {
		const { service, requested } = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			channels: [channel],
		});

		expect((await service.channels({}, userId)).rows).toHaveLength(1);
		expect(requested).toEqual([]);
	});

	it("does not treat an empty search result as a missing inventory", async () => {
		const { service, requested } = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			channels: [],
		});

		expect((await service.channels({ query: "missing" }, userId)).sync).toBe(
			"idle",
		);
		expect(requested).toEqual([]);
	});

	it("accepts a recent empty inventory as complete", async () => {
		const { service, requested } = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			channels: [],
			lastFill: { finishedAt: new Date() },
		});

		expect((await service.channels({}, userId)).sync).toBe("idle");
		expect(requested).toEqual([]);
	});

	it("refills after a reconnect or the shared throttle window", async () => {
		const connectedAt = new Date();
		const reconnected = serviceFor({
			accountUpdatedAt: connectedAt,
			channels: [],
			lastFill: { finishedAt: new Date(connectedAt.getTime() - 1) },
		});
		const expired = serviceFor({
			accountUpdatedAt: new Date("2026-08-10T10:00:00.000Z"),
			channels: [],
			lastFill: {
				finishedAt: new Date(Date.now() - SLACK_INVENTORY.throttleMs),
			},
		});

		expect((await reconnected.service.channels({}, userId)).sync).toBe(
			"syncing",
		);
		expect((await expired.service.channels({}, userId)).sync).toBe("syncing");
		expect(reconnected.requested).toHaveLength(1);
		expect(expired.requested).toHaveLength(1);
	});
});
