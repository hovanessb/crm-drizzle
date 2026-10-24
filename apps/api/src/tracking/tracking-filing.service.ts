import { workspaceDomains } from "@crm/auth/workspace";
import {
	ActivityType,
	activity as activityTable,
	and,
	contact as contactTable,
	type Db,
	eq,
	equalsInsensitive,
	formSubmission,
	isNull,
	isUniqueViolation,
	RecordSource,
	suppressedContact,
	suppressedDomain,
	trackedVisitor,
	user,
} from "@crm/db";
import type { Touch } from "@crm/db/attribution";
import {
	CONTACT_CAP_REASON,
	CONTACTS_PER_HOUR,
	contactWindowKey,
} from "@crm/db/tracking";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { CompanyDirectoryService } from "../companies/company-directory.service";
import { isMachineDomain } from "../companies/domain";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { normalizeEmail } from "../crm/values";
import { InjectDatabase } from "../database/database.constants";
import {
	isAutomatedAddress,
	isMachineAddress,
	splitName,
} from "../mailbox/participants";
import { TrackingCounterService } from "./tracking-counter.service";

type TouchColumns = Record<string, string | Date | null>;

function columns(
	touch: Touch | undefined,
	prefix: "first" | "last",
): TouchColumns {
	if (!touch) return {};

	return {
		[`${prefix}Source`]: touch.source,
		[`${prefix}Medium`]: touch.medium,
		[`${prefix}Campaign`]: touch.campaign,
		[`${prefix}Term`]: touch.term,
		[`${prefix}Content`]: touch.content,
		[`${prefix}Referrer`]: touch.referrer,
		[`${prefix}Landing`]: touch.landing,
		[`${prefix}TouchAt`]: touch.at,
	};
}

export type FilingOutcome =
	| { filed: true; contactId: string }
	| { filed: false; reason: string };

@Injectable()
export class TrackingFilingService {
	private readonly logger = new Logger(TrackingFilingService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly counters: TrackingCounterService,
		private readonly companies: CompanyDirectoryService,
		private readonly agent: AgentTriggerService,
		private readonly stamp: ActivityStampService,
	) {}

	async file(submission: {
		id: string;
		email: string | null;
		host: string;
		visitorId: string | null;
		name: string | null;
		firstTouch?: Touch;
		lastTouch?: Touch;
	}): Promise<FilingOutcome> {
		const email = normalizeEmail(submission.email ?? "");
		if (!email) return this.skip(submission.id, "No email address");

		if (isMachineAddress(email) || isAutomatedAddress(email)) {
			return this.skip(submission.id, "Not an address a human reads");
		}

		const domain = email.split("@")[1] ?? null;
		if (!domain) return this.skip(submission.id, "No usable domain");

		if (isMachineDomain(domain)) {
			return this.skip(submission.id, "Not a domain a human reads");
		}

		if (workspaceDomains().includes(domain)) {
			return this.skip(submission.id, "One of our own addresses");
		}

		const suppressed = await this.suppressed(email, domain);
		if (suppressed) return this.skip(submission.id, suppressed);

		const existing = await this.activeContact(email);

		if (existing) {
			await this.attach(submission.id, existing.id, submission);
			return { filed: true, contactId: existing.id };
		}

		const window = contactWindowKey();

		if (!(await this.counters.take(window, CONTACTS_PER_HOUR))) {
			return this.skip(submission.id, CONTACT_CAP_REASON);
		}

		const companyId = await this.companies.companyForEmail(email);
		const { firstName, lastName } = splitName(submission.name, email);

		let contact: { id: string };
		try {
			const [inserted] = await this.db
				.insert(contactTable)
				.values({
					firstName,
					lastName,
					email,
					companyId,
					source: RecordSource.TRACKING,
					lastActivityAt: new Date(),
				})
				.returning({ id: contactTable.id });
			if (!inserted) throw new Error("The contact insert returned no row.");
			contact = inserted;
		} catch (error) {
			await this.counters.release(window);

			const raced = await this.raced(error, email);
			if (!raced) throw error;

			await this.attach(submission.id, raced.id, submission);

			return { filed: true, contactId: raced.id };
		}

		await this.attach(submission.id, contact.id, submission);

		await this.agent.contactCreated(
			contact.id,
			`Submitted a form on ${submission.host}`,
		);

		this.logger.log({
			message: "Contact filed from a form submission",
			contactId: contact.id,
			host: submission.host,
		});

		return { filed: true, contactId: contact.id };
	}

