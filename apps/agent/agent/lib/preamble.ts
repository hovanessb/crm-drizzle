import {
	asc,
	calendarEvent,
	company as companyTable,
	contactBrief,
	contact as contactTable,
	db,
	dealContact,
	deal as dealTable,
	desc,
	emailThread,
	eq,
	firstRow,
	orNull,
	relatedCount,
	whereEq,
} from "@crm/db";
import { websiteUrl } from "@crm/db/workspace";
import { capabilitiesMarkdown } from "./capabilities";
import { identity, usMarkdown, type WorkspaceIdentity } from "./workspace";

export type Opened = {
	dispatched: boolean;
	kind?: string | null;
	reason?: string | null;
	budget?: number | null;
	/** Set only for a `field-backfill` task — the custom field key(s) still blank on this record. */
	fieldKeys?: string[] | null;
};

export type Preamble = {
	markdown: string;
	focus: { contactId?: string | null; companyId?: string | null };
};

export async function sessionPreamble(
	record: {
		contactId?: string | null;
		companyId?: string | null;
		dealId?: string | null;
	},
	opened: Opened,
): Promise<Preamble> {
	if (opened.kind === "workspace-profile") return workspacePreamble();
	if (record.contactId) return contactPreamble(record.contactId, opened);
	if (record.companyId) return companyPreamble(record.companyId, opened);
	if (record.dealId) return dealPreamble(record.dealId, opened);
	return noRecordPreamble();
}

export async function composeClosing(
	us: WorkspaceIdentity | null,
): Promise<string> {
	return [usMarkdown(us), await capabilitiesMarkdown()]
		.filter(Boolean)
		.join("\n\n");
}

async function closing(): Promise<string> {
	return composeClosing(await identity());
}

function fieldBackfillLine(opened: Opened): string {
	if (!opened.fieldKeys || opened.fieldKeys.length === 0) return "";

	return [
		`**This is a field-backfill task.** This record is missing a value for`,
		`the custom field key(s) ${opened.fieldKeys.map((key) => `\`${key}\``).join(", ")}.`,
		"Call `list_fields` for this record's entity type to read each field's",
		"label, options and brief (what counts as an answer), then call",
		"`set_field_value` with this record's id for any you find real evidence",
		"for. Leave one blank rather than guess.",
	].join(" ");
}

function opening(opened: Opened, questions: string): string {
	if (opened.dispatched) {
		return [
			"This session was started by the dispatcher, not by a person. Nobody is",
			"waiting on a reply — do the work, record what you find, and stop.",
		].join(" ");
	}

	return [
		"**A rep has this record open and is talking to you.** Answer what they",
		`actually asked — usually some form of ${questions} — from what the CRM`,
		"already holds, and say plainly when we do not know something. Research it",
		"further only if the answer needs it or they ask you to. Never ask them for",
		"an id, a name or an address you can look up yourself.",
	].join(" ");
}

export async function contactPreamble(
	contactId: string,
	opened: Opened,
): Promise<Preamble> {
	const found = await firstRow(
		db
			.select({
				firstName: contactTable.firstName,
				lastName: contactTable.lastName,
				email: contactTable.email,
				title: contactTable.title,
				company: {
					id: companyTable.id,
					name: companyTable.name,
					domain: companyTable.domain,
				},
				brief: { refreshedAt: contactBrief.refreshedAt },
				emailThreads: db.$count(
					emailThread,
					eq(emailThread.contactId, contactTable.id),
				),
				calendarEvents: db.$count(
					calendarEvent,
					eq(calendarEvent.contactId, contactTable.id),
				),
			})
			.from(contactTable)
			.leftJoin(companyTable, eq(companyTable.id, contactTable.companyId))
			.leftJoin(contactBrief, eq(contactBrief.contactId, contactTable.id))
			.where(eq(contactTable.id, contactId))
			.limit(1),
	);
	const contact = found
		? {
				...found,
				deals: await db
					.select({
						role: dealContact.role,
						deal: {
							id: dealTable.id,
							name: dealTable.name,
							stage: dealTable.stage,
						},
					})
					.from(dealContact)
					.innerJoin(dealTable, eq(dealTable.id, dealContact.dealId))
					.where(eq(dealContact.contactId, contactId))
					.orderBy(desc(dealTable.lastActivityAt))
					.limit(5),
			}
		: null;

	if (!contact) {
		return { markdown: await closing(), focus: { contactId } };
	}

	const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");

	const known =
		contact.emailThreads > 0 || contact.calendarEvents > 0
			? `We have ${contact.emailThreads} thread(s) and ${contact.calendarEvents} meeting(s) with them — read those first.`
			: "We have never corresponded with them, so there is nothing internal to go on.";

	const deals = contact.deals
		.map(
			({ role, deal }) =>
				`${deal.name} (${deal.stage}${role ? `, ${role}` : ""}) \`${deal.id}\``,
		)
		.join("; ");

	const markdown = [
		"## This session",
		"",
		`You are working on **${name}** (\`${contactId}\`)${
			contact.email ? `, ${contact.email}` : ""
		}${contact.title ? `, ${contact.title}` : ""}.`,
		opened.kind ? `Task: **${opened.kind}**.` : "",
		opened.reason ? `Why now: ${opened.reason}` : "",
		opened.budget
			? `Budget: **${opened.budget}** vendor calls. Spend them where they matter.`
			: "",
		fieldBackfillLine(opened),
		"",
		opening(
			opened,
			"who this person is, whether they are still there, or what to know before a call",
		),
		"",
		contact.company
			? `They work at **${contact.company.name}**${
					contact.company.domain ? ` (${contact.company.domain})` : ""
				}, company id \`${contact.company.id}\` — pass that straight to \`read_company_history\`, \`enrich_company\` or \`research_company\` when the question reaches past this one person.`
			: "They are not attached to a company. `search_crm` will find one by name or domain if the conversation needs it.",
		deals ? `They are on: ${deals}.` : "They are not on any deal.",
		"",
		known,
		contact.brief
			? `A background already exists, written ${contact.brief.refreshedAt.toDateString()}. Replace it only if you learn something it does not say.`
			: "There is no background on them yet.",
		"",
		"Start with `read_crm_history` on this contact id.",
		"",
		await closing(),
	]
		.filter(Boolean)
		.join("\n");

	return {
		markdown,
		focus: { contactId, companyId: contact.company?.id ?? null },
	};
}

