import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	and,
	appSetting,
	company as companyTable,
	count,
	DealStage,
	Decimal,
	db,
	deal as dealTable,
	eq,
	exchangeRate,
	inArray,
	isNotNull,
	RateSource,
	user,
} from "@crm/db";
import { normalizeCurrency } from "@crm/db/currency";
import { SETTINGS_ID, writeReportingCurrency } from "@crm/db/settings";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import { ActivityStampService } from "../src/crm/activity-stamp.service";
import { ConversionService } from "../src/currency/conversion.service";
import { DashboardService } from "../src/dashboard/dashboard.service";
import { DealsService } from "../src/deals/deals.service";
import { FieldsService } from "../src/fields/fields.service";
import { withDiscardedCrmEvents } from "./agent-trigger.stub";
import { first, one } from "./rows";

const suffix = process.env.TEST_RUN_ID ?? "currency-totals-spec";
const userId = `user-${suffix}`;
const domain = `money-${suffix}.test`;

const agent = {
	withCrmEvents: withDiscardedCrmEvents,
} as unknown as AgentTriggerService;

const conversion = new ConversionService(db);
const deals = new DealsService(
	db,
	agent,
	new ActivityStampService(db),
	conversion,
	new FieldsService(db, { fieldBackfill: async () => undefined } as never),
);
const dashboard = new DashboardService(db, conversion);

let companyId: string;
let previousReportingCurrency: string | null = null;

const MILLION = 100_000_000;
const HALF_MILLION = 50_000_000;

async function rate(quote: string, value: string, source: RateSource) {
	await db
		.insert(exchangeRate)
		.values({
			baseCurrency: "USD",
			quoteCurrency: quote,
			rate: new Decimal(value),
			asOf: new Date("2026-08-01T00:00:00.000Z"),
			source,
		})
		.onConflictDoUpdate({
			target: [
				exchangeRate.baseCurrency,
				exchangeRate.quoteCurrency,
				exchangeRate.source,
			],
			set: { rate: new Decimal(value) },
		});
}

async function clearRates() {
	await db
		.delete(exchangeRate)
		.where(
			and(
				inArray(exchangeRate.baseCurrency, ["USD", "EUR"]),
				inArray(exchangeRate.quoteCurrency, ["USD", "EUR", "CHF"]),
			),
		);
}

async function pipelineCents(): Promise<number> {
	const summary = await dashboard.summary(userId, { scope: "me" });
	return summary.pipeline.totalCents;
}

beforeAll(async () => {
	const existing = await first(
		db
			.select({ reportingCurrency: appSetting.reportingCurrency })
			.from(appSetting)
			.where(eq(appSetting.id, SETTINGS_ID))
			.limit(1),
	);
	previousReportingCurrency = existing?.reportingCurrency ?? null;

	await writeReportingCurrency(db, "USD");
	await clearRates();

	await db
		.insert(user)
		.values({
			id: userId,
			name: "Rate Tester",
			email: `rates@${domain}`,
			emailVerified: true,
		})
		.onConflictDoNothing();

	const existingCompany = await first(
		db
			.select({ id: companyTable.id })
			.from(companyTable)
			.where(eq(companyTable.domain, domain))
			.limit(1),
	);
	const company =
		existingCompany ??
		(await one(
			db
				.insert(companyTable)
				.values({ name: `Money Co ${suffix}`, domain })
				.returning({ id: companyTable.id }),
		));
	companyId = company.id;

	await rate("EUR", "1.10", RateSource.FETCHED);
});

afterAll(async () => {
	await db.delete(dealTable).where(eq(dealTable.companyId, companyId));
	await db.delete(companyTable).where(eq(companyTable.domain, domain));
	await db.delete(user).where(eq(user.id, userId));
	await clearRates();

	if (previousReportingCurrency) {
		await writeReportingCurrency(db, previousReportingCurrency);
	} else {
		await db.update(appSetting).set({ reportingCurrency: null });
	}

	await conversion.rerateAll();
});

