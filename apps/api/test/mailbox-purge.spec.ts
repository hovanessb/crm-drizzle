import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	GOOGLE_PROVIDER_ID,
	MICROSOFT_PROVIDER_ID,
	OUTLOOK_MAIL_SCOPE,
	SYNC_SCOPES,
} from "@crm/auth/scopes";
import {
	ActivityType,
	account as accountTable,
	activity,
	and,
	asc,
	calendarEvent,
	company as companyTable,
	db,
	EmailDirection,
	emailMessage,
	emailThread,
	eq,
	GoogleSyncStatus,
	inArray,
	mailboxSync,
	user,
} from "@crm/db";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { GoogleConnectionService } from "../src/google/google-connection.service";
import type { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { MailboxTokenService } from "../src/mailbox/mailbox-token.service";
import { SyncStateService } from "../src/mailbox/sync-state.service";
import { MicrosoftConnectionService } from "../src/microsoft/microsoft-connection.service";
import { first, one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "mailbox-purge-spec";
const domain = `purge-${suffix}.test`;

const gmailRep = `gmail-rep-${suffix}`;
const outlookRep = `outlook-rep-${suffix}`;
const otherRep = `other-rep-${suffix}`;
const userIds = [gmailRep, outlookRep, otherRep];

const shared = `shared-${suffix}`;
const solo = `solo-${suffix}`;
const theirs = `theirs-${suffix}`;
const roots = [shared, solo, theirs];

const tokens = new MailboxTokenService(db);
const state = new SyncStateService(db);
const stamp = new ActivityStampService(db);

const google = new GoogleConnectionService(
	db,
	tokens,
	state,
	{} as unknown as MailboxMatchService,
	stamp,
);
const microsoft = new MicrosoftConnectionService(db, tokens, state, stamp);

function at(hour: number): Date {
	return new Date(Date.UTC(2026, 0, 1, hour));
}

type Wire = {
	id: string;
	syncedByUserId: string;
	provider: "gmail" | "outlook";
	sentAt: Date;
	subject: string;
	snippet: string;
};

async function thread(
	rootMessageId: string,
	companyId: string,
	messages: Wire[],
): Promise<void> {
	const first = messages[0];
	const last = messages[messages.length - 1];
	if (!first || !last) return;

	const thread = await one(
		db
			.insert(emailThread)
			.values({
				rootMessageId,
				subject: first.subject,
				companyId,
				firstMessageAt: first.sentAt,
				lastMessageAt: last.sentAt,
				messageCount: messages.length,
			})
			.returning({ id: emailThread.id }),
	);
	await db.insert(emailMessage).values(
		messages.map((message) => ({
			threadId: thread.id,
			rfcMessageId: `${message.id}@${domain}`,
			syncedByUserId: message.syncedByUserId,
			gmailMessageId: message.provider === "gmail" ? message.id : null,
			outlookMessageId: message.provider === "outlook" ? message.id : null,
			direction: EmailDirection.INBOUND,
			fromEmail: `them@${domain}`,
			recipients: [],
			subject: message.subject,
			snippet: message.snippet,
			sentAt: message.sentAt,
		})),
	);
	await db.insert(activity).values({
		type: ActivityType.EMAIL,
		subject: first.subject,
		body: last.snippet,
		occurredAt: last.sentAt,
		companyId,
		createdById: first.syncedByUserId,
		meta: { synced: true },
		emailThreadId: thread.id,
	});
}

async function seed(): Promise<void> {
	const company = await one(
		db
			.insert(companyTable)
			.values({ name: "Purge Co", domain })
			.returning({ id: companyTable.id }),
	);

	await thread(shared, company.id, [
		{
			id: `m1-${suffix}`,
			syncedByUserId: gmailRep,
			provider: "gmail",
			sentAt: at(9),
			subject: "Kickoff",
			snippet: "first",
		},
		{
			id: `m2-${suffix}`,
			syncedByUserId: outlookRep,
			provider: "outlook",
			sentAt: at(10),
			subject: "Re: Kickoff",
			snippet: "second",
		},
		{
			id: `m3-${suffix}`,
			syncedByUserId: otherRep,
			provider: "gmail",
			sentAt: at(11),
			subject: "Re: Kickoff",
			snippet: "third",
		},
	]);

	await thread(solo, company.id, [
		{
			id: `m4-${suffix}`,
			syncedByUserId: gmailRep,
			provider: "gmail",
			sentAt: at(8),
			subject: "Only mine",
			snippet: "alone",
		},
	]);

	await thread(theirs, company.id, [
		{
			id: `m5-${suffix}`,
			syncedByUserId: outlookRep,
			provider: "outlook",
			sentAt: at(7),
			subject: "Not mine",
			snippet: "untouched",
		},
	]);

	await one(
		db
			.insert(calendarEvent)
			.values({
				iCalUid: `ical-${suffix}`,
				originalStartTime: at(12),
				startsAt: at(12),
				endsAt: at(13),
				status: "confirmed",
				companyId: company.id,
				syncedByUserId: gmailRep,
			})
			.returning(),
	);
}

async function clean(): Promise<void> {
	await db
		.delete(calendarEvent)
		.where(inArray(calendarEvent.syncedByUserId, userIds));
	await db.delete(emailThread).where(inArray(emailThread.rootMessageId, roots));
	await db.delete(mailboxSync).where(inArray(mailboxSync.userId, userIds));
	await db.delete(accountTable).where(inArray(accountTable.userId, userIds));
	await db.delete(user).where(inArray(user.id, userIds));
	await db.delete(companyTable).where(eq(companyTable.domain, domain));
}

async function messagesOn(rootMessageId: string): Promise<string[]> {
	const rows = await db
		.select({ snippet: emailMessage.snippet })
		.from(emailMessage)
		.innerJoin(emailThread, eq(emailThread.id, emailMessage.threadId))
		.where(eq(emailThread.rootMessageId, rootMessageId))
		.orderBy(asc(emailMessage.sentAt));

	return rows.map((row) => row.snippet ?? "");
}

async function threadState(rootMessageId: string) {
	const row = await db.query.emailThread.findFirst({
		where: eq(emailThread.rootMessageId, rootMessageId),
		columns: {
			subject: true,
			messageCount: true,
			firstMessageAt: true,
			lastMessageAt: true,
		},
		with: { activity: { columns: { body: true, occurredAt: true } } },
	});
	return row ?? null;
}

beforeEach(async () => {
	await clean();

	await db.insert(user).values(
		userIds.map((id) => ({
			id,
			name: id,
			email: `${id}@${domain}`,
		})),
	);

	await seed();
});

afterAll(clean);

describe("purging Gmail data", () => {
	it("removes only the caller's Gmail messages and counts them", async () => {
		expect(await google.purgeSyncedData(gmailRep)).toEqual({ purged: 3 });
	});

	it("leaves a thread standing when somebody else's messages remain", async () => {
		await google.purgeSyncedData(gmailRep);

		expect(await messagesOn(shared)).toEqual(["second", "third"]);
		expect(await threadState(shared)).toEqual({
			subject: "Re: Kickoff",
			messageCount: 2,
			firstMessageAt: at(10),
			lastMessageAt: at(11),
			activity: { body: "third", occurredAt: at(11) },
		});
	});

	it("takes the thread and its activity when nothing is left", async () => {
		await google.purgeSyncedData(gmailRep);

		expect(await threadState(solo)).toBeNull();
		expect(await db.$count(activity, eq(activity.subject, "Only mine"))).toBe(
			0,
		);
	});

	it("cannot reach a thread the caller never synced into", async () => {
		await google.purgeSyncedData(gmailRep);

		expect(await messagesOn(theirs)).toEqual(["untouched"]);
		expect(await threadState(theirs)).toEqual({
			subject: "Not mine",
			messageCount: 1,
			firstMessageAt: at(7),
			lastMessageAt: at(7),
			activity: { body: "untouched", occurredAt: at(7) },
		});
	});
});

describe("purging Outlook data", () => {
	it("removes only the caller's Outlook messages and counts them", async () => {
		expect(await microsoft.purgeSyncedData(outlookRep)).toEqual({ purged: 2 });
	});

	it("leaves the Gmail messages on a shared thread alone", async () => {
		await microsoft.purgeSyncedData(outlookRep);

		expect(await messagesOn(shared)).toEqual(["first", "third"]);
		expect(await threadState(shared)).toEqual({
			subject: "Kickoff",
			messageCount: 2,
			firstMessageAt: at(9),
			lastMessageAt: at(11),
			activity: { body: "third", occurredAt: at(11) },
		});
	});

	it("cannot delete another user's Gmail thread", async () => {
		await microsoft.purgeSyncedData(outlookRep);

		expect(await messagesOn(solo)).toEqual(["alone"]);
		expect(
			await db.$count(
				calendarEvent,
				eq(calendarEvent.iCalUid, `ical-${suffix}`),
			),
		).toBe(1);
	});
});

describe("disconnecting Microsoft", () => {
	async function grant(scope: string): Promise<void> {
		await one(
			db
				.insert(accountTable)
				.values({
					id: `ms-${suffix}`,
					accountId: `ms-account-${suffix}`,
					providerId: MICROSOFT_PROVIDER_ID,
					userId: outlookRep,
					scope,
				})
				.returning(),
		);
	}

	it("clears the grant even when the token columns are already empty", async () => {
		await grant(`openid profile ${OUTLOOK_MAIL_SCOPE}`);
		await state.ensure(outlookRep, "outlook", { autoCreate: false });

		expect(await microsoft.revoke(outlookRep)).toEqual({ revoked: true });

		const account = await first(
			db
				.select({ scope: accountTable.scope })
				.from(accountTable)
				.where(
					and(
						eq(accountTable.userId, outlookRep),
						eq(accountTable.providerId, MICROSOFT_PROVIDER_ID),
					),
				)
				.limit(1),
		);
		expect(account?.scope).toBeNull();
	});

	it("stays disconnected instead of re-creating the sync row", async () => {
		await grant(`openid profile ${OUTLOOK_MAIL_SCOPE}`);
		await state.ensure(outlookRep, "outlook", { autoCreate: false });

		await microsoft.revoke(outlookRep);
		const status = await microsoft.status(outlookRep);

		expect(status.linked).toBe(false);
		expect(status.required).toBe(true);
		expect(await state.get(outlookRep, "outlook")).toBeNull();
	});

	it("offers Connect to a sign-in that never granted the mail scope", async () => {
		await grant("openid profile email https://graph.microsoft.com/User.Read");

		const status = await microsoft.status(outlookRep);

		expect(status.linked).toBe(false);
		expect(status.sources.every((source) => !source.connected)).toBe(true);
	});

	it("is linked while the mail scope is granted", async () => {
		await grant(`openid profile ${OUTLOOK_MAIL_SCOPE}`);

		const status = await microsoft.status(outlookRep);

		expect(status.linked).toBe(true);
		expect(await state.get(outlookRep, "outlook")).not.toBeNull();
	});
});

describe("disconnecting Google", () => {
	const realFetch = globalThis.fetch;

	async function grant(scope: string, refreshToken: string | null) {
		await one(
			db
				.insert(accountTable)
				.values({
					id: `goog-${suffix}`,
					accountId: `goog-account-${suffix}`,
					providerId: GOOGLE_PROVIDER_ID,
					userId: gmailRep,
					refreshToken,
					scope,
				})
				.returning(),
		);
	}

	async function scopeOf(): Promise<string | null | undefined> {
		const account = await first(
			db
				.select({ scope: accountTable.scope })
				.from(accountTable)
				.where(
					and(
						eq(accountTable.userId, gmailRep),
						eq(accountTable.providerId, GOOGLE_PROVIDER_ID),
					),
				)
				.limit(1),
		);

		return account?.scope;
	}

	it("clears a grant with no token without asking Google", async () => {
		await grant(SYNC_SCOPES.join(" "), null);

		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		try {
			expect(await google.revoke(gmailRep)).toEqual({ revoked: true });
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(calls).toBe(0);
		expect(await scopeOf()).toBeNull();
		expect((await google.status(gmailRep)).linked).toBe(false);
	});

	it("refuses to clear when Google will not revoke the token", async () => {
		await grant(SYNC_SCOPES.join(" "), "refresh-token");

		globalThis.fetch = (async () =>
			new Response(null, { status: 400 })) as unknown as typeof fetch;

		try {
			expect(await google.revoke(gmailRep)).toEqual({ revoked: false });
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(await scopeOf()).toBe(SYNC_SCOPES.join(" "));
	});

	it("clears once Google accepts the revocation", async () => {
		await grant(SYNC_SCOPES.join(" "), "refresh-token");

		globalThis.fetch = (async () =>
			new Response(null, { status: 200 })) as unknown as typeof fetch;

		try {
			expect(await google.revoke(gmailRep)).toEqual({ revoked: true });
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(await scopeOf()).toBeNull();
	});

	it("offers Connect to a sign-in that never granted the sync scopes", async () => {
		await grant("openid email profile", null);

		const status = await google.status(gmailRep);

		expect(status.linked).toBe(false);
		expect(status.sources.every((source) => !source.connected)).toBe(true);
	});

	it("is linked while a sync scope is granted", async () => {
		await grant(SYNC_SCOPES.join(" "), "refresh-token");

		const status = await google.status(gmailRep);

		expect(status.linked).toBe(true);
		expect(
			status.sources.filter((source) => source.status === GoogleSyncStatus.IDLE)
				.length,
		).toBe(2);
	});
});