	private async raced(
		cause: unknown,
		email: string,
	): Promise<{ id: string } | null> {
		if (!isUniqueViolation(cause)) return null;

		return this.activeContact(email);
	}

	private async activeContact(email: string): Promise<{ id: string } | null> {
		const [row] = await this.db
			.select({ id: contactTable.id })
			.from(contactTable)
			.where(
				and(eq(contactTable.email, email), isNull(contactTable.archivedAt)),
			)
			.limit(1);
		return row ?? null;
	}

	private async attach(
		submissionId: string,
		contactId: string,
		context: {
			visitorId: string | null;
			firstTouch?: Touch;
			lastTouch?: Touch;
		},
	): Promise<void> {
		const { visitorId } = context;
		const [submission] = await this.db
			.update(formSubmission)
			.set({ contactId, filedAt: new Date(), skipReason: null })
			.where(
				and(
					eq(formSubmission.id, submissionId),
					isNull(formSubmission.filedAt),
				),
			)
			.returning({ host: formSubmission.host, path: formSubmission.path });

		if (!submission) return;

		const author = await this.author(contactId);

		if (author) {
			const [activity] = await this.db
				.insert(activityTable)
				.values({
					type: ActivityType.NOTE,
					subject: `Submitted a form on ${submission.host}`,
					body: `${submission.host}${submission.path}`,
					contactId,
					occurredAt: new Date(),
					createdById: author,
					meta: { automated: true, source: "tracking" },
				})
				.returning({ createdAt: activityTable.createdAt });

			if (activity) await this.stamp.touch({ contactId }, activity.createdAt);
		}

		if (!visitorId) return;

		const first = columns(context.firstTouch, "first");
		const last = columns(context.lastTouch, "last");

		await this.db
			.insert(trackedVisitor)
			.values({ id: visitorId, contactId, ...first, ...last })
			.onConflictDoUpdate({
				target: trackedVisitor.id,
				set: { contactId, ...last },
			});
	}

	private async author(contactId: string): Promise<string | null> {
		const [contact] = await this.db
			.select({ ownerId: contactTable.ownerId })
			.from(contactTable)
			.where(eq(contactTable.id, contactId))
			.limit(1);

		if (contact?.ownerId) return contact.ownerId;

		const [anyUser] = await this.db.select({ id: user.id }).from(user).limit(1);

		return anyUser?.id ?? null;
	}

	private async skip(
		submissionId: string,
		reason: string,
	): Promise<FilingOutcome> {
		await this.db
			.update(formSubmission)
			.set({ skipReason: reason })
			.where(eq(formSubmission.id, submissionId));

		return { filed: false, reason };
	}

	private async suppressed(
		email: string,
		domain: string,
	): Promise<string | null> {
		const [contact, host] = await Promise.all([
			this.db
				.select({ email: suppressedContact.email })
				.from(suppressedContact)
				.where(equalsInsensitive(suppressedContact.email, email))
				.limit(1)
				.then((rows) => rows[0]),
			this.db
				.select({ domain: suppressedDomain.domain })
				.from(suppressedDomain)
				.where(eq(suppressedDomain.domain, domain))
				.limit(1)
				.then((rows) => rows[0]),
		]);

		if (contact) return "This address was deleted by a rep";
		if (host) return "This domain is suppressed";

		return null;
	}
}