describe("a total across currencies", () => {
	it("converts on write and never adds two currencies together", async () => {
		await deals.create({
			name: `Domestic ${suffix}`,
			companyId,
			ownerId: userId,
			amountCents: MILLION,
			currency: "USD",
		});

		await deals.create({
			name: `Continental ${suffix}`,
			companyId,
			ownerId: userId,
			amountCents: MILLION,
			currency: "EUR",
		});

		expect(await pipelineCents()).toBe(MILLION + 1.1 * MILLION);
	});

	it("locks the rate onto the deal, so the row says how it was converted", async () => {
		const row = await first(
			db
				.select({
					amount: dealTable.amount,
					baseAmount: dealTable.baseAmount,
					fxRate: dealTable.fxRate,
					fxRateAt: dealTable.fxRateAt,
				})
				.from(dealTable)
				.where(
					and(
						eq(dealTable.companyId, companyId),
						eq(dealTable.currency, "EUR"),
					),
				)
				.limit(1),
		);

		expect(row?.amount?.toNumber()).toBe(1_000_000);
		expect(row?.baseAmount?.toNumber()).toBe(1_100_000);
		expect(row?.fxRate?.toNumber()).toBe(1.1);
		expect(row?.fxRateAt).toBeInstanceOf(Date);
	});

	it("leaves a deal it cannot convert out of the total, and says so", async () => {
		const before = await pipelineCents();

		await deals.create({
			name: `Alpine ${suffix}`,
			companyId,
			ownerId: userId,
			amountCents: HALF_MILLION,
			currency: "CHF",
		});

		expect(await pipelineCents()).toBe(before);

		const summary = await dashboard.summary(userId, { scope: "me" });
		expect(summary.reportingCurrency).toBe("USD");
		expect(summary.unconverted.count).toBe(1);
		expect(summary.unconverted.currencies).toEqual(["CHF"]);
	});

	it("picks the waiting deal up when a rate finally arrives", async () => {
		await rate("CHF", "1.25", RateSource.MANUAL);

		const filled = await conversion.fillMissing();
		expect(filled.converted).toBeGreaterThan(0);

		expect(await pipelineCents()).toBe(
			MILLION + 1.1 * MILLION + 1.25 * HALF_MILLION,
		);

		const summary = await dashboard.summary(userId, { scope: "me" });
		expect(summary.unconverted.count).toBe(0);
	});

	it("does not re-rate a deal that already has a rate", async () => {
		await rate("EUR", "9.99", RateSource.FETCHED);

		await conversion.fillMissing();

		const row = await first(
			db
				.select({ baseAmount: dealTable.baseAmount })
				.from(dealTable)
				.where(
					and(
						eq(dealTable.companyId, companyId),
						eq(dealTable.currency, "EUR"),
					),
				)
				.limit(1),
		);

		expect(row?.baseAmount?.toNumber()).toBe(1_100_000);
	});

	it("lets a rate entered by hand beat the fetched one on a re-rate", async () => {
		await rate("EUR", "1.50", RateSource.MANUAL);

		await conversion.rerateAll();

		const row = await first(
			db
				.select({ baseAmount: dealTable.baseAmount, fxRate: dealTable.fxRate })
				.from(dealTable)
				.where(
					and(
						eq(dealTable.companyId, companyId),
						eq(dealTable.currency, "EUR"),
					),
				)
				.limit(1),
		);

		expect(row?.fxRate?.toNumber()).toBe(1.5);
		expect(row?.baseAmount?.toNumber()).toBe(1_500_000);
	});

	it("re-rates everything when the reporting currency changes", async () => {
		await writeReportingCurrency(db, "EUR");

		const rerated = await conversion.rerateAll();
		expect(rerated.missing).toContain("USD");

		const summary = await dashboard.summary(userId, { scope: "me" });

		expect(summary.reportingCurrency).toBe("EUR");
		expect(summary.pipeline.totalCents).toBe(MILLION);
		expect(summary.unconverted.currencies).toEqual(["CHF", "USD"]);
	});
});

describe("the deals list", () => {
	it("reports its open pipeline in the reporting currency and discloses the rest", async () => {
		await writeReportingCurrency(db, "USD");
		await conversion.rerateAll();

		const list = await deals.list({
			q: "",
			page: 1,
			pageSize: 25,
			sort: "amount",
			dir: "desc",
			status: "open",
			owner: [userId],
			stage: [],
			closing: [],
			fields: {},
			archived: false,
		});

		expect(list.reportingCurrency).toBe("USD");
		expect(list.unconverted.count).toBe(0);
		expect(list.openValueCents).toBe(
			MILLION + 1.5 * MILLION + 1.25 * HALF_MILLION,
		);

		const amounts = list.rows.map((row) => row.baseAmountCents);
		expect(amounts).toEqual([...amounts].sort((a, b) => (b ?? 0) - (a ?? 0)));
	});
});

