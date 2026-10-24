import {
	activity as activityTable,
	and,
	asc,
	calendarAttendee,
	calendarEvent,
	company,
	contactBrief,
	contact as contactTable,
	db,
	deal,
	dealContact,
	desc,
	EnrichmentStatus,
	emailMessage,
	emailThread,
	eq,
	firstRow,
	inArray,
	isNotNull,
	isNull,
	type JsonObject,
	ne,
	or,
	orNull,
	requireRow,
	user,
	whereEq,
} from "@crm/db";
import { domainOf, isDerivedName } from "./names";
import type { Person } from "./socials";

export type WorkItem = {
	id: string;
	fullName: string;
	email: string | null;
	title: string | null;
	companyName: string | null;
	companyDomain: string | null;
	linkedinUrl: string | null;
	needs: {
		identity: boolean;
		brief: boolean;
		socials: boolean;
	};
};

export async function contactsNeedingWork(limit: number): Promise<WorkItem[]> {
	const rows = await db
		.select({
			id: contactTable.id,
			email: contactTable.email,
			firstName: contactTable.firstName,
			lastName: contactTable.lastName,
			title: contactTable.title,
			linkedinUrl: contactTable.linkedinUrl,
			socialsCheckedAt: contactTable.socialsCheckedAt,
			company: { name: company.name, domain: company.domain },
			brief: { contactId: contactBrief.contactId },
		})
		.from(contactTable)
		.leftJoin(company, eq(company.id, contactTable.companyId))
		.leftJoin(contactBrief, eq(contactBrief.contactId, contactTable.id))
		.where(
			or(
				isNull(contactBrief.contactId),
				isNull(contactTable.socialsCheckedAt),
				and(isNotNull(contactTable.email), isNull(contactTable.lastName)),
			),
		)
		.orderBy(asc(contactTable.createdAt))
		.limit(limit);

	return rows.map((row) => ({
		id: row.id,
		fullName: [row.firstName, row.lastName].filter(Boolean).join(" "),
		email: row.email,
		title: row.title,
		companyName: row.company?.name ?? null,
		companyDomain:
			row.company?.domain ?? (row.email ? domainOf(row.email) : null),
		linkedinUrl: row.linkedinUrl,
		needs: {
			identity: isDerivedName(row.email, row.firstName, row.lastName),
			brief: row.brief === null,
			socials: row.socialsCheckedAt === null,
		},
	}));
}

export async function personForVerification(
	contactId: string,
): Promise<Person | null> {
	const contact = await db.query.contact
		.findFirst({
			where: whereEq(contactTable.id, contactId),
			columns: { firstName: true, lastName: true, title: true, email: true },
			with: { company: { columns: { name: true, domain: true } } },
		})
		.then(orNull);

	if (!contact) return null;

	return {
		firstName: contact.firstName,
		lastName: contact.lastName,
		fullName: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
		title: contact.title,
		companyName: contact.company?.name ?? null,
		companyDomain:
			contact.company?.domain ??
			(contact.email ? domainOf(contact.email) : null),
	};
}

export async function contactProfileSlug(
	contactId: string,
): Promise<{ slug: string; profileUrl: string } | null> {
	const contact = await firstRow(
		db
			.select({ linkedinUrl: contactTable.linkedinUrl })
			.from(contactTable)
			.where(whereEq(contactTable.id, contactId))
			.limit(1),
	);

	const slug = linkedinSlug(contact?.linkedinUrl ?? null);
	return slug
		? { slug, profileUrl: `https://www.linkedin.com/in/${slug}` }
		: null;
}

export function linkedinSlug(url: string | null): string | null {
	if (!url) return null;
	const match = /linkedin\.com\/in\/([A-Za-z0-9\-_%]+)/.exec(url);
	return match?.[1] ?? null;
}

