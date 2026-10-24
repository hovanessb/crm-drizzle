import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	activity,
	agentEvent,
	agentTask,
	company as companyTable,
	contact as contactTable,
	db,
	deal as dealTable,
	endsWith,
	eq,
	inArray,
	or,
	type PgColumn,
	RecordSource,
	suppressedContact,
	user,
} from "@crm/db";
import { AgentQueueService } from "../src/agent/agent-queue.service";
import { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { CompaniesService } from "../src/companies/companies.service";
import { CompanyDirectoryService } from "../src/companies/company-directory.service";
import { FaviconService } from "../src/companies/favicon.service";
import { ContactsService } from "../src/contacts/contacts.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { EnrichmentLogService } from "../src/crm/enrichment-log.service";
import { ConversionService } from "../src/currency/conversion.service";
import { FieldsService } from "../src/fields/fields.service";
import { MailboxMatchService } from "../src/mailbox/mailbox-match.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { first, one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "record-delete-spec";
const domain = `delete-${suffix}.test`;
const doomedDomain = `doomed-${suffix}.test`;
const stampDomain = `stamped-${suffix}.test`;
const orphanDomain = `orphaned-${suffix}.test`;
const email = `gone@${domain}`;
const colleague = `stays@${domain}`;
const userId = `user-${suffix}`;

const stamp = new ActivityStampService(db);

const agent = {
	contactCreated: async () => true,
	companyCreated: async () => undefined,
	withCrmEvents: withDiscardedCrmEvents,
	companyRequested: async () => true,
} as unknown as AgentTriggerService;

const directory = new CompanyDirectoryService(agent);
const log = new EnrichmentLogService(db, stamp);
const queue = new AgentQueueService(db);
const conversion = new ConversionService(db);

const fields = new FieldsService(db, agent);
const contacts = new ContactsService(
	db,
	directory,
	agent,
	queue,
	stamp,
	fields,
);
const companies = new CompaniesService(
	db,
	agent,
	queue,
	{ backfill: async () => undefined } as unknown as FaviconService,
	stamp,
	conversion,
	fields,
);
const match = new MailboxMatchService(db, directory, agent, log);

async function matchContext() {
	const internal = await match.internalIdentity();
	return {
		ourAddresses: internal.addresses,
		ourDomains: internal.domains,
		suppressedDomains: await match.suppressedDomains(),
		suppressedEmails: await match.suppressedEmails(),
	};
}

const domains = [domain, doomedDomain, stampDomain, orphanDomain];
const ours = (email: PgColumn) =>
	or(...domains.map((host) => endsWith(email, `@${host}`)));

async function parked(subject: { contactId?: string; companyId?: string }) {
	return one(
		db
			.insert(agentTask)
			.values({
				...subject,
				kind: "identify",
				reason: `record-delete-spec (${suffix})`,
				dueAt: new Date(Date.now() + 60 * 60 * 1000),
			})
			.returning({ id: agentTask.id }),
	);
}

async function clean() {
	const [existingContacts, existingCompanies] = await Promise.all([
		db
			.select({ id: contactTable.id })
			.from(contactTable)
			.where(ours(contactTable.email)),
		db
			.select({ id: companyTable.id })
			.from(companyTable)
			.where(inArray(companyTable.domain, domains)),
	]);

	const contactIds = existingContacts.map((row) => row.id);
	const companyIds = existingCompanies.map((row) => row.id);

	await db
		.delete(agentTask)
		.where(
			or(
				eq(agentTask.reason, `record-delete-spec (${suffix})`),
				inArray(agentTask.contactId, contactIds),
				inArray(agentTask.companyId, companyIds),
			),
		);
	await db.delete(agentEvent).where(inArray(agentEvent.contactId, contactIds));
	await db.delete(contactTable).where(ours(contactTable.email));
	await db.delete(companyTable).where(inArray(companyTable.domain, domains));
	await db.delete(suppressedContact).where(ours(suppressedContact.email));
	await db.delete(user).where(eq(user.id, userId));
}

beforeAll(async () => {
	await clean();
	await one(
		db
			.insert(user)
			.values({ id: userId, name: "Test Rep", email: `${userId}@example.test` })
			.returning(),
	);
});

afterAll(clean);

describe("purging a contact", () => {
	let contactId: string;

	it("takes the record, its queued research and its transcript with it", async () => {
		const created = await contacts.create({
			firstName: "Gone",
			lastName: "Person",
			email,
			ownerId: userId,
		});
		contactId = created.id;

		await parked({ contactId });

		await one(
			db
				.insert(agentEvent)
				.values({
					id: `evt-${suffix}`,
					sessionId: `ses-${suffix}`,
					contactId,
					type: "session.started",
					data: {},
					emittedAt: new Date(),
				})
				.returning(),
		);

		expect(await contacts.purge(contactId)).toEqual({
			id: contactId,
			name: "Gone Person",
		});

		expect(
			await first(
				db
					.select()
					.from(contactTable)
					.where(eq(contactTable.id, contactId))
					.limit(1),
			),
		).toBeNull();
		expect(await db.$count(agentTask, eq(agentTask.contactId, contactId))).toBe(
			0,
		);
		expect(
			await db.$count(agentEvent, eq(agentEvent.contactId, contactId)),
		).toBe(0);
	});

	it("remembers the address so the sync cannot bring them back", async () => {
		const suppressed = await first(
			db
				.select()
				.from(suppressedContact)
				.where(eq(suppressedContact.email, email))
				.limit(1),
		);
		expect(suppressed).not.toBeNull();

		const result = await match.resolve(
			{
				participants: [{ email, name: "Gone Person" }],
				allowCreate: true,
				source: RecordSource.EMAIL,
				ownerId: userId,
			},
			await matchContext(),
		);

		expect(result.external).toEqual([]);
		expect(result.contactId).toBeNull();
		expect(
			await first(
				db
					.select()
					.from(contactTable)
					.where(eq(contactTable.email, email))
					.limit(1),
			),
		).toBeNull();
	});

	it("still files the colleagues who were not deleted", async () => {
		const result = await match.resolve(
			{
				participants: [
					{ email, name: "Gone Person" },
					{ email: colleague, name: "Stays Here" },
				],
				allowCreate: true,
				source: RecordSource.EMAIL,
				ownerId: userId,
			},
			await matchContext(),
		);

		expect(result.external.map((person) => person.email)).toEqual([colleague]);

		const created = await first(
			db
				.select()
				.from(contactTable)
				.where(eq(contactTable.email, colleague))
				.limit(1),
		);
		expect(created?.id).toBe(result.contactId ?? undefined);
	});

	it("lets a rep add them back by hand, which lifts the suppression", async () => {
		const readded = await contacts.create({ firstName: "Gone", email });

		expect(
			await first(
				db
					.select()
					.from(suppressedContact)
					.where(eq(suppressedContact.email, email))
					.limit(1),
			),
		).toBeNull();

		await one(
			db
				.delete(contactTable)
				.where(eq(contactTable.id, readded.id))
				.returning(),
		);
		await db
			.delete(suppressedContact)
			.where(eq(suppressedContact.email, email));
	});

	it("suppresses an address a rep typed in caps as the sync will see it", async () => {
		const typed = `Mixed.Case@${domain.toUpperCase()}`;
		const asSynced = typed.toLowerCase();

		const created = await contacts.create({ firstName: "Mixed", email: typed });

		expect(
			await first(
				db
					.select({ email: contactTable.email })
					.from(contactTable)
					.where(eq(contactTable.id, created.id))
					.limit(1),
			),
		).toEqual({ email: asSynced });

		await contacts.purge(created.id);

		expect(
			await first(
				db
					.select()
					.from(suppressedContact)
					.where(eq(suppressedContact.email, asSynced))
					.limit(1),
			),
		).not.toBeNull();

		const result = await match.resolve(
			{
				participants: [{ email: asSynced, name: "Mixed Case" }],
				allowCreate: true,
				source: RecordSource.EMAIL,
				ownerId: userId,
			},
			await matchContext(),
		);

		expect(result.external).toEqual([]);
		expect(
			await first(
				db
					.select()
					.from(contactTable)
					.where(eq(contactTable.email, asSynced))
					.limit(1),
			),
		).toBeNull();
	});
});

describe("purging a company", () => {
	it("takes its deals and leaves its people without a company", async () => {
		const company = await companies.create({
			name: "Doomed",
			domain: doomedDomain,
		});
		const contact = await contacts.create({
			firstName: "Left",
			lastName: "Behind",
			email: `left@${doomedDomain}`,
			companyId: company.id,
		});
		const deal = await one(
			db
				.insert(dealTable)
				.values({ name: "Doomed deal", companyId: company.id, ownerId: userId })
				.returning({ id: dealTable.id }),
		);

		await parked({ companyId: company.id });

		expect(await companies.purge(company.id)).toEqual({
			id: company.id,
			name: "Doomed",
		});

		expect(
			await first(
				db.select().from(dealTable).where(eq(dealTable.id, deal.id)).limit(1),
			),
		).toBeNull();
		expect(
			await db.$count(agentTask, eq(agentTask.companyId, company.id)),
		).toBe(0);

		const survivor = await first(
			db
				.select({ companyId: contactTable.companyId })
				.from(contactTable)
				.where(eq(contactTable.id, contact.id))
				.limit(1),
		);
		expect(survivor?.companyId).toBeNull();

		await one(
			db
				.delete(contactTable)
				.where(eq(contactTable.id, contact.id))
				.returning(),
		);
	});
});

describe("the activity stamps a purge leaves behind", () => {
	it("are recomputed on every record the deleted one's activities touched", async () => {
		const company = await companies.create({
			name: "Stamped",
			domain: stampDomain,
		});
		const contact = await contacts.create({
			firstName: "Stamped",
			email: `stamped@${stampDomain}`,
			companyId: company.id,
		});
		const deal = await one(
			db
				.insert(dealTable)
				.values({
					name: "Stamped deal",
					companyId: company.id,
					ownerId: userId,
				})
				.returning({ id: dealTable.id }),
		);

		const at = new Date();
		await one(
			db
				.insert(activity)
				.values({
					type: "NOTE",
					subject: "The only thing on this account",
					companyId: company.id,
					contactId: contact.id,
					dealId: deal.id,
					createdById: userId,
					createdAt: at,
				})
				.returning(),
		);
		await stamp.touch(
			{ companyId: company.id, contactId: contact.id, dealId: deal.id },
			at,
		);

		await contacts.purge(contact.id);

		expect(
			await first(
				db
					.select({ lastActivityAt: companyTable.lastActivityAt })
					.from(companyTable)
					.where(eq(companyTable.id, company.id))
					.limit(1),
			),
		).toEqual({ lastActivityAt: null });
		expect(
			await first(
				db
					.select({ lastActivityAt: dealTable.lastActivityAt })
					.from(dealTable)
					.where(eq(dealTable.id, deal.id))
					.limit(1),
			),
		).toEqual({ lastActivityAt: null });
	});

	it("follow a deleted company through the deals it takes with it", async () => {
		const company = await companies.create({
			name: "Orphaner",
			domain: orphanDomain,
		});
		const contact = await contacts.create({
			firstName: "Orphaned",
			email: `orphaned@${orphanDomain}`,
			companyId: company.id,
		});
		const deal = await one(
			db
				.insert(dealTable)
				.values({
					name: "Orphaned deal",
					companyId: company.id,
					ownerId: userId,
				})
				.returning({ id: dealTable.id }),
		);

		const at = new Date();
		await one(
			db
				.insert(activity)
				.values({
					type: "MEETING",
					subject: "Only ever attached to the deal",
					contactId: contact.id,
					dealId: deal.id,
					createdById: userId,
					createdAt: at,
				})
				.returning(),
		);
		await stamp.touch({ contactId: contact.id, dealId: deal.id }, at);

		await companies.purge(company.id);

		expect(
			await first(
				db
					.select({
						companyId: contactTable.companyId,
						lastActivityAt: contactTable.lastActivityAt,
					})
					.from(contactTable)
					.where(eq(contactTable.id, contact.id))
					.limit(1),
			),
		).toEqual({ companyId: null, lastActivityAt: null });

		await one(
			db
				.delete(contactTable)
				.where(eq(contactTable.id, contact.id))
				.returning(),
		);
	});
});
