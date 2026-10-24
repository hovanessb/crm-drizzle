import {
	asc,
	type Column,
	count,
	desc,
	type Executor,
	gte,
	inArray,
	isNotNull,
	isNull,
	or,
	type PgColumn,
	type PgTable,
	type SQL,
	sql,
} from "@crm/db";
import { z } from "zod";

export const listInput = z.object({
	q: z.string().default(""),
	sort: z.string().default(""),
	dir: z.enum(["asc", "desc"]).default("asc"),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(25),
});

export type ListInput = z.infer<typeof listInput>;

export type FacetCount = Record<string, number>;

type FacetCounts = Record<string, FacetCount>;

export type ListResult<TRow> = {
	rows: TRow[];
	total: number;
	facetCounts: FacetCounts;
};

export type Page = {
	skip: number;
	take: number;
};

export function paginate(input: Pick<ListInput, "page" | "pageSize">): Page {
	return {
		skip: (input.page - 1) * input.pageSize,
		take: input.pageSize,
	};
}

type SortDirection = ListInput["dir"];

export interface OrderByColumns<TOrderBy> {
	[column: string]: (dir: SortDirection) => TOrderBy;
}

type Sortable = Column | SQL | SQL.Aliased;

export function sortBy(column: Sortable, dir: SortDirection): SQL {
	return dir === "asc" ? asc(column) : desc(column);
}

export function sortNullsLast(column: Sortable, dir: SortDirection): SQL {
	return dir === "asc"
		? sql`${column} asc nulls last`
		: sql`${column} desc nulls last`;
}

export function resolveOrderBy<TOrderBy>(
	input: Pick<ListInput, "sort" | "dir">,
	columns: OrderByColumns<TOrderBy>,
	fallback: TOrderBy,
): TOrderBy {
	const column = columns[input.sort];
	return column ? column(input.dir) : fallback;
}

export function countsByKey<
	TKey extends string,
	TGroup extends { count: number } & {
		[K in TKey]?: string | null;
	},
>(groups: TGroup[], key: TKey, nullKey?: string): FacetCount {
	const counts: FacetCount = {};

	for (const group of groups) {
		const value = group[key] ?? nullKey;
		if (value == null) continue;
		counts[value] = (counts[value] ?? 0) + group.count;
	}

	return counts;
}

export type GroupCount = { value: string | null; count: number };

export async function groupCounts(
	db: Executor,
	table: PgTable,
	column: PgColumn,
	where: SQL | undefined,
): Promise<GroupCount[]> {
	const rows = await db
		.select({ value: column, count: count() })
		.from(table)
		.where(where)
		.groupBy(column);
	return rows.map((row) => ({
		value: row.value === null ? null : String(row.value),
		count: Number(row.count),
	}));
}

export const FACET_UNASSIGNED = "unassigned";

export function splitSentinel(values: string[], sentinel: string) {
	const ids = values.filter((value) => value !== sentinel);
	return { ids, includesSentinel: ids.length !== values.length };
}

export function ownerFilter(column: Column, values: string[]): SQL | undefined {
	if (values.length === 0) return undefined;

	const { ids, includesSentinel } = splitSentinel(values, FACET_UNASSIGNED);
	if (includesSentinel && ids.length === 0) return isNull(column);
	if (!includesSentinel) return inArray(column, ids);
	return or(inArray(column, ids), isNull(column));
}

export function archivedFilter(column: Column, archived: boolean): SQL {
	return archived ? isNotNull(column) : isNull(column);
}

const ACTIVITY_WINDOWS = ["7", "30", "90"] as const;

const activityWindowSet: ReadonlySet<string> = new Set(ACTIVITY_WINDOWS);

export const activityFacetInput = z
	.array(z.string())
	.refine((values) => values.every((value) => activityWindowSet.has(value)), {
		message: `Activity must be one of: ${ACTIVITY_WINDOWS.join(", ")}.`,
	});

function activityCutoff(days: number): Date {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function activityFilter(
	column: Column,
	values: string[],
): SQL | undefined {
	if (values.length === 0) return undefined;
	const days = values.reduce((max, value) => Math.max(max, Number(value)), 0);
	return gte(column, activityCutoff(days));
}

export async function activityFacetCounts(
	column: Column,
	countWhere: (where: SQL) => Promise<number>,
): Promise<FacetCount> {
	const counts = await Promise.all(
		ACTIVITY_WINDOWS.map((days) =>
			countWhere(gte(column, activityCutoff(Number(days)))),
		),
	);
	return Object.fromEntries(
		ACTIVITY_WINDOWS.map((days, index) => [days, counts[index]]),
	) as FacetCount;
}
