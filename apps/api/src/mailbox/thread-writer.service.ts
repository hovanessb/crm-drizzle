import {
	ActivityType,
	activity as activityTable,
	and,
	count,
	type Db,
	EmailDirection,
	type Executor,
	emailMessage,
	emailThread,
	eq,
	isUniqueViolation,
	type MailboxSync,
	max,
	min,
	type NewEmailThread,
	RecordSource,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import type { SyncSource } from "./mailbox.constants";
import {
	MailboxMatchService,
	type MatchContext,
} from "./mailbox-match.service";
import { snippetOf } from "./message-text";
import type { Participant } from "./participants";

export type IncomingMessage = {
	rfcMessageId: string;
	rootId: string;
	subject: string | null;
	from: Participant;
	recipients: { email: string; name: string | null; kind: "to" | "cc" }[];
	body: string;
	sentAt: Date;
	gmailMessageId?: string | null;
	outlookMessageId?: string | null;
	outlookWebLink?: string | null;
};

@Injectable()
export class ThreadWriterService {
	private readonly logger = new Logger(ThreadWriterService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly match: MailboxMatchService,
		private readonly stamp: ActivityStampService,
	) {}

	async context(): Promise<MatchContext> {
		const [internal, suppressedDomains, suppressedEmails] = await Promise.all([
			this.match.internalIdentity(),
			this.match.suppressedDomains(),
			this.match.suppressedEmails(),
		]);

		return {
			ourAddresses: internal.addresses,
			ourDomains: internal.domains,
			suppressedDomains,
			suppressedEmails,
		};
	}

	async store(
		row: MailboxSync,
		options: { mailbox: string; origin: SyncSource },
		parsed: IncomingMessage,
		context: MatchContext,
	): Promise<boolean> {
		const existing = await this.db.query.emailMessage.findFirst({
			where: eq(emailMessage.rfcMessageId, parsed.rfcMessageId),
			columns: { threadId: true },
			with: {
				thread: {
					columns: { companyId: true, contactId: true },
					with: { activity: { columns: { id: true } } },
				},
			},
		});
		if (existing?.thread.activity) return false;

		const repair = existing !== undefined;
		const participants = [parsed.from, ...parsed.recipients];
		const outbound = parsed.from.email === options.mailbox;

		const thread = existing
			? {
					id: existing.threadId,
					companyId: existing.thread.companyId,
					contactId: existing.thread.contactId,
				}
			: await this.db
					.select({
						id: emailThread.id,
						companyId: emailThread.companyId,
						contactId: emailThread.contactId,
					})
					.from(emailThread)
					.where(eq(emailThread.rootMessageId, parsed.rootId))
					.limit(1)
					.then((rows) => rows[0] ?? null);

		let companyId = thread?.companyId ?? null;
		let contactId = thread?.contactId ?? null;

		if (!thread) {
			const repliedTo =
				outbound ||
				(await this.hasOutboundInThread(parsed.rootId, options.mailbox));

			const match = await this.match.resolve(
				{
					participants,
					allowCreate: row.autoCreate && repliedTo,
					source: RecordSource.EMAIL,
					ownerId: row.userId,
				},
				context,
			);

			companyId = match.companyId;
			contactId = match.contactId;

			if (!companyId && !contactId) {
				return false;
			}
		}

		let occurredAt: Date;

		try {
			occurredAt = await this.db.transaction(async (tx) => {
				const record = existing
					? { id: existing.threadId }
					: await this.threadFor(tx, {
							rootMessageId: parsed.rootId,
							subject: parsed.subject,
							companyId,
							contactId,
							firstMessageAt: parsed.sentAt,
							lastMessageAt: parsed.sentAt,
							messageCount: 0,
						});

				if (!repair) {
					await tx.insert(emailMessage).values({
						threadId: record.id,
						rfcMessageId: parsed.rfcMessageId,
						syncedByUserId: row.userId,
						gmailMessageId: parsed.gmailMessageId ?? null,
						outlookMessageId: parsed.outlookMessageId ?? null,
						outlookWebLink: parsed.outlookWebLink ?? null,
						direction: outbound
							? EmailDirection.OUTBOUND
							: EmailDirection.INBOUND,
						fromEmail: parsed.from.email,
						fromName: parsed.from.name,
						recipients: parsed.recipients,
						subject: parsed.subject,
						snippet: snippetOf(parsed.body),
						body: parsed.body || null,
						sentAt: parsed.sentAt,
					});
				}

				const [stats] = await tx
					.select({
						count: count(),
						first: min(emailMessage.sentAt),
						last: max(emailMessage.sentAt),
					})
					.from(emailMessage)
					.where(eq(emailMessage.threadId, record.id));

				const firstMessageAt = stats?.first ?? parsed.sentAt;
				const lastMessageAt = stats?.last ?? parsed.sentAt;

				const data: Partial<NewEmailThread> = {
					messageCount: stats?.count ?? 0,
					firstMessageAt,
					lastMessageAt,
				};

				if (parsed.sentAt <= firstMessageAt) data.subject = parsed.subject;

				await tx
					.update(emailThread)
					.set(data)
					.where(eq(emailThread.id, record.id));

				return this.project(tx, record.id, row.userId, {
					subject: parsed.subject ?? "(no subject)",
					snippet: snippetOf(parsed.body),
					lastMessageAt,
					companyId,
					contactId,
					origin: options.origin,
				});
			});
		} catch (error) {
			if (await this.storedElsewhere(error, parsed.rfcMessageId)) return false;
			throw error;
		}

		await this.touch({ companyId, contactId }, occurredAt, parsed.rfcMessageId);

		return !repair;
	}

	private async storedElsewhere(
		cause: unknown,
		rfcMessageId: string,
	): Promise<boolean> {
		if (!isUniqueViolation(cause)) return false;

		const [winner] = await this.db
			.select({ id: emailMessage.id })
			.from(emailMessage)
			.innerJoin(
				activityTable,
				eq(activityTable.emailThreadId, emailMessage.threadId),
			)
			.where(eq(emailMessage.rfcMessageId, rfcMessageId))
			.limit(1);

		return winner !== undefined;
	}

	private async touch(
		target: { companyId: string | null; contactId: string | null },
		at: Date,
		rfcMessageId: string,
	): Promise<void> {
		try {
			await this.stamp.touch(target, at);
		} catch (error) {
			this.logger.error(
				{
					message: "An email was stored but its activity stamps were not moved",
					rfcMessageId,
					...target,
				},
				error instanceof Error ? error.stack : String(error),
			);
		}
	}

	private async hasOutboundInThread(
		rootMessageId: string,
		mailbox: string,
	): Promise<boolean> {
		const [found] = await this.db
			.select({ id: emailMessage.id })
			.from(emailMessage)
			.innerJoin(emailThread, eq(emailThread.id, emailMessage.threadId))
			.where(
				and(
					eq(emailThread.rootMessageId, rootMessageId),
					eq(emailMessage.fromEmail, mailbox),
				),
			)
			.limit(1);

		return found !== undefined;
	}

	private async threadFor(
		tx: Executor,
		values: NewEmailThread,
	): Promise<{ id: string }> {
		const [created] = await tx
			.insert(emailThread)
			.values(values)
			.onConflictDoNothing({ target: emailThread.rootMessageId })
			.returning({ id: emailThread.id });
		if (created) return created;

		const [existing] = await tx
			.select({ id: emailThread.id })
			.from(emailThread)
			.where(eq(emailThread.rootMessageId, values.rootMessageId))
			.limit(1);
		if (!existing)
			throw new Error(`Thread ${values.rootMessageId} vanished mid-write.`);
		return existing;
	}

	private async project(
		tx: Executor,
		emailThreadId: string,
		userId: string,
		summary: {
			subject: string;
			snippet: string | null;
			lastMessageAt: Date;
			companyId: string | null;
			contactId: string | null;
			origin: SyncSource;
		},
	): Promise<Date> {
		const [activity] = await tx
			.insert(activityTable)
			.values({
				type: ActivityType.EMAIL,
				subject: summary.subject,
				body: summary.snippet,
				occurredAt: summary.lastMessageAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
				createdById: userId,
				emailThreadId,
				meta: { synced: true, source: summary.origin },
			})
			.onConflictDoUpdate({
				target: activityTable.emailThreadId,
				set: { body: summary.snippet, occurredAt: summary.lastMessageAt },
			})
			.returning({ createdAt: activityTable.createdAt });
		if (!activity)
			throw new Error(`Activity for thread ${emailThreadId} was not written.`);

		return activity.createdAt;
	}
}
