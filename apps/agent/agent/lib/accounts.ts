import {
	ActivityType,
	activity,
	and,
	asc,
	calendarAttendee,
	calendarEvent,
	company as companyTable,
	contact,
	db,
	deal as dealTable,
	desc,
	EmailDirection,
	emailMessage,
	emailThread,
	eq,
	firstRow,
	inArray,
	or,
	orNull,
	sql,
	whereEq,
} from "@crm/db";
import { z } from "zod";
import { isDerivedName } from "./names";

const BODY_LIMIT = 4000;

const stageChangeMeta = z
	.object({
		from: z.string().nullable().catch(null),
		to: z.string().nullable().catch(null),
	})
	.catch({ from: null, to: null });

export type AccountThread = {
	subject: string | null;
	contact: { id: string; name: string } | null;
	messageCount: number;
	lastMessageAt: string;
	messages: {
		direction: string;
		from: string;
		fromName: string | null;
		sentAt: string;
		body: string | null;
	}[];
};

export type AccountMeeting = {
	title: string | null;
	startsAt: string;
	upcoming: boolean;
	attendees: { email: string; name: string | null }[];
};

export type AccountNote = {
	type: string;
	subject: string | null;
	body: string | null;
	occurredAt: string;
};

export type CompanyPerson = {
	id: string;
	name: string;
	title: string | null;
	email: string | null;
	linkedinUrl: string | null;
	lastActivityAt: string | null;
	threads: number;
	meetings: number;
	needsIdentity: boolean;
};

export type CompanyDeal = {
	id: string;
	name: string;
	stage: string;
	open: boolean;
	amount: number | null;
	currency: string;
	expectedCloseDate: string | null;
	lastActivityAt: string | null;
	contacts: { id: string; name: string; role: string | null }[];
};

export type CompanyHistory = {
	company: {
		id: string;
		name: string;
		domain: string | null;
		website: string | null;
		industry: string | null;
		location: string | null;
		description: string | null;
		linkedinUrl: string | null;
		enrichmentStatus: string;
	};
	people: CompanyPerson[];
	deals: CompanyDeal[];
	threads: AccountThread[];
	meetings: AccountMeeting[];
	notes: AccountNote[];
	stats: {
		people: number;
		openDeals: number;
		emails: number;
		meetings: number;
		theyReplied: boolean;
		lastReplyAt: string | null;
		lastReplyFrom: string | null;
		nextMeetingAt: string | null;
	};
};