export async function companyPreamble(
	companyId: string,
	opened: Opened,
): Promise<Preamble> {
	const company = await db.query.company
		.findFirst({
			where: eq(companyTable.id, companyId),
			columns: { name: true, domain: true, industry: true, description: true },
			extras: (row: { id: typeof companyTable.id }) => ({
				contactCount: relatedCount(
					contactTable,
					contactTable.companyId,
					row.id,
				).as("contactCount"),
			}),
			with: {
				contacts: {
					orderBy: [
						desc(contactTable.lastActivityAt),
						asc(contactTable.createdAt),
					],
					limit: 12,
					columns: { id: true, firstName: true, lastName: true, title: true },
				},
				deals: {
					orderBy: [desc(dealTable.lastActivityAt), desc(dealTable.createdAt)],
					limit: 8,
					columns: { id: true, name: true, stage: true },
				},
			},
		})
		.then(orNull);

	if (!company) {
		return { markdown: await closing(), focus: { companyId } };
	}

	const people = company.contacts
		.map((person) => {
			const name = [person.firstName, person.lastName]
				.filter(Boolean)
				.join(" ");
			return `- ${name}${person.title ? ` — ${person.title}` : ""} \`${person.id}\``;
		})
		.join("\n");

	const more =
		company.contactCount > company.contacts.length
			? `\n- …and ${company.contactCount - company.contacts.length} more; \`read_company_history\` lists them all.`
			: "";

	const deals = company.deals
		.map((deal) => `${deal.name} (${deal.stage}) \`${deal.id}\``)
		.join("; ");

	const markdown = [
		"## This session",
		"",
		`You are working on **${company.name}**${
			company.domain ? ` (${company.domain})` : ""
		}${company.industry ? `, ${company.industry}` : ""} — company id \`${companyId}\`.`,
		fieldBackfillLine(opened),
		"",
		opening(
			opened,
			"what this company does, who we know there, or what has changed recently",
		),
		"",
		people
			? `### Who we know there (${company.contactCount})\n\n${people}${more}\n\nThose are contact ids. Use them directly — with \`read_crm_history\`, \`identify_contact\` or \`record_fact\`. Never ask a rep which contact they mean without naming these first.`
			: "We have no contacts on file here yet.",
		"",
		deals ? `Deals: ${deals}.` : "There are no deals here.",
		company.description
			? "There is already a description on the record."
			: "There is no description on the record yet.",
		"",
		"Start with `read_company_history` on this company id — it returns the people, the deals, the correspondence and the notes in one free call.",
		"",
		await closing(),
	]
		.filter(Boolean)
		.join("\n");

	return { markdown, focus: { companyId } };
}