describe("a converted figure knows which currency it is in", () => {
	it("leaves a deal whose baseAmount predates a currency change out of totals", async () => {
		await writeReportingCurrency(db, "USD");
		await conversion.rerateAll();

		const before = await pipelineCents();
		const summary = await dashboard.summary(userId, { scope: "me" });
		expect(summary.unconverted.count).toBe(0);

		const deal = await deals.create({
			name: `Stale ${suffix}`,
			companyId,
			ownerId: userId,
			amountCents: MILLION,
			currency: "USD",
		});

		expect(await pipelineCents()).toBe(before + MILLION);

		await one(
			db
				.update(dealTable)
				.set({ baseCurrency: "JPY" })
				.where(eq(dealTable.id, deal.id))
				.returning(),
		);

		expect(await pipelineCents()).toBe(before);

		const stale = await dashboard.summary(userId, { scope: "me" });
		expect(stale.unconverted.count).toBe(1);

		const filled = await conversion.fillMissing();
		expect(filled.converted).toBeGreaterThan(0);

		expect(await pipelineCents()).toBe(before + MILLION);

		await one(
			db.delete(dealTable).where(eq(dealTable.id, deal.id)).returning(),
		);
	});

	it("never lets a converted figure with no currency on it go unnoticed", async () => {
		await writeReportingCurrency(db, "USD");
		await conversion.rerateAll();

		const before = await pipelineCents();

		const orphan = await one(
			db
				.insert(dealTable)
				.values({
					name: `Orphan ${suffix}`,
					companyId,
					ownerId: userId,
					amount: new Decimal(50_000),
					currency: "USD",
					baseAmount: new Decimal(50_000),
					fxRate: new Decimal(1),
					fxRateAt: new Date(),
				})
				.returning({ id: dealTable.id }),
		);

		expect(await pipelineCents()).toBe(before);

		const summary = await dashboard.summary(userId, { scope: "me" });
		expect(summary.unconverted.count).toBe(1);

		await conversion.fillMissing();

		const healed = await first(
			db
				.select({ baseCurrency: dealTable.baseCurrency })
				.from(dealTable)
				.where(eq(dealTable.id, orphan.id))
				.limit(1),
		);
		expect(healed?.baseCurrency).toBe("USD");
		expect(await pipelineCents()).toBe(before + 5_000_000);

		await one(
			db.delete(dealTable).where(eq(dealTable.id, orphan.id)).returning(),
		);
	});

	it("counts a currency once however it was cased or padded", async () => {
		const rows = await Promise.all(
			[" usd ", "Usd"].map((currency, index) =>
				one(
					db
						.insert(dealTable)
						.values({
							name: `Variant ${index} ${suffix}`,
							companyId,
							ownerId: userId,
							amount: new Decimal(1000),
							currency,
						})
						.returning({ id: dealTable.id }),
				),
			),
		);

		const pending = await conversion.unconverted();
		expect(pending.currencies.filter((code) => code === "USD")).toEqual([
			"USD",
		]);

		const rerated = await conversion.rerateAll();

		const written = await db
			.select({
				baseAmount: dealTable.baseAmount,
				baseCurrency: dealTable.baseCurrency,
			})
			.from(dealTable)
			.where(
				inArray(
					dealTable.id,
					rows.map((row) => row.id),
				),
			);

		for (const row of written) {
			expect(row.baseCurrency).toBe("USD");
			expect(row.baseAmount?.toNumber()).toBe(1000);
		}

		const groups = await db
			.select({ currency: dealTable.currency, count: count() })
			.from(dealTable)
			.where(isNotNull(dealTable.amount))
			.groupBy(dealTable.currency);

		const convertible = groups
			.filter(
				(group) => !rerated.missing.includes(normalizeCurrency(group.currency)),
			)
			.reduce((total, group) => total + group.count, 0);

		expect(rerated.converted).toBe(convertible);

		await db.delete(dealTable).where(
			inArray(
				dealTable.id,
				rows.map((row) => row.id),
			),
		);
	});

	it("keeps a converted deal when the rate behind it has gone away", async () => {
		await writeReportingCurrency(db, "USD");
		await conversion.rerateAll();

		const deal = await deals.create({
			name: `Frozen ${suffix}`,
			companyId,
			ownerId: userId,
			amountCents: MILLION,
			currency: "EUR",
		});

		const frozen = await first(
			db
				.select({ baseAmount: dealTable.baseAmount })
				.from(dealTable)
				.where(eq(dealTable.id, deal.id))
				.limit(1),
		);
		expect(frozen?.baseAmount).not.toBeNull();

		const before = await pipelineCents();

		await clearRates();

		const stranded = await one(
			db
				.insert(dealTable)
				.values({
					name: `Stranded ${suffix}`,
					companyId,
					ownerId: userId,
					amount: new Decimal(1000),
					currency: "EUR",
				})
				.returning({ id: dealTable.id }),
		);

		const filled = await conversion.fillMissing();
		expect(filled.missing).toContain("EUR");
		expect(filled.cleared).toBe(0);

		const kept = await first(
			db
				.select({
					baseAmount: dealTable.baseAmount,
					baseCurrency: dealTable.baseCurrency,
				})
				.from(dealTable)
				.where(eq(dealTable.id, deal.id))
				.limit(1),
		);
		expect(kept?.baseCurrency).toBe("USD");
		expect(kept?.baseAmount?.toNumber()).toBe(frozen?.baseAmount?.toNumber());
		expect(await pipelineCents()).toBe(before);

		await db
			.delete(dealTable)
			.where(inArray(dealTable.id, [deal.id, stranded.id]));
		await rate("EUR", "1.10", RateSource.FETCHED);
	});
});