export async function readCompanyHistory(
	companyId: string,
	options: {
		threads?: number;
		messagesPerThread?: number;
		people?: number;
		includeEmail?: boolean;
		includeCalendar?: boolean;
	} = {},
): Promise<CompanyHistory | null> {
	const company = await firstRow(
		db
			.select({
				id: companyTable.id,
				name: companyTable.name,
				domain: companyTable.domain,
				website: companyTable.website,
				industry: companyTable.industry,
				subIndustry: companyTable.subIndustry,
				city: companyTable.city,
				country: companyTable.country,
				description: companyTable.description,
				linkedinUrl: companyTable.linkedinUrl,
				enrichmentStatus: companyTable.enrichmentStatus,
			})
			.from(companyTable)
			.where(whereEq(companyTable.id, companyId))
			.limit(1),
	);

	if (!company) return null;
	const includeEmail = options.includeEmail ?? true;
	const includeCalendar = options.includeCalendar ?? true;

	const companyContacts = db
		.select({ id: contact.id })
		.from(contact)
		.where(eq(contact.companyId, companyId));
	const belongsToCompany = or(
		eq(emailThread.companyId, companyId),
		inArray(emailThread.contactId, companyContacts),
	);
	const companyThreads = db
		.select({ id: emailThread.id })
		.from(emailThread)
		.where(belongsToCompany);

	const [people, deals, threads, meetings, notes, lastInbound, counts] =
		await Promise.all([
			db
				.select({
					id: contact.id,
					firstName: contact.firstName,
					lastName: contact.lastName,
					title: contact.title,
					email: contact.email,
					linkedinUrl: contact.linkedinUrl,
					lastActivityAt: contact.lastActivityAt,
					threads: includeEmail
						? db.$count(emailThread, eq(emailThread.contactId, contact.id))
						: sql<number>`0`.mapWith(Number),
					meetings: includeCalendar
						? db.$count(calendarEvent, eq(calendarEvent.contactId, contact.id))
						: sql<number>`0`.mapWith(Number),
				})
				.from(contact)
				.where(eq(contact.companyId, companyId))
				.orderBy(
					sql`${contact.lastActivityAt} desc nulls first`,
					asc(contact.createdAt),
				)
				.limit(options.people ?? 25),
			db.query.deal.findMany({
				where: whereEq(dealTable.companyId, companyId),
				orderBy: [desc(dealTable.lastActivityAt), desc(dealTable.createdAt)],
				limit: 20,
				columns: {
					id: true,
					name: true,
					stage: true,
					amount: true,
					currency: true,
					expectedCloseDate: true,
					lastActivityAt: true,
				},
				with: {
					contacts: {
						columns: { role: true },
						with: {
							contact: {
								columns: { id: true, firstName: true, lastName: true },
							},
						},
					},
				},
			}),
			includeEmail
				? db.query.emailThread.findMany({
						where: belongsToCompany,
						orderBy: [desc(emailThread.lastMessageAt)],
						limit: options.threads ?? 5,
						columns: {
							subject: true,
							messageCount: true,
							lastMessageAt: true,
						},
						with: {
							contact: {
								columns: { id: true, firstName: true, lastName: true },
							},
							messages: {
								orderBy: [desc(emailMessage.sentAt)],
								limit: options.messagesPerThread ?? 4,
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
							eq(calendarEvent.companyId, companyId),
							inArray(calendarEvent.contactId, companyContacts),
							inArray(
								calendarEvent.id,
								db
									.select({ id: calendarAttendee.eventId })
									.from(calendarAttendee)
									.where(inArray(calendarAttendee.contactId, companyContacts)),
							),
						),
						orderBy: [desc(calendarEvent.startsAt)],
						limit: 10,
						columns: { title: true, startsAt: true },
						with: { attendees: { columns: { email: true, name: true } } },
					})
				: Promise.resolve([]),
			recentNotes({ companyId }),
			includeEmail
				? firstRow(
						db
							.select({
								sentAt: emailMessage.sentAt,
								fromEmail: emailMessage.fromEmail,
								fromName: emailMessage.fromName,
							})
							.from(emailMessage)
							.where(
								and(
									eq(emailMessage.direction, EmailDirection.INBOUND),
									inArray(emailMessage.threadId, companyThreads),
								),
							)
							.orderBy(desc(emailMessage.sentAt))
							.limit(1),
					)
				: Promise.resolve(null),
			Promise.all([
				db.$count(contact, whereEq(contact.companyId, companyId)),
				includeEmail
					? db.$count(
							emailMessage,
							inArray(emailMessage.threadId, companyThreads),
						)
					: Promise.resolve(0),
				includeCalendar
					? db.$count(
							calendarEvent,
							or(
								eq(calendarEvent.companyId, companyId),
								inArray(calendarEvent.contactId, companyContacts),
							),
						)
					: Promise.resolve(0),
			]),
		]);

	const [peopleCount, emailCount, meetingCount] = counts;
	const now = new Date();

	return {
		company: {
			id: company.id,
			name: company.name,
			domain: company.domain,
			website: company.website,
			industry: [company.industry, company.subIndustry]
				.filter(Boolean)
				.join(" / "),
			location: [company.city, company.country].filter(Boolean).join(", "),
			description: company.description,
			linkedinUrl: company.linkedinUrl,
			enrichmentStatus: company.enrichmentStatus,
		},
		people: people.map((person) => ({
			id: person.id,
			name: fullName(person),
			title: person.title,
			email: person.email,
			linkedinUrl: person.linkedinUrl,
			lastActivityAt: person.lastActivityAt?.toISOString() ?? null,
			threads: person.threads,
			meetings: person.meetings,
			needsIdentity: isDerivedName(
				person.email,
				person.firstName,
				person.lastName,
			),
		})),
		deals: deals.map(toCompanyDeal),
		threads: threads.map(toAccountThread),
		meetings: meetings.map((meeting) => toAccountMeeting(meeting, now)),
		notes,
		stats: {
			people: peopleCount,
			openDeals: deals.filter((deal) => isOpen(deal.stage)).length,
			emails: emailCount,
			meetings: meetingCount,
			theyReplied: lastInbound !== null,
			lastReplyAt: lastInbound?.sentAt.toISOString() ?? null,
			lastReplyFrom: lastInbound
				? (lastInbound.fromName ?? lastInbound.fromEmail)
				: null,
			nextMeetingAt:
				meetings
					.filter((meeting) => meeting.startsAt > now)
					.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0]
					?.startsAt.toISOString() ?? null,
		},
	};
}

