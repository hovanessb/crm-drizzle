import { DatabaseError } from "pg";

const PG_ERROR = {
	uniqueViolation: "23505",
	foreignKeyViolation: "23503",
} as const;

const MAX_CAUSE_DEPTH = 5;

export function pgErrorCode(cause: unknown): string | undefined {
	let current = cause;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (current instanceof DatabaseError) return current.code;
		if (!(current instanceof Error)) return undefined;
		current = current.cause;
	}
	return undefined;
}

export function isUniqueViolation(cause: unknown): boolean {
	return pgErrorCode(cause) === PG_ERROR.uniqueViolation;
}

export function isForeignKeyViolation(cause: unknown): boolean {
	return pgErrorCode(cause) === PG_ERROR.foreignKeyViolation;
}
