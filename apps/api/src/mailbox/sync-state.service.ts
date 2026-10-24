import {
	and,
	type Db,
	eq,
	GoogleSyncStatus,
	inArray,
	isNull,
	lte,
	type MailboxSync,
	mailboxSync,
	type NewMailboxSync,
	notInArray,
	or,
	sql,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import type { SyncSource } from "./mailbox.constants";

export const SYNC_LEASE_MS = 300_000;

@Injectable()
export class SyncStateService {
	private readonly logger = new Logger(SyncStateService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async get(userId: string, source: SyncSource): Promise<MailboxSync | null> {
		const [row] = await this.db
			.select()
			.from(mailboxSync)
			.where(
				and(eq(mailboxSync.userId, userId), eq(mailboxSync.source, source)),
			)
			.limit(1);
		return row ?? null;
	}

	async listForUser(
		userId: string,
		sources?: readonly SyncSource[],
	): Promise<MailboxSync[]> {
		return this.db
			.select()
			.from(mailboxSync)
			.where(
				and(
					eq(mailboxSync.userId, userId),
					sources ? inArray(mailboxSync.source, [...sources]) : undefined,
				),
			);
	}

	async due(now: Date): Promise<MailboxSync[]> {
		return this.db
			.select()
			.from(mailboxSync)
			.where(dueWhere(now))
			.orderBy(sql`${mailboxSync.lastSyncedAt} asc nulls first`);
	}

	async claim(row: MailboxSync, now: Date): Promise<boolean> {
		const claimed = await this.db
			.update(mailboxSync)
			.set({
				status: GoogleSyncStatus.RUNNING,
				retryAfter: new Date(now.getTime() + SYNC_LEASE_MS),
			})
			.where(
				and(
					eq(mailboxSync.id, row.id),
					eq(mailboxSync.updatedAt, row.updatedAt),
					dueWhere(now),
				),
			)
			.returning({ id: mailboxSync.id });

		return claimed.length === 1;
	}

	async release(id: string): Promise<void> {
		await this.db
			.update(mailboxSync)
			.set({ retryAfter: null })
			.where(eq(mailboxSync.id, id));
	}

	async ensure(
		userId: string,
		source: SyncSource,
		options: { autoCreate: boolean },
	): Promise<MailboxSync> {
		const [row] = await this.db
			.insert(mailboxSync)
			.values({
				userId,
				source,
				status: GoogleSyncStatus.IDLE,
				autoCreate: options.autoCreate,
			})
			.onConflictDoUpdate({
				target: [mailboxSync.userId, mailboxSync.source],
				set: {
					status: GoogleSyncStatus.IDLE,
					lastError: null,
					retryAfter: null,
				},
			})
			.returning();
		if (!row)
			throw new Error(`The ${source} sync row for ${userId} was not written.`);
		return row;
	}

	async markRunning(id: string): Promise<void> {
		await this.write(id, { status: GoogleSyncStatus.RUNNING, lastError: null });
	}

	async settle(
		id: string,
		update: {
			cursor?: string | null;
			status: GoogleSyncStatus;
		},
	): Promise<void> {
		await this.write(id, {
			...update,
			lastSyncedAt: new Date(),
			lastError: null,
			retryAfter: null,
		});
	}

	async clearCursor(id: string, reason: string): Promise<void> {
		this.logger.warn({
			message: "Sync cursor invalidated — resuming from now",
			syncId: id,
			reason,
		});

		await this.write(id, {
			cursor: null,
			status: GoogleSyncStatus.IDLE,
			lastError: null,
			retryAfter: null,
		});
	}

	async markNeedsReconnect(id: string, reason: string): Promise<void> {
		await this.write(id, {
			status: GoogleSyncStatus.NEEDS_RECONNECT,
			lastError: reason,
			retryAfter: null,
		});
	}

	async markRateLimited(id: string, retryAfterMs: number): Promise<void> {
		await this.write(id, {
			status: GoogleSyncStatus.IDLE,
			retryAfter: new Date(Date.now() + retryAfterMs),
		});
	}

	async markFailed(id: string, reason: string): Promise<void> {
		await this.write(id, {
			status: GoogleSyncStatus.FAILED,
			lastError: reason,
			retryAfter: null,
		});
	}

	async setAutoCreate(
		userId: string,
		source: SyncSource,
		enabled: boolean,
	): Promise<void> {
		await this.db
			.update(mailboxSync)
			.set({ autoCreate: enabled })
			.where(
				and(eq(mailboxSync.userId, userId), eq(mailboxSync.source, source)),
			);
	}

	async remove(userId: string, source?: SyncSource): Promise<void> {
		await this.db
			.delete(mailboxSync)
			.where(
				and(
					eq(mailboxSync.userId, userId),
					source ? eq(mailboxSync.source, source) : undefined,
				),
			);
	}

	private async write(
		id: string,
		data: Partial<NewMailboxSync>,
	): Promise<void> {
		const [row] = await this.db
			.update(mailboxSync)
			.set(data)
			.where(eq(mailboxSync.id, id))
			.returning({ id: mailboxSync.id });
		if (!row) throw new Error(`No mailbox sync row with id ${id}.`);
	}
}

function dueWhere(now: Date) {
	return and(
		notInArray(mailboxSync.status, [GoogleSyncStatus.NEEDS_RECONNECT]),
		or(isNull(mailboxSync.retryAfter), lte(mailboxSync.retryAfter, now)),
	);
}