export type DealHistory = {
	deal: {
		id: string;
		name: string;
		description: string | null;
		stage: string;
		open: boolean;
		daysInStage: number;
		stageChangedAt: string;
		amount: number | null;
		currency: string;
		expectedCloseDate: string | null;
		closedAt: string | null;
		closedReason: string | null;
		owner: string | null;
		createdAt: string;
	};
	company: { id: string; name: string; domain: string | null };
	people: {
		id: string;
		name: string;
		title: string | null;
		email: string | null;
		role: string | null;
	}[];
	stageHistory: { from: string | null; to: string | null; at: string }[];
	threads: AccountThread[];
	meetings: AccountMeeting[];
	notes: AccountNote[];
	stats: {
		theyReplied: boolean;
		lastReplyAt: string | null;
		lastReplyFrom: string | null;
		nextMeetingAt: string | null;
		daysSinceLastActivity: number | null;
	};
	note: string;
};

export async function readDealHistory(
	dealId: string,
	options: {
		threads?: number;
		messagesPerThread?: number;
		includeEmail?: boolean;
		includeCalendar?: boolean;
	} = {},
): Promise<DealHistory | null> {
	const deal = await db.query.deal
		.findFirst({
			where: whereEq(dealTable.id, dealId),
			columns: {
				id: true,
				name: true,
				description: true,
				stage: true,
				stageChangedAt: true,
				amount: true,
				currency: true,
				expectedCloseDate: true,
				closedAt: true,
				closedReason: true,
				lastActivityAt: true,
				createdAt: true,
			},
			with: {
				owner: { columns: { name: true, email: true } },
				company: { columns: { id: true, name: true, domain: true } },
				contacts: {
					columns: { role: true },
					with: {
						contact: {
							columns: {
								id: true,
								firstName: true,
								lastName: true,
								title: true,
								email: true,
							},
						},
					},
				},
			},
		})
		.then(orNull);

	if (!deal) return null;
	const includeEmail = options.includeEmail ?? true;
	const includeCalendar = options.includeCalendar ?? true;

	const contactIds = deal.contacts.map(({ contact }) => contact.id);

	const relatedThreads =
		contactIds.length > 0
			? or(
					inArray(emailThread.contactId, contactIds),
					eq(emailThread.companyId, deal.company.id),
				)
			: eq(emailThread.companyId, deal.company.id);

	const [stageChanges, threads, meetings, notes, lastInbound] =
		await Promise.all([
			db
				.select({ meta: activity.meta, createdAt: activity.createdAt })
				.from(activity)
				.where(
					and(
						whereEq(activity.dealId, dealId),
						eq(activity.type, ActivityType.STAGE_CHANGE),
					),
				)
				.orderBy(asc(activity.createdAt))
				.limit(25),
			includeEmail
				? db.query.emailThread.findMany({
						where: relatedThreads,
						orderBy: [desc(emailThread.lastMessageAt)],
						limit: options.threads ?? 5,
						columns: {
							subject: true,
							messageCount: true,
							lastMessageAt: true,
						},
						with: {
							contact: {
								columns: { id: true, firstName: true, lastName: true },
							},
							messages: {
								orderBy: [desc(emailMessage.sentAt)],
								limit: options.messagesPerThread ?? 4,
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
						where:
							contactIds.length > 0
								? or(
										inArray(calendarEvent.contactId, contactIds),
										inArray(
											calendarEvent.id,
											db
												.select({ id: calendarAttendee.eventId })
												.from(calendarAttendee)
												.where(inArray(calendarAttendee.contactId, contactIds)),
										),
										eq(calendarEvent.companyId, deal.company.id),
									)
								: eq(calendarEvent.companyId, deal.company.id),
						orderBy: [desc(calendarEvent.startsAt)],
						limit: 10,
						columns: { title: true, startsAt: true },
						with: { attendees: { columns: { email: true, name: true } } },
					})
				: Promise.resolve([]),
			recentNotes({ dealId }),
			includeEmail
				? firstRow(
						db
							.select({
								sentAt: emailMessage.sentAt,
								fromEmail: emailMessage.fromEmail,
								fromName: emailMessage.fromName,
							})
							.from(emailMessage)
							.where(
								and(
									eq(emailMessage.direction, EmailDirection.INBOUND),
									inArray(
										emailMessage.threadId,
										db
											.select({ id: emailThread.id })
											.from(emailThread)
											.where(relatedThreads),
									),
								),
							)
							.orderBy(desc(emailMessage.sentAt))
							.limit(1),
					)
				: Promise.resolve(null),
		]);

	const now = new Date();

	return {
		deal: {
			id: deal.id,
			name: deal.name,
			description: deal.description,
			stage: deal.stage,
			open: isOpen(deal.stage),
			daysInStage: daysSince(deal.stageChangedAt, now),
			stageChangedAt: deal.stageChangedAt.toISOString(),
			amount: deal.amount === null ? null : Number(deal.amount),
			currency: deal.currency,
			expectedCloseDate: deal.expectedCloseDate?.toISOString() ?? null,
			closedAt: deal.closedAt?.toISOString() ?? null,
			closedReason: deal.closedReason,
			owner: deal.owner?.name ?? deal.owner?.email ?? null,
			createdAt: deal.createdAt.toISOString(),
		},
		company: deal.company,
		people: deal.contacts.map(({ role, contact }) => ({
			id: contact.id,
			name: fullName(contact),
			title: contact.title,
			email: contact.email,
			role,
		})),
		stageHistory: stageChanges.map((change) => {
			const meta = stageChangeMeta.parse(change.meta);
			return {
				from: meta.from,
				to: meta.to,
				at: change.createdAt.toISOString(),
			};
		}),
		threads: threads.map(toAccountThread),
		meetings: meetings.map((meeting) => toAccountMeeting(meeting, now)),
		notes,
		stats: {
			theyReplied: lastInbound !== null,
			lastReplyAt: lastInbound?.sentAt.toISOString() ?? null,
			lastReplyFrom: lastInbound
				? (lastInbound.fromName ?? lastInbound.fromEmail)
				: null,
			nextMeetingAt:
				meetings
					.filter((meeting) => meeting.startsAt > now)
					.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0]
					?.startsAt.toISOString() ?? null,
			daysSinceLastActivity: deal.lastActivityAt
				? daysSince(deal.lastActivityAt, now)
				: null,
		},
		note:
			includeEmail || includeCalendar
				? contactIds.length > 0
					? "Connected account history is filed against people and companies, never against a deal. The history here belongs to the people on this deal and the rest of the account — read the details before treating any of it as being about this deal."
					: "Nobody is attached to this deal, so the correspondence here is the whole account's. Attaching the people on it would make this answer sharper."
				: "Connected email and calendar history are outside this agent version's approved data sources.",
	};
}

function isOpen(stage: string): boolean {
	return (
		stage !== "CLOSED_WON" &&
		stage !== "CLOSED_LOST" &&
		stage !== "UNQUALIFIED_TO_BUY"
	);
}

async function recentNotes(
	where: { companyId: string } | { dealId: string },
): Promise<AccountNote[]> {
	const rows = await db
		.select({
			type: activity.type,
			subject: activity.subject,
			body: activity.body,
			occurredAt: activity.occurredAt,
			createdAt: activity.createdAt,
		})
		.from(activity)
		.where(
			and(
				"companyId" in where
					? eq(activity.companyId, where.companyId)
					: eq(activity.dealId, where.dealId),
				inArray(activity.type, [
					ActivityType.NOTE,
					ActivityType.CALL,
					ActivityType.TASK,
					ActivityType.ENRICHMENT,
				]),
			),
		)
		.orderBy(desc(activity.createdAt))
		.limit(10);

	return rows.map((row) => ({
		type: row.type,
		subject: row.subject,
		body: row.body ? row.body.slice(0, BODY_LIMIT) : null,
		occurredAt: (row.occurredAt ?? row.createdAt).toISOString(),
	}));
}

function toAccountThread(thread: {
	subject: string | null;
	messageCount: number;
	lastMessageAt: Date;
	contact: { id: string; firstName: string; lastName: string | null } | null;
	messages: {
		direction: string;
		fromEmail: string;
		fromName: string | null;
		sentAt: Date;
		body: string | null;
		snippet: string | null;
	}[];
}): AccountThread {
	return {
		subject: thread.subject,
		contact: thread.contact
			? { id: thread.contact.id, name: fullName(thread.contact) }
			: null,
		messageCount: thread.messageCount,
		lastMessageAt: thread.lastMessageAt.toISOString(),
		messages: thread.messages.map((message) => ({
			direction: message.direction,
			from: message.fromEmail,
			fromName: message.fromName,
			sentAt: message.sentAt.toISOString(),
			body: (message.body ?? message.snippet)?.slice(0, BODY_LIMIT) ?? null,
		})),
	};
}

function toAccountMeeting(
	meeting: {
		title: string | null;
		startsAt: Date;
		attendees: { email: string; name: string | null }[];
	},
	now: Date,
): AccountMeeting {
	return {
		title: meeting.title,
		startsAt: meeting.startsAt.toISOString(),
		upcoming: meeting.startsAt > now,
		attendees: meeting.attendees,
	};
}

function toCompanyDeal(deal: {
	id: string;
	name: string;
	stage: string;
	amount: unknown;
	currency: string;
	expectedCloseDate: Date | null;
	lastActivityAt: Date | null;
	contacts: {
		role: string | null;
		contact: { id: string; firstName: string; lastName: string | null };
	}[];
}): CompanyDeal {
	return {
		id: deal.id,
		name: deal.name,
		stage: deal.stage,
		open: isOpen(deal.stage),
		amount: deal.amount === null ? null : Number(deal.amount),
		currency: deal.currency,
		expectedCloseDate: deal.expectedCloseDate?.toISOString() ?? null,
		lastActivityAt: deal.lastActivityAt?.toISOString() ?? null,
		contacts: deal.contacts.map(({ role, contact }) => ({
			id: contact.id,
			name: fullName(contact),
			role,
		})),
	};
}

function fullName(person: {
	firstName: string;
	lastName: string | null;
}): string {
	return [person.firstName, person.lastName].filter(Boolean).join(" ");
}

function daysSince(date: Date, now: Date): number {
	return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}
