import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	account,
	asc,
	db,
	eq,
	firstRow,
	requireRow,
	slackChannel,
	sql,
	startsWith,
	user,
	whereEq,
} from "@crm/db";
import {
	persistSlackChannels,
	refreshSlackChannels,
} from "../agent/lib/slack-people";

const USER_ID = "slack-people-spec-user";
const ACCOUNT_ID = "slack-people-spec-account";
const PREFIX = "CSPEC";

const realFetch = globalThis.fetch;

let restore: Array<{ id: string; available: boolean }> = [];

async function connect() {
	await requireRow(
		db
			.insert(user)
			.values({
				id: USER_ID,
				name: "Slack Spec",
				email: `${USER_ID}@example.com`,
			})
			.onConflictDoUpdate({
				target: user.id,
				set: { id: sql`excluded.${sql.identifier("id")}` },
			})
			.returning(),
	);
	await requireRow(
		db
			.insert(account)
			.values({
				id: ACCOUNT_ID,
				accountId: "T-SPEC",
				providerId: "slack",
				userId: USER_ID,
				accessToken: "xoxb-spec",
			})
			.onConflictDoUpdate({
				target: account.id,
				set: { ...{ accessToken: "xoxb-spec" }, updatedAt: new Date() },
			})
			.returning(),
	);
}

async function disconnect() {
	await db.delete(account).where(eq(account.providerId, "slack"));
	await db.delete(slackChannel).where(startsWith(slackChannel.id, PREFIX));
}

beforeEach(async () => {
	restore = await db
		.select({ id: slackChannel.id, available: slackChannel.available })
		.from(slackChannel);
	await db.delete(slackChannel).where(startsWith(slackChannel.id, PREFIX));
	await connect();
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	await db.delete(slackChannel).where(startsWith(slackChannel.id, PREFIX));
	await db.delete(account).where(eq(account.id, ACCOUNT_ID));
	await db.delete(user).where(eq(user.id, USER_ID));
	for (const row of restore) {
		await db
			.update(slackChannel)
			.set({ available: row.available })
			.where(whereEq(slackChannel.id, row.id));
	}
});

type SlackChannelReply = {
	id: string;
	name: string;
	is_member: boolean;
	unknown?: number;
};

type SlackListReply = {
	ok: boolean;
	error?: string;
	channels?: SlackChannelReply[];
	response_metadata?: { next_cursor: string };
};

function slackReply(body: SlackListReply): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("persistSlackChannels", () => {
	it("creates, updates and retires the inventory in one pass", async () => {
		await requireRow(
			db
				.insert(slackChannel)
				.values({
					id: `${PREFIX}-keep`,
					name: "old-name",
					memberCount: 1,
					available: false,
				})
				.returning(),
		);
		await requireRow(
			db
				.insert(slackChannel)
				.values({ id: `${PREFIX}-gone`, name: "gone", available: true })
				.returning(),
		);

		const written = await persistSlackChannels(
			[
				{
					id: `${PREFIX}-keep`,
					name: "keep",
					num_members: 12,
					is_member: true,
				},
				{
					id: `${PREFIX}-new`,
					name: "new",
					num_members: 3,
					is_private: true,
					is_member: false,
				},
				{ id: `${PREFIX}-quiet`, name: "quiet", is_member: true },
				{ id: `${PREFIX}-archived`, name: "archived", is_archived: true },
			],
			true,
		);

		expect(written).toBe(3);

		const rows = await db
			.select({
				id: slackChannel.id,
				name: slackChannel.name,
				memberCount: slackChannel.memberCount,
				isPrivate: slackChannel.isPrivate,
				isMember: slackChannel.isMember,
				available: slackChannel.available,
			})
			.from(slackChannel)
			.where(startsWith(slackChannel.id, PREFIX))
			.orderBy(asc(slackChannel.id));

		expect(rows).toEqual([
			{
				id: `${PREFIX}-gone`,
				name: "gone",
				memberCount: null,
				isPrivate: false,
				isMember: false,
				available: false,
			},
			{
				id: `${PREFIX}-keep`,
				name: "keep",
				memberCount: 12,
				isPrivate: false,
				isMember: true,
				available: true,
			},
			{
				id: `${PREFIX}-new`,
				name: "new",
				memberCount: 3,
				isPrivate: true,
				isMember: false,
				available: true,
			},
			{
				id: `${PREFIX}-quiet`,
				name: "quiet",
				memberCount: null,
				isPrivate: false,
				isMember: true,
				available: true,
			},
		]);
	});

	it("retires every channel when nothing is available", async () => {
		await requireRow(
			db
				.insert(slackChannel)
				.values({ id: `${PREFIX}-only`, name: "only", available: true })
				.returning(),
		);

		expect(await persistSlackChannels([], false)).toBe(0);

		const row = await firstRow(
			db
				.select({ available: slackChannel.available })
				.from(slackChannel)
				.where(whereEq(slackChannel.id, `${PREFIX}-only`))
				.limit(1),
		);
		expect(row?.available).toBe(false);
	});

	it("writes nothing when Slack is disconnected", async () => {
		await disconnect();

		const written = await persistSlackChannels(
			[{ id: `${PREFIX}-ghost`, name: "ghost", is_member: true }],
			false,
		);

		expect(written).toBe(0);
		expect(
			await db.$count(
				slackChannel,
				whereEq(slackChannel.id, `${PREFIX}-ghost`),
			),
		).toBe(0);
	});
});

describe("refreshSlackChannels", () => {
	it("aborts a stalled Slack list request", async () => {
		let signal: AbortSignal | null = null;
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			signal = init?.signal ?? null;
			return slackReply({ ok: true, channels: [] });
		}) as typeof fetch;

		await refreshSlackChannels();

		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("follows the cursor across pages", async () => {
		const seen: string[] = [];
		globalThis.fetch = (async (input: URL) => {
			const cursor = input.searchParams.get("cursor") ?? "";
			seen.push(cursor);
			if (cursor === "") {
				return slackReply({
					ok: true,
					channels: [
						{ id: `${PREFIX}-a`, name: "a", is_member: true, unknown: 1 },
					],
					response_metadata: { next_cursor: "page-2" },
				});
			}
			return slackReply({
				ok: true,
				channels: [{ id: `${PREFIX}-b`, name: "b", is_member: true }],
				response_metadata: { next_cursor: "" },
			});
		}) as unknown as typeof fetch;

		expect(await refreshSlackChannels()).toBe(2);
		expect([...new Set(seen)]).toEqual(["", "page-2"]);
	});

	it("does not resurrect the inventory a disconnect removed", async () => {
		globalThis.fetch = (async () => {
			await disconnect();
			return slackReply({
				ok: true,
				channels: [{ id: `${PREFIX}-late`, name: "late", is_member: true }],
			});
		}) as typeof fetch;

		expect(await refreshSlackChannels()).toBe(0);
		expect(
			await db.$count(slackChannel, startsWith(slackChannel.id, PREFIX)),
		).toBe(0);
	});

	it("explains a rejected list", async () => {
		globalThis.fetch = (async () =>
			slackReply({ ok: false, error: "missing_scope" })) as typeof fetch;

		expect(refreshSlackChannels()).rejects.toThrow(
			"Slack channel lookup needs an additional permission. Reconnect Slack and retry.",
		);
	});
});
