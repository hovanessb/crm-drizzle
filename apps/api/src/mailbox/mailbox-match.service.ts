import { workspaceDomains } from "@crm/auth/workspace";
import {
	company,
	contact as contactTable,
	type Db,
	eq,
	inArray,
	RecordSource,
	suppressedContact,
	suppressedDomain,
	user,
} from "@crm/db";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { CompanyDirectoryService } from "../companies/company-directory.service";
import { EnrichmentLogService } from "../crm/enrichment-log.service";
import { InjectDatabase } from "../database/database.constants";
import {
	dominantDomain,
	externalParticipants,
	isDerivedName,
	type Participant,
	splitName,
	workDomain,
} from "./participants";

type SyncRecordSource =
	| typeof RecordSource.EMAIL
	| typeof RecordSource.CALENDAR;

export type MatchResult = {
	companyId: string | null;
	contactId: string | null;
	external: Participant[];
};

export type MatchContext = {
	ourAddresses: ReadonlySet<string>;
	ourDomains: ReadonlySet<string>;
	suppressedDomains: ReadonlySet<string>;
	suppressedEmails: ReadonlySet<string>;
};

export type MatchRequest = {
	participants: readonly Participant[];
	allowCreate: boolean;
	source: SyncRecordSource;
	ownerId: string;
};

@Injectable()
export class MailboxMatchService {
	private readonly logger = new Logger(MailboxMatchService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly companies: CompanyDirectoryService,
		private readonly agent: AgentTriggerService,
		private readonly log: EnrichmentLogService,
	) {}

	async internalIdentity(): Promise<{
		addresses: Set<string>;
		domains: Set<string>;
	}> {
		const users = await this.db.select({ email: user.email }).from(user);

		const addresses = new Set<string>();
		const domains = new Set<string>(workspaceDomains());

		for (const user of users) {
			const email = user.email.toLowerCase();
			addresses.add(email);

			const domain = workDomain(email);
			if (domain) domains.add(domain);
		}

		return { addresses, domains };
	}

	async suppressedDomains(): Promise<Set<string>> {
		const rows = await this.db
			.select({ domain: suppressedDomain.domain })
			.from(suppressedDomain);
		return new Set(rows.map((row) => row.domain));
	}

	async suppressedEmails(): Promise<Set<string>> {
		const rows = await this.db
			.select({ email: suppressedContact.email })
			.from(suppressedContact);
		return new Set(rows.map((row) => row.email.toLowerCase()));
	}

	async resolve(
		request: MatchRequest,
		context: MatchContext,
	): Promise<MatchResult> {
		const external = externalParticipants(request.participants, {
			ourDomains: context.ourDomains,
			ourAddresses: context.ourAddresses,
			suppressedDomains: context.suppressedDomains,
			suppressedEmails: context.suppressedEmails,
		});

		if (external.length === 0) {
			return { companyId: null, contactId: null, external };
		}

		const [contact] = await this.db
			.select({ id: contactTable.id, companyId: contactTable.companyId })
			.from(contactTable)
			.where(
				inArray(
					contactTable.email,
					external.map((person) => person.email),
				),
			)
			.limit(1);

		if (contact) {
			return {
				companyId: contact.companyId,
				contactId: contact.id,
				external,
			};
		}

		const domains = [
			...new Set(
				external
					.map((person) => workDomain(person.email))
					.filter((domain): domain is string => domain !== null),
			),
		];

		const known =
			domains.length > 0
				? await this.db
						.select({ id: company.id, domain: company.domain })
						.from(company)
						.where(inArray(company.domain, domains))
				: [];

		const knownDomains = new Set(
			known
				.map((company) => company.domain)
				.filter((domain): domain is string => domain !== null),
		);

		const domain = dominantDomain(external, knownDomains);
		if (!domain) return { companyId: null, contactId: null, external };

		const existing = known.find((company) => company.domain === domain);
		if (existing) {
			return {
				companyId: existing.id,
				contactId: request.allowCreate
					? await this.createContact(external, domain, existing.id, request)
					: null,
				external,
			};
		}

		if (!request.allowCreate) {
			return { companyId: null, contactId: null, external };
		}

		return this.create(external, domain, request);
	}

	private async create(
		external: Participant[],
		domain: string,
		request: MatchRequest,
	): Promise<MatchResult> {
		const lead =
			external.find((person) => workDomain(person.email) === domain) ??
			external[0];

		if (!lead) return { companyId: null, contactId: null, external };

		const companyId = await this.companies.companyForEmail(lead.email, {
			ownerId: request.ownerId,
		});
		if (!companyId) {
			return { companyId: null, contactId: null, external };
		}

		await this.db
			.update(company)
			.set({ source: request.source })
			.where(eq(company.id, companyId));

		const contactId = await this.createContact(
			external,
			domain,
			companyId,
			request,
		);

		await this.log.record({
			companyId,
			subject: "Company added from your inbox",
			body:
				`Created because you ${request.source === "CALENDAR" ? "met" : "emailed"} ` +
				`someone at ${domain}.`,
			meta: { source: request.source, domain },
		});

		this.logger.log({
			message: "Company auto-created from mailbox sync",
			companyId,
			domain,
			source: request.source,
		});

		return { companyId, contactId, external };
	}

	private async createContact(
		external: Participant[],
		domain: string,
		companyId: string,
		request: MatchRequest,
	): Promise<string | null> {
		const person = external.find(
			(candidate) => workDomain(candidate.email) === domain,
		);
		if (!person) return null;

		const { firstName, lastName } = splitName(person.name, person.email);

		const outcome = await this.agent.withCrmEvents(async (tx, emit) => {
			await lockIdempotencyKey(tx, `mailbox-contact:${person.email}`);
			const fields = {
				id: contactTable.id,
				firstName: contactTable.firstName,
				lastName: contactTable.lastName,
				email: contactTable.email,
				companyId: contactTable.companyId,
				createdAt: contactTable.createdAt,
			};
			const [existing] = await tx
				.select(fields)
				.from(contactTable)
				.where(eq(contactTable.email, person.email))
				.limit(1);
			if (existing) return { contact: existing, created: false as const };

			const [contact] = await tx
				.insert(contactTable)
				.values({
					firstName,
					lastName,
					email: person.email,
					companyId,
					source: request.source,
					ownerId: request.ownerId,
				})
				.returning(fields);
			if (!contact) throw new Error("The contact insert returned no row.");
			await emit({
				type: "contact.created",
				record: { kind: "contact", id: contact.id },
				occurredAt: contact.createdAt,
				data: {
					firstName: contact.firstName,
					lastName: contact.lastName,
					email: contact.email,
					companyId: contact.companyId,
					source: request.source,
				},
			});
			return { contact, created: true as const };
		});
		const { contact } = outcome;

		if (outcome.created) {
			await this.log.record({
				contactId: contact.id,
				companyId,
				subject: "Contact added from your inbox",
				body: `${person.email} appeared in a ${request.source === "CALENDAR" ? "meeting" : "thread"}.`,
				meta: { source: request.source },
			});
		}

		const hasRealName = Boolean(person.name?.trim());
		const isPlaceholder = isDerivedName(
			person.email,
			contact.firstName,
			contact.lastName,
		);

		if (hasRealName && isPlaceholder) {
			await this.db
				.update(contactTable)
				.set({ firstName, lastName })
				.where(eq(contactTable.id, contact.id));
			return contact.id;
		}

		if (isPlaceholder && !hasRealName) {
			await this.agent.contactCreated(
				contact.id,
				"Created by the sync from an address, with no name on it",
			);
		}

		return contact.id;
	}
}