export type CrmHistory = {
	contact: {
		fullName: string;
		email: string | null;
		title: string | null;
		companyName: string | null;
		company: {
			id: string;
			name: string;
			domain: string | null;
			industry: string | null;
		} | null;
	};
	deals: {
		id: string;
		name: string;
		stage: string;
		role: string | null;
		amount: number | null;
		currency: string;
		expectedCloseDate: string | null;
	}[];
	threads: {
		subject: string | null;
		messageCount: number;
		lastMessageAt: string;
		messages: {
			direction: string;
			from: string;
			fromName: string | null;
			sentAt: string;
			body: string | null;
		}[];
	}[];
	meetings: {
		title: string | null;
		startsAt: string;
		attended: boolean;
		attendees: { email: string; name: string | null }[];
	}[];
	stats: {
		emails: number;
		theyReplied: boolean;
		lastReplyAt: string | null;
		meetings: number;
		nextMeetingAt: string | null;
	};
	colleagues: { id: string; name: string; title: string | null }[];
};

export async function readCrmHistory(
	contactId: string,
	options: {
		threads?: number;
		messagesPerThread?: number;
		includeEmail?: boolean;
		includeCalendar?: boolean;
	} = {},
): Promise<CrmHistory | null> {
	const found = await firstRow(
		db
			.select({
				id: contactTable.id,
				firstName: contactTable.firstName,
				lastName: contactTable.lastName,
				email: contactTable.email,
				title: contactTable.title,
				companyId: contactTable.companyId,
				company: {
					id: company.id,
					name: company.name,
					domain: company.domain,
					industry: company.industry,
				},
			})
			.from(contactTable)
			.leftJoin(company, eq(company.id, contactTable.companyId))
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
							id: deal.id,
							name: deal.name,
							stage: deal.stage,
							amount: deal.amount,
							currency: deal.currency,
							expectedCloseDate: deal.expectedCloseDate,
						},
					})
					.from(dealContact)
					.innerJoin(deal, eq(deal.id, dealContact.dealId))
					.where(eq(dealContact.contactId, contactId))
					.orderBy(desc(deal.lastActivityAt)),
			}
		: null;

	if (!contact) return null;
	const includeEmail = options.includeEmail ?? true;
	const includeCalendar = options.includeCalendar ?? true;

	const [threads, meetings, colleagues] = await Promise.all([
		includeEmail
			? db.query.emailThread.findMany({
					where: whereEq(emailThread.contactId, contactId),
					orderBy: [desc(emailThread.lastMessageAt)],
					limit: options.threads ?? 5,
					columns: { subject: true, messageCount: true, lastMessageAt: true },
					with: {
						messages: {
							orderBy: [desc(emailMessage.sentAt)],
							limit: options.messagesPerThread ?? 6,
							columns: {
								direction: true,
								fromEmail: true,
								fromName: true,
								sentAt: true,
								body: true,
								snippet: true,
							},
						},
					},
				})
			: Promise.resolve([]),
		includeCalendar
			? db.query.calendarEvent.findMany({
					where: or(
						whereEq(calendarEvent.contactId, contactId),
						inArray(
							calendarEvent.id,
							db
								.select({ id: calendarAttendee.eventId })
								.from(calendarAttendee)
								.where(whereEq(calendarAttendee.contactId, contactId)),
						),
					),
					orderBy: [desc(calendarEvent.startsAt)],
					limit: 10,
					columns: { title: true, startsAt: true },
					with: {
						attendees: {
							columns: {
								email: true,
								name: true,
								contactId: true,
								responseStatus: true,
							},
						},
					},
				})
			: Promise.resolve([]),
		contact.companyId
			? db
					.select({
						id: contactTable.id,
						firstName: contactTable.firstName,
						lastName: contactTable.lastName,
						title: contactTable.title,
					})
					.from(contactTable)
					.where(
						and(
							eq(contactTable.companyId, contact.companyId),
							ne(contactTable.id, contactId),
						),
					)
					.orderBy(desc(contactTable.lastActivityAt))
					.limit(8)
			: Promise.resolve([]),
	]);

	const inbound = threads
		.flatMap((thread) => thread.messages)
		.filter((message) => message.direction === "INBOUND")
		.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());

	const now = new Date();
	const upcoming = meetings
		.filter((meeting) => meeting.startsAt > now)
		.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

	return {
		contact: {
			fullName: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
			email: contact.email,
			title: contact.title,
			companyName: contact.company?.name ?? null,
			company: contact.company,
		},
		deals: contact.deals.map(({ role, deal }) => ({
			id: deal.id,
			name: deal.name,
			stage: deal.stage,
			role,
			amount: deal.amount === null ? null : Number(deal.amount),
			currency: deal.currency,
			expectedCloseDate: deal.expectedCloseDate?.toISOString() ?? null,
		})),
		threads: threads.map((thread) => ({
			subject: thread.subject,
			messageCount: thread.messageCount,
			lastMessageAt: thread.lastMessageAt.toISOString(),
			messages: thread.messages.map((message) => ({
				direction: message.direction,
				from: message.fromEmail,
				fromName: message.fromName,
				sentAt: message.sentAt.toISOString(),
				body: message.body ?? message.snippet,
			})),
		})),
		meetings: meetings.map((meeting) => ({
			title: meeting.title,
			startsAt: meeting.startsAt.toISOString(),
			attended: meeting.attendees.some(
				(attendee) =>
					attendee.contactId === contactId &&
					attendee.responseStatus === "accepted",
			),
			attendees: meeting.attendees.map((attendee) => ({
				email: attendee.email,
				name: attendee.name,
			})),
		})),
		stats: {
			emails: threads.reduce((total, thread) => total + thread.messageCount, 0),
			theyReplied: inbound.length > 0,
			lastReplyAt: inbound[0]?.sentAt.toISOString() ?? null,
			meetings: meetings.length,
			nextMeetingAt: upcoming[0]?.startsAt.toISOString() ?? null,
		},
		colleagues: colleagues.map((colleague) => ({
			id: colleague.id,
			name: [colleague.firstName, colleague.lastName].filter(Boolean).join(" "),
			title: colleague.title,
		})),
	};
}

