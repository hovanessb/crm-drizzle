import {
	type Column,
	ilike,
	like,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";

type TextColumn = Column | SQL;

type TextMatch = { insensitive?: boolean };

export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function match(column: TextColumn, pattern: string, options: TextMatch): SQL {
	return options.insensitive ? ilike(column, pattern) : like(column, pattern);
}

export function contains(
	column: TextColumn,
	value: string,
	options: TextMatch = {},
): SQL {
	return match(column, `%${escapeLike(value)}%`, options);
}

export function startsWith(
	column: TextColumn,
	value: string,
	options: TextMatch = {},
): SQL {
	return match(column, `${escapeLike(value)}%`, options);
}

export function endsWith(
	column: TextColumn,
	value: string,
	options: TextMatch = {},
): SQL {
	return match(column, `%${escapeLike(value)}`, options);
}

export function equalsInsensitive(column: TextColumn, value: string): SQL {
	return ilike(column, escapeLike(value));
}