describe("the dashboard only values what it can convert", () => {
	const analystId = `analyst-${suffix}`;

	beforeAll(async () => {
		await writeReportingCurrency(db, "USD");

		await db
			.insert(user)
			.values({
				id: analystId,
				name: "Dashboard Tester",
				email: `dashboard@${domain}`,
				emailVerified: true,
			})
			.onConflictDoNothing();
	});

	afterAll(async () => {
		await db.delete(dealTable).where(eq(dealTable.ownerId, analystId));
		await db.delete(user).where(eq(user.id, analystId));
	});

	async function stale(name: string, stage: DealStage) {
		const closed = stage === DealStage.CLOSED_WON;

		return one(
			db
				.insert(dealTable)
				.values({
					name: `${name} ${suffix}`,
					companyId,
					ownerId: analystId,
					stage,
					amount: new Decimal(9_000),
					currency: "USD",
					baseAmount: new Decimal(9_000),
					baseCurrency: "JPY",
					fxRate: new Decimal(1),
					fxRateAt: new Date(),
					closedAt: closed ? new Date() : null,
				})
				.returning({ id: dealTable.id }),
		);
	}

	it("does not average a won deal it cannot value into the rest", async () => {
		const won = await deals.create({
			name: `Valued win ${suffix}`,
			companyId,
			ownerId: analystId,
			amountCents: 10_000,
			currency: "USD",
			stage: DealStage.CLOSED_WON,
		});

		const unvalued = await stale("Stale win", DealStage.CLOSED_WON);

		const summary = await dashboard.summary(analystId, { scope: "me" });

		expect(summary.performance.wins).toBe(2);
		expect(summary.performance.avgDealCents).toBe(10_000);
		expect(summary.unconverted.count).toBe(1);

		await db
			.delete(dealTable)
			.where(inArray(dealTable.id, [won.id, unvalued.id]));
	});

	it("does not let a stale figure set the largest open deal", async () => {
		const open = await deals.create({
			name: `Valued open ${suffix}`,
			companyId,
			ownerId: analystId,
			amountCents: 10_000,
			currency: "USD",
		});

		const unvalued = await stale("Stale open", DealStage.DEMO_BOOKED);

		const summary = await dashboard.summary(analystId, { scope: "me" });

		expect(summary.biggestOpen[0]?.id).toBe(open.id);
		expect(summary.biggestOpen[0]?.baseAmountCents).toBe(10_000);
		expect(
			summary.biggestOpen.find((deal) => deal.id === unvalued.id)
				?.baseAmountCents,
		).toBeNull();

		await db
			.delete(dealTable)
			.where(inArray(dealTable.id, [open.id, unvalued.id]));
	});
});
