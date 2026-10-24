import { type Db, lt, sql, trackingCounter } from "@crm/db";
import { windowExpiry } from "@crm/db/tracking";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

@Injectable()
export class TrackingCounterService {
	private readonly logger = new Logger(TrackingCounterService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async take(key: string, limit: number, amount = 1): Promise<boolean> {
		if (amount <= 0) return true;
		if (amount > limit) return false;

		try {
			const charged = await this.db.execute<{ value: number }>(sql`
				INSERT INTO "trackingCounter" ("key", "value", "expiresAt")
				VALUES (${key}, ${amount}, ${windowExpiry(key)})
				ON CONFLICT ("key") DO UPDATE
					SET "value" = "trackingCounter"."value" + ${amount}
					WHERE "trackingCounter"."value" + ${amount} <= ${limit}
				RETURNING "value";
			`);

			return charged.rows.length > 0;
		} catch (error) {
			this.logger.error(
				{ message: "Tracking counter could not be read — refusing the write" },
				error instanceof Error ? error.stack : String(error),
			);

			return false;
		}
	}

	async release(key: string, amount = 1): Promise<void> {
		try {
			await this.db.execute(sql`
				UPDATE "trackingCounter"
				SET "value" = GREATEST("value" - ${amount}, 0)
				WHERE "key" = ${key};
			`);
		} catch (error) {
			this.logger.error(
				{ message: "Tracking counter could not be released" },
				error instanceof Error ? error.stack : String(error),
			);
		}
	}

	async sweep(): Promise<number> {
		const removed = await this.db
			.delete(trackingCounter)
			.where(lt(trackingCounter.expiresAt, new Date()))
			.returning({ key: trackingCounter.key });

		return removed.length;
	}
}
