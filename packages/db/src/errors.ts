const PG_ERROR = {
	uniqueViolation: "23505",
	foreignKeyViolation: "23503",
} as const;

function hasCode(value: unknown): value is { code: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		typeof value.code === "string"
	);
}

export function pgErrorCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth++) {
		if (hasCode(current) && /^[0-9A-Z]{5}$/.test(current.code)) {
			return current.code;
		}
		current =
			typeof current === "object" && current !== null && "cause" in current
				? current.cause
				: undefined;
	}
	return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
	return pgErrorCode(error) === PG_ERROR.uniqueViolation;
}

export function isForeignKeyViolation(error: unknown): boolean {
	return pgErrorCode(error) === PG_ERROR.foreignKeyViolation;
}
