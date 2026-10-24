import { GOOGLE_PROVIDER_ID } from "@crm/auth/scopes";
import {
	account,
	agentTask,
	and,
	asc,
	contact,
	contactFact,
	type Db,
	eq,
	FactStatus,
	inArray,
	isNotNull,
	isNull,
	mailboxSync,
	not,
	or,
	session,
	startsWith,
} from "@crm/db";
import {
	MILESTONES,
	type Milestone,
	milestone,
	reachedMilestones,
	readInstall,
} from "@crm/telemetry";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { SEED_OWNER_PREFIX } from "./seed";

@Injectable()
export class FunnelService {
	private readonly logger = new Logger(FunnelService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async sweep(): Promise<Milestone[]> {
		const reached = new Set(await reachedMilestones());
		const outstanding = MILESTONES.filter((step) => !reached.has(step));
		if (outstanding.length === 0) return [];

		const sent: Milestone[] = [];

		for (const step of outstanding) {
			try {
				const at = await this.when(step);
				if (!at) continue;
				if (await milestone(step, at)) sent.push(step);
			} catch (error) {
				this.logger.debug({
					message: "Could not settle a telemetry milestone",
					step,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return sent;
	}

	private async when(step: Milestone): Promise<Date | null> {
		switch (step) {
			case "migrations_applied":
				return (await readInstall())?.createdAt ?? null;

			case "first_sign_in":
				return this.earliest(
					this.db
						.select({ at: session.createdAt })
						.from(session)
						.orderBy(asc(session.createdAt))
						.limit(1),
				);

			case "google_oauth_configured": {
				const configured =
					process.env.GOOGLE_CLIENT_ID?.trim() &&
					process.env.GOOGLE_CLIENT_SECRET?.trim();

				if (!configured) return null;

				const linked = await this.earliest(
					this.db
						.select({ at: account.createdAt })
						.from(account)
						.where(eq(account.providerId, GOOGLE_PROVIDER_ID))
						.orderBy(asc(account.createdAt))
						.limit(1),
				);

				return linked ?? new Date();
			}

			case "first_mailbox_sync":
				return this.earliest(
					this.db
						.select({ at: mailboxSync.lastSyncedAt })
						.from(mailboxSync)
						.where(isNotNull(mailboxSync.lastSyncedAt))
						.orderBy(asc(mailboxSync.lastSyncedAt))
						.limit(1),
				);

			case "first_non_seed_contact":
				return this.earliest(
					this.db
						.select({ at: contact.createdAt })
						.from(contact)
						.where(
							or(
								isNull(contact.ownerId),
								not(startsWith(contact.ownerId, SEED_OWNER_PREFIX)),
							),
						)
						.orderBy(asc(contact.createdAt))
						.limit(1),
				);

			case "first_agent_task_claimed":
				return this.earliest(
					this.db
						.select({ at: agentTask.startedAt })
						.from(agentTask)
						.where(isNotNull(agentTask.startedAt))
						.orderBy(asc(agentTask.startedAt))
						.limit(1),
				);

			case "first_agent_task_completed":
				return this.earliest(
					this.db
						.select({ at: agentTask.finishedAt })
						.from(agentTask)
						.where(isNotNull(agentTask.finishedAt))
						.orderBy(asc(agentTask.finishedAt))
						.limit(1),
				);

			case "first_fact_applied":
				return this.firstApplied();
		}
	}

	private async firstApplied(): Promise<Date | null> {
		const everApplied = inArray(contactFact.status, [
			FactStatus.APPLIED,
			FactStatus.SUPERSEDED,
		]);

		const [[decided], [undecided]] = await Promise.all([
			this.db
				.select({ decidedAt: contactFact.decidedAt })
				.from(contactFact)
				.where(and(everApplied, isNotNull(contactFact.decidedAt)))
				.orderBy(asc(contactFact.decidedAt))
				.limit(1),
			this.db
				.select({ observedAt: contactFact.observedAt })
				.from(contactFact)
				.where(and(everApplied, isNull(contactFact.decidedAt)))
				.orderBy(asc(contactFact.observedAt))
				.limit(1),
		]);

		const applied = [decided?.decidedAt, undecided?.observedAt].filter(
			(at): at is Date => at instanceof Date,
		);

		if (applied.length === 0) return null;

		return new Date(Math.min(...applied.map((at) => at.getTime())));
	}

	private async earliest(
		query: PromiseLike<{ at: Date | null }[]>,
	): Promise<Date | null> {
		const [row] = await query;
		return row?.at ?? null;
	}
}
