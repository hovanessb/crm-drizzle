import { Decimal } from "decimal.js";
import { and, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { minorUnitsOf, normalizeCurrency } from "./currency";
import { RateSource } from "./schema/enums";
import { exchangeRate } from "./schema/schema";

export type RateOrigin = "IDENTITY" | "MANUAL" | "FETCHED";

export interface ResolvedRate {
	rate: Decimal;
	asOf: Date;
	origin: RateOrigin;
	provider: string | null;
}

export interface Conversion {
	baseAmount: Decimal;
	baseCurrency: string;
	fxRate: Decimal;
	fxRateAt: Date;
	origin: RateOrigin;
}

export const ONE = new Decimal(1);

export async function resolveRate(
	db: Executor,
	base: string,
	quote: string,
	now: Date = new Date(),
): Promise<ResolvedRate | null> {
	const baseCurrency = normalizeCurrency(base);
	const quoteCurrency = normalizeCurrency(quote);

	if (!baseCurrency || !quoteCurrency) return null;

	if (baseCurrency === quoteCurrency) {
		return { rate: ONE, asOf: now, origin: "IDENTITY", provider: null };
	}

	const rows = await db
		.select({
			rate: exchangeRate.rate,
			asOf: exchangeRate.asOf,
			source: exchangeRate.source,
			provider: exchangeRate.provider,
		})
		.from(exchangeRate)
		.where(
			and(
				eq(exchangeRate.baseCurrency, baseCurrency),
				eq(exchangeRate.quoteCurrency, quoteCurrency),
			),
		);

	const manual = rows.find((row) => row.source === RateSource.MANUAL);
	const chosen =
		manual ?? rows.find((row) => row.source === RateSource.FETCHED);

	if (!chosen || chosen.rate.lessThanOrEqualTo(0)) return null;

	return {
		rate: chosen.rate,
		asOf: chosen.asOf,
		origin: chosen.source === RateSource.MANUAL ? "MANUAL" : "FETCHED",
		provider: chosen.provider,
	};
}

export function applyRate(
	amount: Decimal,
	rate: ResolvedRate,
	base: string,
): Conversion {
	const baseCurrency = normalizeCurrency(base);

	return {
		baseAmount: amount
			.times(rate.rate)
			.toDecimalPlaces(minorUnitsOf(baseCurrency)),
		baseCurrency,
		fxRate: rate.rate,
		fxRateAt: rate.asOf,
		origin: rate.origin,
	};
}

export async function convertToBase(
	db: Executor,
	amount: Decimal | null,
	from: string,
	base: string,
	now: Date = new Date(),
): Promise<Conversion | null> {
	if (amount === null) return null;

	const rate = await resolveRate(db, base, from, now);
	if (!rate) return null;

	return applyRate(amount, rate, base);
}
