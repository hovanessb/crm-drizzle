import {
	ActivityType,
	activity,
	and,
	calendarAttendee,
	calendarEvent,
	company,
	contact,
	contains,
	count,
	type Db,
	deal,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	not,
	or,
	relatedCount,
	type SQL,
	sql,
	user,
} from "@crm/db";
import { activityMeta } from "@crm/validation/activity-meta";
import {
	BadRequestException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { blankToNull } from "../crm/values";
import { InjectDatabase } from "../database/database.constants";
import {
	countsByKey,
	type OrderByColumns,
	paginate,
	resolveOrderBy,
	sortBy,
	sortNullsLast,
} from "../trpc/list-input";
import type {
	ActivityCreateInput,
	ActivityEntry,
	ActivityUpdateInput,
	MyTasksInput,
	TaskListInput,
	TaskListResult,
	TimelineCounts,
	TimelineFilter,
	TimelineInput,
	TimelineResult,
} from "./activities.contracts";
import { TASKS } from "./activities-config";
import {
	parseTaskDueDay,
	serializeTaskDueDay,
	taskDayBoundaries,
	taskWindowFilter,
} from "./task-due-date";

const AUTHOR_COLUMNS = {
	id: true,
	name: true,
	email: true,
	image: true,
} as const;

const ENTRY_QUERY = {
	columns: {
		id: true,
		type: true,
		subject: true,
		body: true,
		occurredAt: true,
		dueAt: true,
		completedAt: true,
		meta: true,
		createdAt: true,
	},
	with: {
		createdBy: { columns: AUTHOR_COLUMNS },
		company: { columns: { id: true, name: true } },
		contact: { columns: { id: true, firstName: true, lastName: true } },
		deal: { columns: { id: true, name: true } },
		emailThread: {
			columns: {
				id: true,
				messageCount: true,
				lastMessageAt: true,
			},
		},
		calendarEvent: {
			columns: {
				id: true,
				startsAt: true,
				endsAt: true,
				isAllDay: true,
				location: true,
				conferenceUrl: true,
			},
			extras: (event: { id: typeof calendarEvent.id }) => ({
				attendeeCount: relatedCount(
					calendarAttendee,
					calendarAttendee.eventId,
					event.id,
				).as("attendeeCount"),
			}),
		},
	},
} as const;

const NOTE_TYPES = [
	ActivityType.NOTE,
	ActivityType.CALL,
	ActivityType.EMAIL,
	ActivityType.MEETING,
];

const TASK_FIELDS = {
	id: activity.id,
	subject: activity.subject,
	dueAt: activity.dueAt,
	completedAt: activity.completedAt,
	createdAt: activity.createdAt,
	createdBy: {
		id: user.id,
		name: user.name,
		email: user.email,
		image: user.image,
	},
	company: {
		id: company.id,
		name: company.name,
		domain: company.domain,
		iconUrl: company.iconUrl,
		iconDarkUrl: company.iconDarkUrl,
		iconTone: company.iconTone,
		logoUrl: company.logoUrl,
	},
	contact: {
		id: contact.id,
		firstName: contact.firstName,
		lastName: contact.lastName,
	},
	deal: { id: deal.id, name: deal.name },
};

const dueFirst = sql`${activity.dueAt} asc nulls last`;

const TASK_SORTABLE: OrderByColumns<SQL[]> = {
	subject: (dir) => [sortNullsLast(activity.subject, dir)],
	dueAt: (dir) => [
		sortNullsLast(activity.dueAt, dir),
		desc(activity.createdAt),
	],
	status: (dir) => [
		dir === "asc"
			? sql`${activity.completedAt} asc nulls first`
			: sql`${activity.completedAt} desc nulls last`,
		dueFirst,
	],
	company: (dir) => [sortBy(company.name, dir), dueFirst],
	createdBy: (dir) => [sortBy(user.name, dir), dueFirst],
	createdAt: (dir) => [sortBy(activity.createdAt, dir)],
};

const taskAggregateRow = z.object({
	open: z.coerce.number().int().nonnegative(),
	done: z.coerce.number().int().nonnegative(),
	overdue: z.coerce.number().int().nonnegative(),
	today: z.coerce.number().int().nonnegative(),
	week: z.coerce.number().int().nonnegative(),
	later: z.coerce.number().int().nonnegative(),
	none: z.coerce.number().int().nonnegative(),
});

@Injectable()
export class ActivitiesService {
	private readonly logger = new Logger(ActivitiesService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly stamp: ActivityStampService,
	) {}

	async timeline(input: TimelineInput): Promise<TimelineResult> {
		const where = and(
			this.anchor(input),
			filterClause(input.filter),
			input.cursor ? await this.after(input.cursor) : undefined,
		);

		const rows = await this.db.query.activity.findMany({
			...ENTRY_QUERY,
			where,
			limit: input.limit + 1,
			orderBy: [sql`${activity.occurredAt} desc nulls last`, desc(activity.id)],
		});

		const hasMore = rows.length > input.limit;
		const entries = hasMore ? rows.slice(0, input.limit) : rows;

		return {
			entries: entries.map(serializeEntry),
			nextCursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null,
		};
	}

	async timelineCounts(
		input: Pick<TimelineInput, "companyId" | "contactId" | "dealId">,
	): Promise<TimelineCounts> {
		const anchor = this.anchor(input);

		const [all, notes, upcoming, done, email, meetings] = await Promise.all([
			this.db.$count(activity, anchor),
			this.db.$count(activity, and(anchor, filterClause("notes"))),
			this.db.$count(activity, and(anchor, filterClause("upcoming"))),
			this.db.$count(activity, and(anchor, filterClause("done"))),
			this.db.$count(activity, and(anchor, filterClause("email"))),
			this.db.$count(activity, and(anchor, filterClause("meetings"))),
		]);

		return { all, notes, upcoming, done, email, meetings };
	}

	async create(
		input: ActivityCreateInput,
		actingUserId: string,
	): Promise<ActivityEntry> {
		const companyId = await this.resolveCompanyId(input);

		const isTask = input.type === ActivityType.TASK;

		const [inserted] = await this.db
			.insert(activity)
			.values({
				type: input.type,
				subject: blankToNull(input.subject ?? ""),
				body: blankToNull(input.body ?? ""),
				occurredAt: parseDate(input.occurredAt) ?? new Date(),
				dueAt: isTask ? parseTaskDueDay(input.dueAt) : null,
				companyId,
				contactId: input.contactId ?? null,
				dealId: input.dealId ?? null,
				createdById: actingUserId,
			})
			.returning({ id: activity.id });
		if (!inserted) throw new Error("The activity insert returned no row.");

		const entry = await this.entry(inserted.id);

		await this.stamp.touch(
			{ companyId, contactId: input.contactId, dealId: input.dealId },
			entry.createdAt,
		);

		this.logger.log({
			message: "Activity logged",
			activityId: entry.id,
			type: entry.type,
		});

		return serializeEntry(entry);
	}

	async update(input: ActivityUpdateInput): Promise<ActivityEntry> {
		await this.requireTask(input.id, "Only tasks can be edited.");

		await this.db
			.update(activity)
			.set({ subject: input.subject, dueAt: parseTaskDueDay(input.dueAt) })
			.where(eq(activity.id, input.id));

		return serializeEntry(await this.entry(input.id));
	}

	async complete(id: string, completed: boolean): Promise<ActivityEntry> {
		await this.requireTask(id, "Only tasks can be completed.");

		await this.db
			.update(activity)
			.set({ completedAt: completed ? new Date() : null })
			.where(eq(activity.id, id));

		return serializeEntry(await this.entry(id));
	}

	async myTasks(
		input: MyTasksInput,
		actingUserId: string,
	): Promise<ActivityEntry[]> {
		const now = new Date();
		const where = and(
			eq(activity.type, ActivityType.TASK),
			isNull(activity.completedAt),
			eq(activity.createdById, actingUserId),
			input.window === "overdue" ? lt(activity.dueAt, now) : undefined,
			input.window === "upcoming" ? gte(activity.dueAt, now) : undefined,
		);

		const tasks = await this.db.query.activity.findMany({
			...ENTRY_QUERY,
			where,
			limit: input.limit,
			orderBy: [dueFirst, desc(activity.createdAt)],
		});

		return tasks.map(serializeEntry);
	}

	async tasks(input: TaskListInput): Promise<TaskListResult> {
		const now = new Date();
		const where = this.taskWhere(input, now);
		const { skip, take } = paginate(input);

		const [rows, total, facetCounts] = await Promise.all([
			selectTasks(this.db)
				.where(where)
				.orderBy(
					...resolveOrderBy(input, TASK_SORTABLE, [
						dueFirst,
						desc(activity.createdAt),
					]),
				)
				.limit(take)
				.offset(skip),
			this.db.$count(activity, where),
			this.taskFacetCounts(input.q, now),
		]);

		return {
			rows: rows.map(serializeTask),
			total,
			day: {
				today: serializeTaskDueDay(taskDayBoundaries(now).startOfToday) ?? "",
				timeZone: TASKS.day.timeZone,
			},
			facetCounts,
		};
	}

	private taskWhere(input: TaskListInput, now: Date): SQL | undefined {
		return and(
			this.taskBaseWhere(input.q),
			input.status === "open" ? isNull(activity.completedAt) : undefined,
			input.status === "done" ? isNotNull(activity.completedAt) : undefined,
			input.createdBy.length > 0
				? inArray(activity.createdById, input.createdBy)
				: undefined,
			input.due.length > 0
				? or(...input.due.map((window) => taskWindowFilter(window, now)))
				: undefined,
		);
	}

	private taskBaseWhere(q: string): SQL | undefined {
		const term = q.trim();
		const isTask = eq(activity.type, ActivityType.TASK);
		if (!term) return isTask;

		const matches = (column: Parameters<typeof contains>[0]) =>
			contains(column, term, { insensitive: true });

		return and(
			isTask,
			or(
				matches(activity.subject),
				matches(activity.body),
				inArray(
					activity.companyId,
					this.db
						.select({ id: company.id })
						.from(company)
						.where(matches(company.name)),
				),
				inArray(
					activity.dealId,
					this.db.select({ id: deal.id }).from(deal).where(matches(deal.name)),
				),
				inArray(
					activity.contactId,
					this.db
						.select({ id: contact.id })
						.from(contact)
						.where(or(matches(contact.firstName), matches(contact.lastName))),
				),
			),
		);
	}

	private async taskFacetCounts(q: string, now: Date) {
		const where = this.taskBaseWhere(q);
		const term = q.trim();
		const search = term
			? sql`AND (
				strpos(lower(COALESCE(activity."subject", '')), lower(${term})) > 0
				OR strpos(lower(COALESCE(activity."body", '')), lower(${term})) > 0
				OR strpos(lower(COALESCE(company."name", '')), lower(${term})) > 0
				OR strpos(lower(COALESCE(deal."name", '')), lower(${term})) > 0
				OR strpos(lower(COALESCE(contact."firstName", '')), lower(${term})) > 0
				OR strpos(lower(COALESCE(contact."lastName", '')), lower(${term})) > 0
			)`
			: sql``;
		const { startOfToday, startOfTomorrow, startOfNextWeek } =
			taskDayBoundaries(now);

		const [authors, aggregateRows] = await Promise.all([
			this.db
				.select({ createdById: activity.createdById, count: count() })
				.from(activity)
				.where(where)
				.groupBy(activity.createdById),
			this.db.execute(sql`
				SELECT
					COUNT(*) FILTER (WHERE activity."completedAt" IS NULL) AS "open",
					COUNT(*) FILTER (WHERE activity."completedAt" IS NOT NULL) AS "done",
					COUNT(*) FILTER (WHERE activity."dueAt" < ${startOfToday}) AS "overdue",
					COUNT(*) FILTER (WHERE activity."dueAt" >= ${startOfToday} AND activity."dueAt" < ${startOfTomorrow}) AS "today",
					COUNT(*) FILTER (WHERE activity."dueAt" >= ${startOfTomorrow} AND activity."dueAt" < ${startOfNextWeek}) AS "week",
					COUNT(*) FILTER (WHERE activity."dueAt" >= ${startOfNextWeek}) AS "later",
					COUNT(*) FILTER (WHERE activity."dueAt" IS NULL) AS "none"
				FROM "activity" activity
				LEFT JOIN "company" company ON company."id" = activity."companyId"
				LEFT JOIN "contact" contact ON contact."id" = activity."contactId"
				LEFT JOIN "deal" deal ON deal."id" = activity."dealId"
				WHERE activity."type" = ${ActivityType.TASK}::"ActivityType"
				${search}
			`),
		]);

		const aggregate = taskAggregateRow.parse(
			z.array(z.unknown()).length(1).parse(aggregateRows.rows)[0],
		);

		return {
			status: { open: aggregate.open, done: aggregate.done },
			createdBy: countsByKey(authors, "createdById"),
			due: {
				overdue: aggregate.overdue,
				today: aggregate.today,
				week: aggregate.week,
				later: aggregate.later,
				none: aggregate.none,
			},
		};
	}

	private async requireTask(id: string, wrongType: string) {
		const [row] = await this.db
			.select({ type: activity.type })
			.from(activity)
			.where(eq(activity.id, id))
			.limit(1);

		if (!row) {
			throw new NotFoundException(`No activity with id ${id}.`);
		}

		if (row.type !== ActivityType.TASK) {
			throw new BadRequestException(wrongType);
		}
	}

	private async entry(id: string): Promise<Entry> {
		const row = await findEntry(this.db, eq(activity.id, id));
		if (!row) throw new NotFoundException(`No activity with id ${id}.`);
		return row;
	}

	private async after(cursorId: string): Promise<SQL | undefined> {
		const [cursor] = await this.db
			.select({ id: activity.id, occurredAt: activity.occurredAt })
			.from(activity)
			.where(eq(activity.id, cursorId))
			.limit(1);
		if (!cursor) return sql`false`;

		if (cursor.occurredAt === null) {
			return and(isNull(activity.occurredAt), lt(activity.id, cursor.id));
		}

		return or(
			lt(activity.occurredAt, cursor.occurredAt),
			and(
				eq(activity.occurredAt, cursor.occurredAt),
				lt(activity.id, cursor.id),
			),
			isNull(activity.occurredAt),
		);
	}

	private anchor(
		input: Pick<TimelineInput, "companyId" | "contactId" | "dealId">,
	): SQL {
		if (input.dealId) return eq(activity.dealId, input.dealId);
		if (input.contactId) return eq(activity.contactId, input.contactId);
		if (input.companyId) return eq(activity.companyId, input.companyId);
		throw new BadRequestException(
			"A timeline needs a company, a contact or a deal.",
		);
	}

	private async resolveCompanyId(
		input: ActivityCreateInput,
	): Promise<string | null> {
		if (input.companyId) return input.companyId;

		if (input.dealId) {
			const [row] = await this.db
				.select({ companyId: deal.companyId })
				.from(deal)
				.where(eq(deal.id, input.dealId))
				.limit(1);
			if (!row) {
				throw new NotFoundException(`No deal with id ${input.dealId}.`);
			}
			return row.companyId;
		}

		if (input.contactId) {
			const [row] = await this.db
				.select({ companyId: contact.companyId })
				.from(contact)
				.where(eq(contact.id, input.contactId))
				.limit(1);
			if (!row) {
				throw new NotFoundException(`No contact with id ${input.contactId}.`);
			}
			return row.companyId;
		}

		return null;
	}
}

function filterClause(filter: TimelineFilter): SQL | undefined {
	switch (filter) {
		case "notes":
			return inArray(activity.type, NOTE_TYPES);
		case "upcoming":
			return and(
				eq(activity.type, ActivityType.TASK),
				isNull(activity.completedAt),
			);
		case "done":
			return and(
				eq(activity.type, ActivityType.TASK),
				isNotNull(activity.completedAt),
			);
		case "history":
			return not(
				and(
					eq(activity.type, ActivityType.TASK),
					isNull(activity.completedAt),
				) as SQL,
			);
		case "email":
			return eq(activity.type, ActivityType.EMAIL);
		case "meetings":
			return eq(activity.type, ActivityType.MEETING);
		case "all":
			return undefined;
	}
}

function findEntry(db: Db, where: SQL) {
	return db.query.activity.findFirst({ ...ENTRY_QUERY, where });
}

function selectTasks(db: Db) {
	return db
		.select(TASK_FIELDS)
		.from(activity)
		.innerJoin(user, eq(user.id, activity.createdById))
		.leftJoin(company, eq(company.id, activity.companyId))
		.leftJoin(contact, eq(contact.id, activity.contactId))
		.leftJoin(deal, eq(deal.id, activity.dealId))
		.$dynamic();
}

type Entry = NonNullable<Awaited<ReturnType<typeof findEntry>>>;

type Task = Awaited<ReturnType<typeof selectTasks>>[number];

function serializeTask(task: Task) {
	return {
		...task,
		dueAt: serializeTaskDueDay(task.dueAt),
		completedAt: task.completedAt?.toISOString() ?? null,
		createdAt: task.createdAt.toISOString(),
	};
}

function serializeEntry(entry: Entry) {
	return {
		...entry,
		occurredAt: entry.occurredAt?.toISOString() ?? null,
		dueAt: entry.dueAt?.toISOString() ?? null,
		completedAt: entry.completedAt?.toISOString() ?? null,
		createdAt: entry.createdAt.toISOString(),
		meta: activityMeta.parse(entry.meta),

		emailThread: entry.emailThread
			? {
					id: entry.emailThread.id,
					messageCount: entry.emailThread.messageCount,
					lastMessageAt: entry.emailThread.lastMessageAt.toISOString(),
				}
			: null,

		calendarEvent: entry.calendarEvent
			? {
					id: entry.calendarEvent.id,
					startsAt: entry.calendarEvent.startsAt.toISOString(),
					endsAt: entry.calendarEvent.endsAt.toISOString(),
					isAllDay: entry.calendarEvent.isAllDay,
					location: entry.calendarEvent.location,
					conferenceUrl: entry.calendarEvent.conferenceUrl,
					attendeeCount: entry.calendarEvent.attendeeCount,
				}
			: null,
	};
}

function parseDate(value: string | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new BadRequestException(`"${value}" is not a date.`);
	}
	return date;
}
