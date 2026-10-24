import {
	and,
	count,
	type Db,
	Decimal,
	deal,
	eq,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
	sql,
} from "@crm/db";
import { minorUnitsOf, normalizeCurrency } from "@crm/db/currency";
import {
	type Conversion,
	convertToBase,
	type ResolvedRate,
	resolveRate,
} from "@crm/db/fx";
import { readReportingCurrency } from "@crm/db/settings";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

export interface DealFxFields {
	baseAmount: Decimal | null;
	baseCurrency: string | null;
	fxRate: Decimal | null;
	fxRateAt: Date | null;
}

export interface Unconverted {
	count: number;
	currencies: string[];
}

export interface RerateResult {
	converted: number;
	cleared: number;
	missing: string[];
}

@Injectable()
export class ConversionService {
	private readonly logger = new Logger(ConversionService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async reportingCurrency(): Promise<string> {
		return readReportingCurrency(this.db);
	}

	async rateFor(currency: string): Promise<ResolvedRate | null> {
		const base = await this.reportingCurrency();
		return resolveRate(this.db, base, currency);
	}

	async convert(
		amount: Decimal | null,
		currency: string,
	): Promise<Conversion | null> {
		return convertToBase(
			this.db,
			amount,
			currency,
			await this.reportingCurrency(),
		);
	}

	async dealFields(
		amount: Decimal | null,
		currency: string,
	): Promise<DealFxFields> {
		const converted = await this.convert(amount, currency);

		if (!converted) {
			return {
				baseAmount: null,
				baseCurrency: null,
				fxRate: null,
				fxRateAt: null,
			};
		}

		return {
			baseAmount: converted.baseAmount,
			baseCurrency: converted.baseCurrency,
			fxRate: converted.fxRate,
			fxRateAt: converted.fxRateAt,
		};
	}

	countedWhere(base: string): SQL | undefined {
		return and(isNotNull(deal.baseAmount), eq(deal.baseCurrency, base));
	}

	pendingWhere(base: string): SQL | undefined {
		return and(
			isNotNull(deal.amount),
			or(
				isNull(deal.baseAmount),
				isNull(deal.baseCurrency),
				ne(deal.baseCurrency, base),
			),
		);
	}

	async unconverted(where?: SQL): Promise<Unconverted> {
		const base = await this.reportingCurrency();

		const rows = await this.db
			.select({ currency: deal.currency, count: count() })
			.from(deal)
			.where(and(where, this.pendingWhere(base)))
			.groupBy(deal.currency);

		return {
			count: rows.reduce((total, row) => total + row.count, 0),
			currencies: rows
				.map((row) => normalizeCurrency(row.currency))
				.filter((code, index, all) => all.indexOf(code) === index)
				.sort(),
		};
	}

	async rerateAll(): Promise<RerateResult> {
		return this.rerate(false);
	}

	async fillMissing(): Promise<RerateResult> {
		return this.rerate(true);
	}

	private async rerate(onlyMissing: boolean): Promise<RerateResult> {
		const base = await this.reportingCurrency();

		const groups = await this.db
			.select({ currency: deal.currency })
			.from(deal)
			.where(onlyMissing ? this.pendingWhere(base) : isNotNull(deal.amount))
			.groupBy(deal.currency);

		const codes = [
			...new Set(groups.map((group) => normalizeCurrency(group.currency))),
		];

		const places = minorUnitsOf(base);
		let converted = 0;
		let cleared = 0;
		const missing: string[] = [];

		for (const code of codes) {
			const rate = await resolveRate(this.db, base, code);

			if (!rate) {
				missing.push(code);

				if (!onlyMissing) {
					cleared += await this.clear(code);
				}

				continue;
			}

			converted += await this.write(base, code, rate, places, onlyMissing);
		}

		this.logger.log({
			message: onlyMissing
				? "Filled in deal amounts that had no rate"
				: "Re-rated every deal against the reporting currency",
			base,
			converted,
			cleared,
			missing,
		});

		return { converted, cleared, missing: missing.sort() };
	}

	private async write(
		base: string,
		code: string,
		rate: ResolvedRate,
		places: number,
		onlyMissing: boolean,
	): Promise<number> {
		const value = new Decimal(rate.rate).toString();

		const filter = onlyMissing
			? sql`AND ("baseAmount" IS NULL OR "baseCurrency" IS DISTINCT FROM ${base})`
			: sql``;

		const result = await this.db.execute(sql`
			UPDATE "deal"
			SET "baseAmount" = ROUND("amount" * ${value}::numeric, ${places}::int),
			    "baseCurrency" = ${base},
			    "fxRate" = ${value}::numeric,
			    "fxRateAt" = ${rate.asOf}
			WHERE "amount" IS NOT NULL
			  AND upper(btrim("currency")) = ${code}
			  ${filter}
		`);
		return result.rowCount ?? 0;
	}

	private async clear(code: string): Promise<number> {
		const result = await this.db.execute(sql`
			UPDATE "deal"
			SET "baseAmount" = NULL,
			    "baseCurrency" = NULL,
			    "fxRate" = NULL,
			    "fxRateAt" = NULL
			WHERE upper(btrim("currency")) = ${code}
			  AND "baseAmount" IS NOT NULL
		`);
		return result.rowCount ?? 0;
	}
}
