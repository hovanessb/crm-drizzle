import { isGoogleConfigured } from "@crm/auth/env";
import { GOOGLE_PROVIDER_ID, signsInWithGoogle } from "@crm/auth/scopes";
import {
	account,
	activity,
	and,
	asc,
	calendarEvent,
	company,
	contains,
	type Db,
	type Executor,
	emailMessage,
	emailThread,
	eq,
	inArray,
	isNotNull,
	notExists,
	or,
	sql,
	suppressedDomain,
} from "@crm/db";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { normalizeDomain } from "../companies/domain";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import {
	GOOGLE_SYNC_SOURCES,
	type GoogleSyncSource,
	SCOPE_FOR_SOURCE,
} from "../mailbox/mailbox.constants";
import { MailboxMatchService } from "../mailbox/mailbox-match.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { SyncStateService } from "../mailbox/sync-state.service";
import type {
	GoogleConnectionStatus,
	GoogleSourceStatus,
	PurgeSyncedDataOutput,
	RevokeAccessOutput,
	SuppressDomainOutput,
} from "./google.contracts";

const PURGE_TIMEOUT_MS = 60_000;

@Injectable()
export class GoogleConnectionService {
	private readonly logger = new Logger(GoogleConnectionService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly tokens: MailboxTokenService,
		private readonly state: SyncStateService,
		private readonly match: MailboxMatchService,
		private readonly stamp: ActivityStampService,
	) {}

	async status(userId: string): Promise<GoogleConnectionStatus> {
		await this.onConnected(userId);

		const [granted, rows, hasRefreshToken, accounts] = await Promise.all([
			this.tokens.grantedScopes(userId, GOOGLE_PROVIDER_ID),
			this.state.listForUser(userId, GOOGLE_SYNC_SOURCES),
			this.tokens.hasRefreshToken(userId, GOOGLE_PROVIDER_ID),
			this.tokens.signInAccounts(userId),
		]);

		const bySource = new Map(rows.map((row) => [row.source, row]));

		const sources = GOOGLE_SYNC_SOURCES.map((source): GoogleSourceStatus => {
			const row = bySource.get(source);
			const connected = granted.has(SCOPE_FOR_SOURCE[source]);

			return {
				source,
				connected,
				status: row?.status ?? null,
				lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
				lastError: row?.lastError ?? null,
				autoCreate: row?.autoCreate ?? false,
			};
		});

		return {
			configured: isGoogleConfigured(),
			linked:
				accounts.some((account) => account.providerId === GOOGLE_PROVIDER_ID) &&
				sources.some((source) => source.connected),
			required: signsInWithGoogle(accounts),
			hasRefreshToken,
			sources,
		};
	}

	async onConnected(userId: string): Promise<void> {
		const [granted, existing] = await Promise.all([
			this.tokens.grantedScopes(userId, GOOGLE_PROVIDER_ID),
			this.state.listForUser(userId, GOOGLE_SYNC_SOURCES),
		]);

		const known = new Set(existing.map((row) => row.source));

		const added: string[] = [];

		for (const source of GOOGLE_SYNC_SOURCES) {
			if (!granted.has(SCOPE_FOR_SOURCE[source])) continue;
			if (known.has(source)) continue;

			await this.state.ensure(userId, source, {
				autoCreate: source === "calendar",
			});

			added.push(source);
		}

		if (added.length > 0) {
			this.logger.log({ message: "Google connected", userId, sources: added });
		}
	}

	async reconcileAll(): Promise<void> {
		const accounts = await this.db
			.select({ userId: account.userId })
			.from(account)
			.where(
				and(
					eq(account.providerId, GOOGLE_PROVIDER_ID),
					or(
						...GOOGLE_SYNC_SOURCES.map((source) =>
							contains(account.scope, SCOPE_FOR_SOURCE[source]),
						),
					),
				),
			);

		for (const userId of new Set(accounts.map((row) => row.userId))) {
			await this.onConnected(userId);
		}
	}

