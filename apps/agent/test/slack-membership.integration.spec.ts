import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	account,
	agentTask,
	and,
	db,
	eq,
	firstRow,
	notInArray,
	requireRow,
	slackChannel,
	slackWorkspaceGrant,
	sql,
	user,
} from "@crm/db";
import { joinSlackChannel } from "../agent/lib/slack-membership";

const USER_ID = "slack-join-spec-user";
const ACCOUNT_ID = "slack-join-spec-account";
const CHANNEL_ID = "CJOINSPEC1";
const GRANT_ID = "slack-join-spec-grant";
const INVENTORY_KIND = "slack-people-match";

const realFetch = globalThis.fetch;

async function connect() {
	await requireRow(
		db
			.insert(user)
			.values({
				id: USER_ID,
				name: "Slack Join Spec",
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
				accountId: "T-JOIN-SPEC",
				providerId: "slack",
				userId: USER_ID,
				accessToken: "xoxb-join-spec",
			})
			.onConflictDoUpdate({
				target: account.id,
				set: { ...{ accessToken: "xoxb-join-spec" }, updatedAt: new Date() },
			})
			.returning(),
	);
}

function answers(error: string) {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ ok: false, error }), {
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
}

const requested: string[] = [];

function replies(reply: (url: string) => object) {
	globalThis.fetch = (async (input: URL | RequestInfo) => {
		const url = String(input instanceof Request ? input.url : input);
		requested.push(url);
		return new Response(JSON.stringify(reply(url)), {
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

let inventoryTaskIds: string[] = [];

beforeEach(async () => {
	requested.length = 0;
	inventoryTaskIds = (
		await db
			.select({ id: agentTask.id })
			.from(agentTask)
			.where(eq(agentTask.kind, INVENTORY_KIND))
	).map((task) => task.id);
	await db.delete(slackChannel).where(eq(slackChannel.id, CHANNEL_ID));
	await connect();
	await requireRow(
		db
			.insert(slackChannel)
			.values({
				id: CHANNEL_ID,
				name: "join-spec",
				isPrivate: false,
				isMember: false,
				available: true,
			})
			.returning(),
	);
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	await db.delete(slackChannel).where(eq(slackChannel.id, CHANNEL_ID));
	await db
		.delete(slackWorkspaceGrant)
		.where(eq(slackWorkspaceGrant.id, GRANT_ID));
	await db
		.delete(agentTask)
		.where(
			and(
				eq(agentTask.kind, INVENTORY_KIND),
				notInArray(agentTask.id, inventoryTaskIds),
			),
		);
	await db.delete(account).where(eq(account.id, ACCOUNT_ID));
	await db.delete(user).where(eq(user.id, USER_ID));
});

describe("joining a Slack channel", () => {
	it("does not claim membership of an archived channel", async () => {
		answers("is_archived");

		const outcome = await joinSlackChannel(CHANNEL_ID);

		expect(outcome.joined).toBe(false);
		expect(outcome).toMatchObject({ needsHuman: true });

		const row = await firstRow(
			db
				.select({ isMember: slackChannel.isMember })
				.from(slackChannel)
				.where(eq(slackChannel.id, CHANNEL_ID))
				.limit(1),
		);
		expect(row?.isMember).toBe(false);
	});

	it("reads the channel from Slack rather than a row the migration reset", async () => {
		replies((url) =>
			url.includes("conversations.info")
				? { ok: true, channel: { is_private: true, is_member: true } }
				: { ok: false, error: "method_not_supported_for_channel_type" },
		);

		const outcome = await joinSlackChannel(CHANNEL_ID);

		expect(outcome).toEqual({ joined: true, already: true });
		expect(requested.some((url) => url.includes("conversations.join"))).toBe(
			false,
		);
		expect(
			await firstRow(
				db
					.select({
						isPrivate: slackChannel.isPrivate,
						isMember: slackChannel.isMember,
					})
					.from(slackChannel)
					.where(eq(slackChannel.id, CHANNEL_ID))
					.limit(1),
			),
		).toEqual({ isPrivate: true, isMember: true });
		expect(
			await db.$count(
				agentTask,
				and(
					eq(agentTask.kind, INVENTORY_KIND),
					notInArray(agentTask.id, inventoryTaskIds),
				),
			),
		).toBe(1);
	});

	it("invites itself to a private channel a stale row calls public", async () => {
		await requireRow(
			db
				.insert(slackWorkspaceGrant)
				.values({
					id: GRANT_ID,
					teamId: "T-JOIN-SPEC",
					userToken: "xoxp-join-spec",
					userScopes: "groups:write",
				})
				.returning(),
		);
		replies((url) => {
			if (url.includes("conversations.info")) {
				return { ok: false, error: "channel_not_found" };
			}
			if (url.includes("auth.test")) return { ok: true, user_id: "U-JOIN" };
			return { ok: true };
		});

		const outcome = await joinSlackChannel(CHANNEL_ID);

		expect(outcome).toEqual({ joined: true, already: false });
		expect(requested.some((url) => url.includes("conversations.invite"))).toBe(
			true,
		);
		expect(requested.some((url) => url.includes("conversations.join"))).toBe(
			false,
		);
		expect(
			await firstRow(
				db
					.select({
						isPrivate: slackChannel.isPrivate,
						isMember: slackChannel.isMember,
					})
					.from(slackChannel)
					.where(eq(slackChannel.id, CHANNEL_ID))
					.limit(1),
			),
		).toEqual({ isPrivate: true, isMember: true });
	});

	it("accepts a channel Slack says it is already in", async () => {
		answers("already_in_channel");

		const outcome = await joinSlackChannel(CHANNEL_ID);

		expect(outcome).toEqual({ joined: true, already: true });

		const row = await firstRow(
			db
				.select({ isMember: slackChannel.isMember })
				.from(slackChannel)
				.where(eq(slackChannel.id, CHANNEL_ID))
				.limit(1),
		);
		expect(row?.isMember).toBe(true);
	});
});