export async function dealPreamble(
	dealId: string,
	opened: Opened,
): Promise<Preamble> {
	const deal = await db.query.deal
		.findFirst({
			where: whereEq(dealTable.id, dealId),
			columns: {
				name: true,
				description: true,
				stage: true,
				amount: true,
				currency: true,
				expectedCloseDate: true,
				lastActivityAt: true,
			},
			with: {
				company: { columns: { id: true, name: true } },
				contacts: {
					columns: { role: true },
					with: {
						contact: {
							columns: {
								id: true,
								firstName: true,
								lastName: true,
								title: true,
							},
						},
					},
				},
			},
		})
		.then(orNull);

	if (!deal) return { markdown: await closing(), focus: {} };

	const people = deal.contacts
		.map(({ role, contact }) => {
			const name = [contact.firstName, contact.lastName]
				.filter(Boolean)
				.join(" ");
			return `${name}${contact.title ? ` (${contact.title})` : ""}${
				role ? ` — ${role}` : ""
			} \`${contact.id}\``;
		})
		.join("; ");

	const markdown = [
		"## This session",
		"",
		`You are working on the deal **${deal.name}**${
			deal.company ? ` at ${deal.company.name}` : ""
		} — deal id \`${dealId}\`${
			deal.company ? `, company id \`${deal.company.id}\`` : ""
		}.`,
		`Stage: **${deal.stage}**${
			deal.amount
				? `. Amount: ${deal.amount} ${deal.currency ?? ""}`.trim()
				: ""
		}${
			deal.expectedCloseDate
				? `. Expected close: ${deal.expectedCloseDate.toDateString()}`
				: ""
		}.`,
		deal.lastActivityAt
			? `Last touched ${deal.lastActivityAt.toDateString()}.`
			: "Nothing has happened on it yet.",
		...(deal.description
			? [`The rep's own description of it: "${deal.description}"`]
			: []),
		people ? `People on it: ${people}` : "Nobody is attached to it yet.",
		fieldBackfillLine(opened),
		"",
		opening(
			opened,
			"where this stands, who else should be involved, or what the risk is",
		),
		"",
		"Start with `read_deal_history` on this deal id. It returns the stage clock, every stage this deal has moved through, the last reply from their side and the next meeting — which is how you answer *where does this stand* rather than reciting the stage field back.",
		"",
		opened.fieldKeys && opened.fieldKeys.length > 0
			? "You can research the people and the company behind it with the usual tools too — most of what you learn about them is recorded against them, not the deal."
			: "You can research the people and the company behind it with the usual tools — a deal itself has no fields to enrich, so anything you learn is recorded against them.",
		"",
		await closing(),
	]
		.filter(Boolean)
		.join("\n");

	return { markdown, focus: { companyId: deal.company?.id ?? null } };
}

export async function noRecordPreamble(): Promise<Preamble> {
	return {
		markdown: [
			"## This session",
			"",
			"No record was named, so nothing is in focus yet.",
			"`list_outstanding_work` shows contacts with research outstanding, and",
			"`search_crm` finds any contact, company or deal by name, email address or",
			"domain. Look the record up rather than asking for an id.",
			"",
			await closing(),
		].join("\n"),
		focus: {},
	};
}

export async function workspacePreamble(
	known?: WorkspaceIdentity | null,
): Promise<Preamble> {
	const us = known === undefined ? await identity() : known;
	const site = websiteUrl(us?.website);

	if (!us || !site) {
		return {
			markdown: [
				"## This session",
				"",
				"You were asked to write the profile of the company you work for, and",
				"this install has no web address on record — nobody gave one, or what is",
				"stored is not one. There is nothing to read. Stop — do not guess at it",
				"from the email addresses in the CRM.",
			].join("\n"),
			focus: {},
		};
	}

	const markdown = [
		"## This session",
		"",
		`You are writing the profile of **the company you work for** — ${us.name} (${us.website}).`,
		us.profile
			? `One already exists, written ${us.profile.refreshedAt.toDateString()}. Replace it only if the site now says something different.`
			: "There is no profile of us yet.",
		"",
		`Read ${site} with \`web_fetch\` — the home page, and the pricing or product`,
		"page if there is one — and search the web only if the site does not say who",
		"the customer is. Then call `write_workspace_profile`.",
		"",
		"**Every other session opens with what you write here**, in front of the",
		"record a rep is asking about, so it has to be short and it has to be",
		"substance. The tool enforces that: 320 characters of narrative and one",
		"short line each for what we sell, who we sell to, and what we are picked",
		"over. Leave a line out rather than padding it. No marketing adjectives —",
		'"leading", "innovative" and "best-in-class" say nothing a rep can use.',
		"",
		"You are describing us to a colleague who has just joined, not writing our",
		"home page back to us.",
		"",
		await capabilitiesMarkdown(),
	].join("\n");

	return { markdown, focus: {} };
}
