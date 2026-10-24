import type { SQL } from "drizzle-orm";
import type { QueryResult } from "pg";

export async function firstRow<Row>(
	rows: PromiseLike<Row[]>,
): Promise<Row | null> {
	const [row] = await rows;
	return row ?? null;
}

export async function requireRow<Row>(
	rows: PromiseLike<Row[]>,
	message = "The query returned no row.",
): Promise<Row> {
	const [row] = await rows;
	if (row === undefined) throw new Error(message);
	return row;
}

export function orNull<Row>(row: Row | undefined): Row | null {
	return row ?? null;
}

export function orThrow<Row>(row: Row | undefined): Row {
	if (row === undefined) throw new Error("No record matched the query.");
	return row;
}

const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;

function stamp(value: string, typeId: number): Date {
	const iso = value.replace(" ", "T");
	if (typeId === TIMESTAMP) return new Date(`${iso}Z`);
	return new Date(/[+-]\d\d$/.test(iso) ? `${iso}:00` : iso);
}

export async function queryRows<Row>(
	executor: { execute: (query: SQL) => PromiseLike<QueryResult> },
	query: SQL,
): Promise<Row[]> {
	const result = await executor.execute(query);
	const stamps = result.fields.filter(
		(field) =>
			field.dataTypeID === TIMESTAMP || field.dataTypeID === TIMESTAMPTZ,
	);
	if (stamps.length === 0) return result.rows as Row[];
	return result.rows.map((row) => {
		const parsed = { ...row };
		for (const field of stamps) {
			const value = parsed[field.name];
			if (value !== null && value !== undefined) {
				parsed[field.name] = stamp(String(value), field.dataTypeID);
			}
		}
		return parsed;
	});
}