	async purgeSyncedData(userId: string): Promise<PurgeSyncedDataOutput> {
		const mine = and(
			eq(emailMessage.syncedByUserId, userId),
			isNotNull(emailMessage.gmailMessageId),
		);

		const purged = await this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SET LOCAL statement_timeout = ${sql.raw(String(PURGE_TIMEOUT_MS))}`,
			);

			const touched = await tx
				.selectDistinct({ threadId: emailMessage.threadId })
				.from(emailMessage)
				.where(mine);

			const threadIds = touched.map((row) => row.threadId);
			const messages = await tx
				.delete(emailMessage)
				.where(mine)
				.returning({ id: emailMessage.id });

			if (threadIds.length > 0) {
				await tx
					.delete(emailThread)
					.where(
						and(
							inArray(emailThread.id, threadIds),
							notExists(
								tx
									.select({ id: emailMessage.id })
									.from(emailMessage)
									.where(eq(emailMessage.threadId, emailThread.id)),
							),
						),
					);
			}

			await rebuildThreads(tx, threadIds);

			const events = await tx
				.delete(calendarEvent)
				.where(eq(calendarEvent.syncedByUserId, userId))
				.returning({ id: calendarEvent.id });

			return messages.length + events.length;
		});

		await this.stamp.recomputeAll();

		this.logger.log({ message: "Google data purged", userId, purged });

		return { purged };
	}

	async revoke(userId: string): Promise<RevokeAccessOutput> {
		for (const source of GOOGLE_SYNC_SOURCES) {
			await this.state.remove(userId, source);
		}

		const revoked = await this.tokens.revoke(userId, GOOGLE_PROVIDER_ID);
		return { revoked };
	}

	async setAutoCreate(
		userId: string,
		source: GoogleSyncSource,
		enabled: boolean,
	): Promise<void> {
		const row = await this.state.get(userId, source);
		if (!row) {
			throw new NotFoundException(`${source} is not connected.`);
		}

		await this.state.setAutoCreate(userId, source, enabled);
	}

	async suppressDomain(
		domain: string,
		options: { reason?: string; purge: boolean },
	): Promise<SuppressDomainOutput> {
		const normalised = normalizeDomain(domain);
		if (!normalised) {
			throw new NotFoundException(`"${domain}" is not a domain.`);
		}

		const ours = await this.match.internalIdentity();
		if (ours.domains.has(normalised)) {
			throw new NotFoundException(
				"That is our own domain — it is already excluded.",
			);
		}

		await this.db
			.insert(suppressedDomain)
			.values({ domain: normalised, reason: options.reason ?? null })
			.onConflictDoUpdate({
				target: suppressedDomain.domain,
				set: { reason: options.reason ?? null },
			});

		if (!options.purge) return { domain: normalised, purged: 0 };

		const [owner] = await this.db
			.select({ id: company.id })
			.from(company)
			.where(eq(company.domain, normalised))
			.limit(1);

		if (!owner) return { domain: normalised, purged: 0 };

		const { threads, events } = await this.db.transaction(async (tx) => ({
			threads: await tx
				.delete(emailThread)
				.where(eq(emailThread.companyId, owner.id))
				.returning({ id: emailThread.id }),
			events: await tx
				.delete(calendarEvent)
				.where(eq(calendarEvent.companyId, owner.id))
				.returning({ id: calendarEvent.id }),
		}));

		await this.stamp.recomputeAll();

		this.logger.log({
			message: "Domain suppressed",
			domain: normalised,
			purged: threads.length + events.length,
		});

		return { domain: normalised, purged: threads.length + events.length };
	}
}

async function rebuildThreads(
	tx: Executor,
	threadIds: string[],
): Promise<void> {
	if (threadIds.length === 0) return;

	const remaining = await tx
		.select({
			threadId: emailMessage.threadId,
			sentAt: emailMessage.sentAt,
			subject: emailMessage.subject,
			snippet: emailMessage.snippet,
		})
		.from(emailMessage)
		.where(inArray(emailMessage.threadId, threadIds))
		.orderBy(asc(emailMessage.sentAt));

	const byThread = new Map<string, typeof remaining>();

	for (const message of remaining) {
		const group = byThread.get(message.threadId);
		if (group) group.push(message);
		else byThread.set(message.threadId, [message]);
	}

	for (const [threadId, messages] of byThread) {
		const first = messages.at(0);
		const last = messages.at(-1);
		if (!first || !last) continue;

		await tx
			.update(emailThread)
			.set({
				messageCount: messages.length,
				firstMessageAt: first.sentAt,
				lastMessageAt: last.sentAt,
				subject: first.subject,
			})
			.where(eq(emailThread.id, threadId));

		await tx
			.update(activity)
			.set({ body: last.snippet, occurredAt: last.sentAt })
			.where(eq(activity.emailThreadId, threadId));
	}
}
