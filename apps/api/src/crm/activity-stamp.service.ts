import {
	activity,
	and,
	company,
	contact,
	type Db,
	deal,
	type Executor,
	eq,
	isNotNull,
	isNull,
	lt,
	max,
	or,
	type SQL,
	sql,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

export type ActivityTarget = {
	companyId?: string | null;
	contactId?: string | null;
	dealId?: string | null;
};

export type StampTargets = {
	companyIds: string[];
	contactIds: string[];
	dealIds: string[];
};

function present(ids: (string | null)[]): string[] {
	return ids.filter((id): id is string => id !== null);
}

@Injectable()
export class ActivityStampService {
	private readonly logger = new Logger(ActivityStampService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async touch(target: ActivityTarget, at: Date): Promise<void> {
		await Promise.all([
			target.companyId
				? this.db
						.update(company)
						.set({ lastActivityAt: at })
						.where(
							and(
								eq(company.id, target.companyId),
								or(
									isNull(company.lastActivityAt),
									lt(company.lastActivityAt, at),
								),
							),
						)
				: null,
			target.contactId
				? this.db
						.update(contact)
						.set({ lastActivityAt: at })
						.where(
							and(
								eq(contact.id, target.contactId),
								or(
									isNull(contact.lastActivityAt),
									lt(contact.lastActivityAt, at),
								),
							),
						)
				: null,
			target.dealId
				? this.db
						.update(deal)
						.set({ lastActivityAt: at })
						.where(
							and(
								eq(deal.id, target.dealId),
								or(isNull(deal.lastActivityAt), lt(deal.lastActivityAt, at)),
							),
						)
				: null,
		]);
	}

	private async latest(where: SQL): Promise<Date | null> {
		const [row] = await this.db
			.select({ at: max(activity.createdAt) })
			.from(activity)
			.where(where);
		return row?.at ?? null;
	}

	async recompute(target: ActivityTarget): Promise<void> {
		if (target.companyId) {
			const lastActivityAt = await this.latest(
				eq(activity.companyId, target.companyId),
			);
			await this.db
				.update(company)
				.set({ lastActivityAt })
				.where(eq(company.id, target.companyId));
		}

		if (target.contactId) {
			const lastActivityAt = await this.latest(
				eq(activity.contactId, target.contactId),
			);
			await this.db
				.update(contact)
				.set({ lastActivityAt })
				.where(eq(contact.id, target.contactId));
		}

		if (target.dealId) {
			const lastActivityAt = await this.latest(
				eq(activity.dealId, target.dealId),
			);
			await this.db
				.update(deal)
				.set({ lastActivityAt })
				.where(eq(deal.id, target.dealId));
		}
	}

	async targetsOf(
		where: SQL | undefined,
		client: Executor = this.db,
	): Promise<StampTargets> {
		const [companies, contacts, deals] = await Promise.all([
			client
				.selectDistinct({ companyId: activity.companyId })
				.from(activity)
				.where(and(where, isNotNull(activity.companyId))),
			client
				.selectDistinct({ contactId: activity.contactId })
				.from(activity)
				.where(and(where, isNotNull(activity.contactId))),
			client
				.selectDistinct({ dealId: activity.dealId })
				.from(activity)
				.where(and(where, isNotNull(activity.dealId))),
		]);

		return {
			companyIds: present(companies.map((row) => row.companyId)),
			contactIds: present(contacts.map((row) => row.contactId)),
			dealIds: present(deals.map((row) => row.dealId)),
		};
	}

	async recomputeMany(targets: StampTargets): Promise<void> {
		const statements = [
			this.restamp("company", "companyId", targets.companyIds),
			this.restamp("contact", "contactId", targets.contactIds),
			this.restamp("deal", "dealId", targets.dealIds),
		].filter((statement) => statement !== null);

		if (statements.length === 0) return;

		await this.db.transaction(async (tx) => {
			for (const statement of statements) await tx.execute(statement);
		});
	}

	async recomputeAfterDelete(
		targets: StampTargets,
		deleted: ActivityTarget,
	): Promise<void> {
		try {
			await this.recomputeMany(targets);
		} catch (error) {
			this.logger.error(
				{
					message:
						"A record was deleted but its activity stamps were not recomputed",
					...deleted,
				},
				error instanceof Error ? error.stack : String(error),
			);
		}
	}

	private restamp(table: string, column: string, ids: string[]): SQL | null {
		if (ids.length === 0) return null;

		const record = sql.identifier(table);
		const key = sql.identifier(column);

		return sql`
			UPDATE ${record} r
			SET "lastActivityAt" = (
				SELECT MAX(a."createdAt") FROM "activity" a WHERE a.${key} = r.id
			)
			WHERE r.id IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `,
			)})`;
	}

	async recomputeAll(): Promise<void> {
		const statements = [
			sql`
				UPDATE "company" c
				SET "lastActivityAt" = a.max
				FROM (
					SELECT "companyId" AS id, MAX("createdAt") AS max
					FROM "activity" WHERE "companyId" IS NOT NULL GROUP BY "companyId"
				) a
				WHERE c.id = a.id AND c."lastActivityAt" IS DISTINCT FROM a.max`,
			sql`
				UPDATE "company" SET "lastActivityAt" = NULL
				WHERE "lastActivityAt" IS NOT NULL
				AND id NOT IN (SELECT "companyId" FROM "activity" WHERE "companyId" IS NOT NULL)`,
			sql`
				UPDATE "contact" c
				SET "lastActivityAt" = a.max
				FROM (
					SELECT "contactId" AS id, MAX("createdAt") AS max
					FROM "activity" WHERE "contactId" IS NOT NULL GROUP BY "contactId"
				) a
				WHERE c.id = a.id AND c."lastActivityAt" IS DISTINCT FROM a.max`,
			sql`
				UPDATE "contact" SET "lastActivityAt" = NULL
				WHERE "lastActivityAt" IS NOT NULL
				AND id NOT IN (SELECT "contactId" FROM "activity" WHERE "contactId" IS NOT NULL)`,
			sql`
				UPDATE "deal" d
				SET "lastActivityAt" = a.max
				FROM (
					SELECT "dealId" AS id, MAX("createdAt") AS max
					FROM "activity" WHERE "dealId" IS NOT NULL GROUP BY "dealId"
				) a
				WHERE d.id = a.id AND d."lastActivityAt" IS DISTINCT FROM a.max`,
			sql`
				UPDATE "deal" SET "lastActivityAt" = NULL
				WHERE "lastActivityAt" IS NOT NULL
				AND id NOT IN (SELECT "dealId" FROM "activity" WHERE "dealId" IS NOT NULL)`,
		];

		await this.db.transaction(async (tx) => {
			for (const statement of statements) await tx.execute(statement);
		});
	}
}
