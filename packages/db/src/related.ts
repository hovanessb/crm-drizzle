import {
	eq,
	getTableName,
	isNull,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type RelatedMatch = {
	column: PgColumn;
	value: string | number | boolean;
};

export function relatedCount(
	table: PgTable,
	foreignKey: PgColumn,
	parent: SQLWrapper,
	matches: RelatedMatch[] = [],
): SQL<number> {
	const related = sql.identifier("related");
	const filters = matches.map(
		(match) =>
			sql` and ${related}.${sql.identifier(match.column.name)} = ${match.value}`,
	);
	return sql<number>`(select count(*)::int from ${sql.identifier(getTableName(table))} as ${related} where ${related}.${sql.identifier(foreignKey.name)} = ${parent}${sql.join(filters)})`.mapWith(
		Number,
	);
}

export function hasValues<Value>(set: Partial<Record<string, Value>>): boolean {
	return Object.values(set).some((value) => value !== undefined);
}

export function whereEq<Column extends PgColumn>(
	column: Column,
	value: Column["_"]["data"] | null | undefined,
): SQL | undefined {
	if (value === undefined) return undefined;
	if (value === null) return isNull(column);
	return eq(column, value);
}