export async function stampSocialsChecked(contactId: string): Promise<void> {
	await requireRow(
		db
			.update(contactTable)
			.set({ socialsCheckedAt: new Date() })
			.where(whereEq(contactTable.id, contactId))
			.returning(),
	);
}

export async function setEnrichmentStatus(
	contactId: string,
	status: EnrichmentStatus,
	error?: string,
): Promise<void> {
	await requireRow(
		db
			.update(contactTable)
			.set({
				enrichmentStatus: status,
				enrichmentError: error ?? null,
				enrichedAt:
					status === EnrichmentStatus.COMPLETE ? new Date() : undefined,
			})
			.where(whereEq(contactTable.id, contactId))
			.returning(),
	);
}

export async function writeTimelineNote(
	contactId: string,
	subject: string,
	body: string,
	meta: JsonObject = {},
): Promise<string | null> {
	const contact = await firstRow(
		db
			.select({
				companyId: contactTable.companyId,
				ownerId: contactTable.ownerId,
			})
			.from(contactTable)
			.where(whereEq(contactTable.id, contactId))
			.limit(1),
	);
	if (!contact) return null;

	const author =
		contact.ownerId ??
		(await firstRow(db.select({ id: user.id }).from(user).limit(1)))?.id ??
		null;
	if (!author) return null;

	const activity = await requireRow(
		db
			.insert(activityTable)
			.values({
				type: "NOTE",
				subject,
				body,
				occurredAt: new Date(),
				contactId,
				companyId: contact.companyId,
				createdById: author,
				meta: { ...meta, agent: "people-research" },
			})
			.returning({ id: activityTable.id }),
	);

	return activity.id;
}
