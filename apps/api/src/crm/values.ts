import { Decimal } from "@crm/db";

export function toCents(amount: Decimal | null): number | null {
	return amount === null ? null : amount.times(100).toNumber();
}

export function fromCents(cents: number | null | undefined): number | null {
	return cents === null || cents === undefined ? null : cents / 100;
}

export function decimalFromCents(
	cents: number | null | undefined,
): Decimal | null {
	return cents === null || cents === undefined
		? null
		: new Decimal(cents).dividedBy(100);
}

export function blankToNull(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function normalizeEmail(value: string): string | null {
	return blankToNull(value)?.toLowerCase() ?? null;
}
