import {
	ActivityType,
	activity,
	and,
	asc,
	company,
	count,
	type Db,
	DealStage,
	deal,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	or,
	sql,
	sum,
	user,
} from "@crm/db";
import { OPEN_DEAL_STAGES } from "@crm/db/deal-stage";
import { activityMeta } from "@crm/validation/activity-meta";
import { Injectable } from "@nestjs/common";
import { taskDayBoundaries } from "../activities/task-due-date";
import { toCents } from "../crm/values";
import { ConversionService } from "../currency/conversion.service";
import { InjectDatabase } from "../database/database.constants";
import type { DashboardSummaryInput } from "./dashboard.contracts";

const OWNER_FIELDS = {
	id: user.id,
	name: user.name,
	email: user.email,
	image: user.image,
};

const TREND_MONTHS = 6;

const RATE_WINDOW_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "short" });

function monthStart(from: Date, offset: number): Date {
	return new Date(from.getFullYear(), from.getMonth() + offset, 1);
}

function monthKey(date: Date): number {
	return date.getFullYear() * 12 + date.getMonth();
}

@Injectable()
export class DashboardService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly conversion: ConversionService,
	) {}

	async summary(actingUserId: string, input: DashboardSummaryInput) {
		const mine = input.scope === "me";
		const owned = mine ? eq(deal.ownerId, actingUserId) : undefined;
		const open = and(owned, inArray(deal.stage, [...OPEN_DEAL_STAGES]));

		const now = new Date();
		const { startOfToday } = taskDayBoundaries(now);
		const startOfMonth = monthStart(now, 0);
		const startOfNextMonth = monthStart(now, 1);
		const startOfPrevMonth = monthStart(now, -1);
		const trendStart = monthStart(now, -(TREND_MONTHS - 1));
		const rateStart = new Date(now.getTime() - RATE_WINDOW_DAYS * DAY_MS);

		const base = await this.conversion.reportingCurrency();
		const counted = this.conversion.countedWhere(base);

		const [
			openByStage,
			openValueByStage,
			recentDeals,
			closingThisMonthTotals,
			biggestOpen,
			overdueTasks,
			recentActivity,
			unconverted,
		] = await Promise.all([
			this.db
				.select({ stage: deal.stage, count: count() })
				.from(deal)
				.where(open)
				.groupBy(deal.stage),
			this.db
				.select({
					stage: deal.stage,
					baseAmount: sum(deal.baseAmount).mapWith(deal.baseAmount),
				})
				.from(deal)
				.where(and(open, counted))
				.groupBy(deal.stage),
			this.db
				.select({
					baseAmount: deal.baseAmount,
					baseCurrency: deal.baseCurrency,
					stage: deal.stage,
					createdAt: deal.createdAt,
					closedAt: deal.closedAt,
				})
				.from(deal)
				.where(
					and(
						owned,
						or(gte(deal.createdAt, trendStart), gte(deal.closedAt, trendStart)),
					),
				),
			this.db
				.select({
					count: count(),
					baseAmount: sum(deal.baseAmount).mapWith(deal.baseAmount),
				})
				.from(deal)
				.where(
					and(
						open,
						gte(deal.expectedCloseDate, startOfMonth),
						lt(deal.expectedCloseDate, startOfNextMonth),
						counted,
					),
				)
				.then(([row]) => row ?? { count: 0, baseAmount: null }),
			this.db
				.select({
					id: deal.id,
					name: deal.name,
					stage: deal.stage,
					amount: deal.amount,
					currency: deal.currency,
					baseAmount: deal.baseAmount,
					baseCurrency: deal.baseCurrency,
					expectedCloseDate: deal.expectedCloseDate,
					stageChangedAt: deal.stageChangedAt,
					company: {
						id: company.id,
						name: company.name,
						iconUrl: company.iconUrl,
						iconDarkUrl: company.iconDarkUrl,
						iconTone: company.iconTone,
					},
					owner: OWNER_FIELDS,
				})
				.from(deal)
				.innerJoin(company, eq(company.id, deal.companyId))
				.innerJoin(user, eq(user.id, deal.ownerId))
				.where(open)
				.orderBy(
					sql`${deal.baseAmount} desc nulls last`,
					asc(deal.expectedCloseDate),
				)
				.limit(6),
			this.db.query.activity.findMany({
				where: and(
					eq(activity.type, ActivityType.TASK),
					isNull(activity.completedAt),
					lt(activity.dueAt, startOfToday),
					eq(activity.createdById, actingUserId),
				),
				orderBy: [asc(activity.dueAt)],
				limit: 10,
				columns: { id: true, subject: true, dueAt: true },
				with: {
					company: { columns: { id: true, name: true } },
					deal: { columns: { id: true, name: true } },
				},
			}),
			this.db.query.activity.findMany({
				where: mine ? eq(activity.createdById, actingUserId) : undefined,
				orderBy: [desc(activity.createdAt)],
				limit: 12,
				columns: {
					id: true,
					type: true,
					subject: true,
					body: true,
					createdAt: true,
					meta: true,
				},
				with: {
					createdBy: {
						columns: { id: true, name: true, email: true, image: true },
					},
					company: { columns: { id: true, name: true } },
					deal: { columns: { id: true, name: true } },
				},
			}),
			this.conversion.unconverted(owned),
		]);

		const stages = OPEN_DEAL_STAGES.map((stage) => {
			const group = openByStage.find((row) => row.stage === stage);
			const value = openValueByStage.find((row) => row.stage === stage);
			return {
				stage: stage as DealStage,
				count: group?.count ?? 0,
				valueCents: toCents(value?.baseAmount ?? null) ?? 0,
			};
		});

		const firstBucket = monthKey(trendStart);
		const trend = Array.from({ length: TREND_MONTHS }, (_, index) => ({
			month: MONTH_LABEL.format(monthStart(trendStart, index)),
			won: 0,
			created: 0,
		}));

		const wonThisMonth = { count: 0, valueCents: 0 };
		const wonPrevMonth = { count: 0, valueCents: 0 };
		let wins = 0;
		let losses = 0;
		let valuedWins = 0;
		let wonCents = 0;
		let cycleDays = 0;

		for (const recent of recentDeals) {
			const valued =
				recent.baseCurrency === base ? toCents(recent.baseAmount) : null;
			const cents = valued ?? 0;

			const created = trend[monthKey(recent.createdAt) - firstBucket];
			if (created) created.created += cents;

			const { closedAt, stage } = recent;
			if (!closedAt) continue;
			const won = stage === DealStage.CLOSED_WON;

			if (won) {
				const closed = trend[monthKey(closedAt) - firstBucket];
				if (closed) closed.won += cents;

				if (closedAt >= startOfMonth && closedAt < startOfNextMonth) {
					wonThisMonth.count += 1;
					wonThisMonth.valueCents += cents;
				} else if (closedAt >= startOfPrevMonth && closedAt < startOfMonth) {
					wonPrevMonth.count += 1;
					wonPrevMonth.valueCents += cents;
				}
			}

			if (closedAt < rateStart) continue;
			if (won) {
				wins += 1;
				if (valued !== null) {
					valuedWins += 1;
					wonCents += cents;
				}
				cycleDays += (closedAt.getTime() - recent.createdAt.getTime()) / DAY_MS;
			} else if (stage === DealStage.CLOSED_LOST) {
				losses += 1;
			}
		}

		const decided = wins + losses;

		return {
			scope: input.scope,
			reportingCurrency: base,
			unconverted,
			pipeline: {
				stages,
				totalCents: stages.reduce((total, s) => total + s.valueCents, 0),
				totalDeals: stages.reduce((total, s) => total + s.count, 0),
			},
			wonThisMonth,
			wonPrevMonth,
			performance: {
				windowDays: RATE_WINDOW_DAYS,
				wins,
				losses,
				winRate: decided === 0 ? null : wins / decided,
				avgDealCents:
					valuedWins === 0 ? null : Math.round(wonCents / valuedWins),
				avgCycleDays: wins === 0 ? null : Math.round(cycleDays / wins),
			},
			trend,
			closingThisMonthTotal: {
				count: closingThisMonthTotals.count,
				valueCents: toCents(closingThisMonthTotals.baseAmount) ?? 0,
			},
			biggestOpen: biggestOpen
				.map(
					({
						amount,
						baseAmount,
						baseCurrency,
						expectedCloseDate,
						stageChangedAt,
						...row
					}) => ({
						...row,
						amountCents: toCents(amount),
						baseAmountCents: baseCurrency === base ? toCents(baseAmount) : null,
						expectedCloseDate: expectedCloseDate?.toISOString() ?? null,
						stageChangedAt: stageChangedAt.toISOString(),
					}),
				)
				.sort((a, b) => (b.baseAmountCents ?? -1) - (a.baseAmountCents ?? -1)),
			overdueTasks: overdueTasks.map(({ dueAt, ...task }) => ({
				...task,
				dueAt: dueAt?.toISOString() ?? null,
			})),
			recentActivity: recentActivity.map(({ createdAt, meta, ...entry }) => ({
				...entry,
				createdAt: createdAt.toISOString(),
				meta: activityMeta.parse(meta),
			})),
		};
	}
}
