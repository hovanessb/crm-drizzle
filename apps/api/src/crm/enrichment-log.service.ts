import {
	ActivityType,
	activity as activityTable,
	company,
	contact,
	type Db,
	eq,
	user,
} from "@crm/db";
import type { ActivityMetaFields } from "@crm/validation/activity-meta";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { ActivityStampService } from "./activity-stamp.service";

export type EnrichmentEvent = {
	companyId?: string | null;
	contactId?: string | null;
	subject: string;
	body?: string | null;
	meta?: ActivityMetaFields;
};

@Injectable()
export class EnrichmentLogService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly stamp: ActivityStampService,
	) {}

	async record(event: EnrichmentEvent): Promise<string | null> {
		const author = await this.authorFor(event);
		if (!author) return null;

		const [activity] = await this.db
			.insert(activityTable)
			.values({
				type: ActivityType.ENRICHMENT,
				subject: event.subject,
				body: event.body ?? null,
				occurredAt: new Date(),
				companyId: event.companyId ?? null,
				contactId: event.contactId ?? null,
				createdById: author,
				meta: { ...event.meta, automated: true },
			})
			.returning({ id: activityTable.id, createdAt: activityTable.createdAt });
		if (!activity) return null;

		await this.stamp.touch(
			{ companyId: event.companyId, contactId: event.contactId },
			activity.createdAt,
		);

		return activity.id;
	}

	private async authorFor(event: EnrichmentEvent): Promise<string | null> {
		if (event.contactId) {
			const [person] = await this.db
				.select({ ownerId: contact.ownerId })
				.from(contact)
				.where(eq(contact.id, event.contactId))
				.limit(1);
			if (person?.ownerId) return person.ownerId;
		}

		if (event.companyId) {
			const [owner] = await this.db
				.select({ ownerId: company.ownerId })
				.from(company)
				.where(eq(company.id, event.companyId))
				.limit(1);
			if (owner?.ownerId) return owner.ownerId;
		}

		const [anyUser] = await this.db.select({ id: user.id }).from(user).limit(1);
		return anyUser?.id ?? null;
	}
}
