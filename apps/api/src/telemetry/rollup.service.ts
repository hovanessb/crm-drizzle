import {
	ActivityType,
	activity,
	agentConversation,
	agentTask,
	and,
	appSetting,
	avg,
	company,
	contact,
	contactFact,
	count,
	type Db,
	DealStage,
	deal,
	EnrichmentStatus,
	emailMessage,
	emailThread,
	eq,
	FactBand,
	FactStatus,
	formSubmission,
	gte,
	isNotNull,
	isNull,
	mailboxSync,
	max as maxOf,
	member,
	not,
	or,
	type PgColumn,
	type PgTable,
	RecordSource,
	sql,
	ssoProvider,
	startsWith,
	suppressedContact,
	suppressedDomain,
	trackedDomain,
	trackedEvent,
	workspaceProfile as workspaceProfileTable,
} from "@crm/db";
import { RETIRED_OUTCOME } from "@crm/db/agent-tasks";
import { readAgentModel } from "@crm/db/settings";
import { CONTACT_CAP_REASON } from "@crm/db/tracking";
import { WORKSPACE_ID } from "@crm/db/workspace";
import {
	bucket,
	claimRollup,
	dayBucket,
	drainCounters,
	installDaily,
	type Properties,
	permittedEvidenceKind,
	permittedMethod,
	permittedTaskKind,
	permittedTool,
	releaseRollup,
	restoreCounters,
	telemetryDisabled,
} from "@crm/telemetry";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { groupCounts } from "../trpc/list-input";
import { FunnelService } from "./funnel.service";
import { SEED_OWNER_PREFIX } from "./seed";

const WINDOW_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

const SUPERSEDE_WINDOW_DAYS = 7;

const SANDBOX_TOOLS = new Set([
	"bash",
	"glob",
	"grep",
	"read_file",
	"write_file",
]);

type Counted = { key: string; count: number };

export type RollupOutcome = {
	sent: boolean;
	reason?: string;
	milestones: string[];
};

@Injectable()
export class RollupService {
	private readonly logger = new Logger(RollupService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly funnel: FunnelService,
	) {}

	async run(force = false): Promise<RollupOutcome> {
		if (telemetryDisabled()) {
			return { sent: false, reason: "telemetry is off", milestones: [] };
		}

		const milestones = await this.funnel.sweep();

		const now = new Date();
		const claim = await claimRollup(now, force);
		if (!claim.claimed) {
			return { sent: false, reason: claim.reason, milestones };
		}

		const since = new Date(now.getTime() - WINDOW_HOURS * HOUR_MS);
		let counters: Record<string, number> = {};

		try {
			const gathered = await this.gather(since);
			counters = gathered.counters;

			if (!(await installDaily(gathered.properties, now))) {
				await this.giveBack(claim.previous, counters);

				return { sent: false, reason: "not delivered", milestones };
			}

			this.logger.log({
				message: "Telemetry rollup sent",
				windowHours: WINDOW_HOURS,
				milestones: milestones.length,
			});

			return { sent: true, milestones };
		} catch (error) {
			await this.giveBack(claim.previous, counters);

			this.logger.debug({
				message: "Telemetry rollup could not be built",
				reason: error instanceof Error ? error.message : String(error),
			});

			return { sent: false, reason: "failed", milestones };
		}
	}

	private async giveBack(
		previous: Date | null,
		counters: Record<string, number>,
	): Promise<void> {
		await releaseRollup(previous);
		await restoreCounters(counters);
	}

	private async gather(
		since: Date,
	): Promise<{ properties: Properties; counters: Record<string, number> }> {
		const counters = await drainCounters();

		const [shape, agent, ledger, crm] = await Promise.all([
			this.shape(),
			this.agent(since, counters),
			this.ledger(),
			this.crm(since),
		]);

		return {
			properties: { ...shape, ...agent, ...ledger, ...crm },
			counters,
		};
	}

	private async shape(): Promise<Properties> {
		const [model, members, ssoProviders, postgres, contextKey] =
			await Promise.all([
				readAgentModel(this.db).catch(() => null),
				this.db.$count(member, eq(member.organizationId, WORKSPACE_ID)),
				this.db.$count(ssoProvider),
				this.postgresMajor(),
				this.db
					.select({ contextDevApiKey: appSetting.contextDevApiKey })
					.from(appSetting)
					.limit(1)
					.then((rows) => rows[0]),
			]);

		return {
			node_version: process.versions.node.split(".")[0] ?? null,
			postgres_version: postgres,
			members_bucket: bucket(members),

			cap_perplexity: isSet("PERPLEXITY_API_KEY"),
			cap_context_dev: Boolean(contextKey?.contextDevApiKey?.trim()),
			cap_blob: isSet("BLOB_READ_WRITE_TOKEN"),
			cap_github: isSet("GITHUB_TOKEN"),
			cap_redis: isSet("REDIS_URL"),
			cap_agent_bridge: isSet("AGENT_BRIDGE_SECRET"),
			cap_cron_secret: isSet("CRON_SECRET"),
			cap_ai_gateway: isSet("AI_GATEWAY_API_KEY"),
			cap_google_oauth:
				isSet("GOOGLE_CLIENT_ID") && isSet("GOOGLE_CLIENT_SECRET"),
			cap_sso_provider: ssoProviders > 0,
			is_marketing: process.env.IS_MARKETING === "true",

			agent_model_id: model?.id ?? null,
			agent_model_context_window: model?.contextWindowTokens ?? null,
		};
	}

	private async postgresMajor(): Promise<string | null> {
		try {
			const result = await this.db.execute<{ version: string }>(sql`
				SELECT current_setting('server_version_num') AS version;
			`);

			const raw = Number(result.rows[0]?.version);
			if (!Number.isFinite(raw)) return null;

			return String(Math.floor(raw / 10_000));
		} catch {
			return null;
		}
	}

	private async agent(
		since: Date,
		counters: Record<string, number>,
	): Promise<Properties> {
		const [tools, sessions, tasks, attempts, rechecks, conversations] =
			await Promise.all([
				this.toolCalls(since),
				this.sessions(since),
				this.tasks(since),
				this.attempts(since),
				this.rechecks(since),
				this.db.$count(agentConversation),
			]);

		const total = Object.values(tools.calls).reduce((sum, n) => sum + n, 0);

		return {
			tool_calls: tools.calls,
			tool_calls_total: total,
			tool_errors: tools.errors,
			sandbox_used: tools.sandbox,

			sessions_started: sessions.started,
			sessions_completed: sessions.completed,
			sessions_failed: sessions.failed,
			tools_per_session_mean: sessions.withTools
				? round(total / sessions.withTools)
				: 0,

			tasks_claimed: tasks.claimed,
			tasks_completed: tasks.completed,
			tasks_retired: tasks.retired,
			task_attempts_mean: attempts.mean,
			task_attempts_max: attempts.max,

			budget_exhausted: counters.budget_exhausted ?? 0,

			recheck_scheduled: rechecks.total,
			recheck_interval_days: rechecks.buckets,

			agent_conversations: conversations,
		};
	}

	private async toolCalls(since: Date): Promise<{
		calls: Record<string, number>;
		errors: Record<string, number>;
		sandbox: boolean;
	}> {
		const { rows } = await this.db.execute<{
			tool: string | null;
			failed: boolean;
			count: string;
		}>(sql`
			SELECT
				"data"->'result'->>'toolName' AS tool,
				COALESCE("data"->>'status', 'completed') <> 'completed' AS failed,
				COUNT(*) AS count
			FROM "agentEvent"
			WHERE "type" = 'action.result' AND "emittedAt" >= ${since}
			GROUP BY 1, 2;
		`);

		const calls: Record<string, number> = {};
		const errors: Record<string, number> = {};
		let sandbox = false;

		for (const row of rows) {
			const tool = permittedTool(row.tool);
			const count = Number(row.count);

			calls[tool] = (calls[tool] ?? 0) + count;
			if (row.failed) errors[tool] = (errors[tool] ?? 0) + count;
			if (SANDBOX_TOOLS.has(tool)) sandbox = true;
		}

		return { calls, errors, sandbox };
	}

	private async sessions(since: Date): Promise<{
		started: number;
		completed: number;
		failed: number;
		withTools: number;
	}> {
		const { rows } = await this.db.execute<{
			type: string;
			sessions: string;
		}>(sql`
			SELECT "type", COUNT(DISTINCT "sessionId") AS sessions
			FROM "agentEvent"
			WHERE "emittedAt" >= ${since}
				AND "type" IN ('session.started', 'session.waiting', 'session.failed', 'action.result')
			GROUP BY 1;
		`);

		const of = (type: string) =>
			Number(rows.find((row) => row.type === type)?.sessions ?? 0);

		return {
			started: of("session.started"),
			completed: of("session.waiting"),
			failed: of("session.failed"),
			withTools: of("action.result"),
		};
	}

	private async tasks(since: Date): Promise<{
		claimed: Record<string, number>;
		completed: Record<string, number>;
		retired: Record<string, number>;
	}> {
		const [claimed, finished] = await Promise.all([
			this.db
				.select({ kind: agentTask.kind, count: count() })
				.from(agentTask)
				.where(gte(agentTask.startedAt, since))
				.groupBy(agentTask.kind),
			this.db
				.select({
					kind: agentTask.kind,
					outcome: agentTask.outcome,
					count: count(),
				})
				.from(agentTask)
				.where(gte(agentTask.finishedAt, since))
				.groupBy(agentTask.kind, agentTask.outcome),
		]);

		const completed: Record<string, number> = {};
		const retired: Record<string, number> = {};

		for (const row of finished) {
			const kind = permittedTaskKind(row.kind);
			const into = row.outcome === RETIRED_OUTCOME ? retired : completed;
			into[kind] = (into[kind] ?? 0) + row.count;
		}

		return {
			claimed: byKind(
				claimed.map((row) => ({ key: row.kind, count: row.count })),
			),
			completed,
			retired,
		};
	}

	private async attempts(
		since: Date,
	): Promise<{ mean: Record<string, number>; max: Record<string, number> }> {
		const rows = await this.db
			.select({
				kind: agentTask.kind,
				mean: avg(agentTask.attempts).mapWith(Number),
				max: maxOf(agentTask.attempts),
			})
			.from(agentTask)
			.where(gte(agentTask.finishedAt, since))
			.groupBy(agentTask.kind);

		const mean: Record<string, number> = {};
		const max: Record<string, number> = {};

		for (const row of rows) {
			const kind = permittedTaskKind(row.kind);
			mean[kind] = round(row.mean ?? 0);
			max[kind] = row.max ?? 0;
		}

		return { mean, max };
	}

	private async rechecks(
		since: Date,
	): Promise<{ total: number; buckets: Record<string, number> }> {
		const rows = await this.db
			.select({ createdAt: agentTask.createdAt, dueAt: agentTask.dueAt })
			.from(agentTask)
			.where(
				and(eq(agentTask.kind, "recheck"), gte(agentTask.createdAt, since)),
			);

		const buckets: Record<string, number> = {};

		for (const row of rows) {
			const days = Math.max(
				0,
				(row.dueAt.getTime() - row.createdAt.getTime()) / (24 * HOUR_MS),
			);
			const label = dayBucket(days);
			buckets[label] = (buckets[label] ?? 0) + 1;
		}

		return { total: rows.length, buckets };
	}

	private async ledger(): Promise<Properties> {
		const [byStatus, byBand, methods, kinds, decided, superseded] =
			await Promise.all([
				this.counted(contactFact, contactFact.status),
				this.counted(contactFact, contactFact.band),
				this.counted(contactFact, contactFact.method),
				this.evidenceKinds(),
				this.decisionHours(),
				this.supersededWithin(SUPERSEDE_WINDOW_DAYS),
			]);

		const statuses = countsOf(byStatus, Object.values(FactStatus));

		const dismissed = statuses[FactStatus.DISMISSED] ?? 0;
		const proposed = statuses[FactStatus.PROPOSED] ?? 0;
		const judged = dismissed + (statuses[FactStatus.APPLIED] ?? 0) + proposed;

		return {
			facts_by_status: statuses,
			facts_by_band: countsOf(byBand, Object.values(FactBand)),
			facts_by_method: merge(
				methods.map((row) => ({
					key: permittedMethod(row.key),
					count: row.count,
				})),
			),
			facts_by_evidence_kind: kinds,
			fact_dismissal_rate: judged ? round(dismissed / judged) : 0,
			fact_decision_median_hours: decided,
			facts_superseded_within_7_days: superseded,
		};
	}

	private async evidenceKinds(): Promise<Record<string, number>> {
		const { rows } = await this.db.execute<{ kind: string; count: string }>(sql`
			SELECT item->>'kind' AS kind, COUNT(*) AS count
			FROM "contactFact", jsonb_array_elements("evidence") AS item
			WHERE jsonb_typeof("evidence") = 'array'
			GROUP BY 1;
		`);

		return merge(
			rows.map((row) => ({
				key: permittedEvidenceKind(row.kind),
				count: Number(row.count),
			})),
		);
	}

	private async decisionHours(): Promise<number | null> {
		const { rows } = await this.db.execute<{
			median: number | string | null;
		}>(sql`
			SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
				ORDER BY EXTRACT(EPOCH FROM ("decidedAt" - "observedAt")) / 3600
			) AS median
			FROM "contactFact"
			WHERE "decidedAt" IS NOT NULL;
		`);

		const median = rows[0]?.median;
		return median === null || median === undefined
			? null
			: round(Number(median));
	}

	private async supersededWithin(days: number): Promise<number> {
		const { rows } = await this.db.execute<{ count: string }>(sql`
			SELECT COUNT(*) AS count
			FROM "contactFact"
			WHERE "supersededAt" IS NOT NULL
				AND "supersededAt" - "observedAt" < make_interval(days => ${days});
		`);

		return Number(rows[0]?.count ?? 0);
	}

	private async counted(table: PgTable, column: PgColumn): Promise<Counted[]> {
		const rows = await groupCounts(this.db, table, column, undefined);
		return rows.map((row) => ({ key: row.value ?? "", count: row.count }));
	}

	private async crm(since: Date): Promise<Properties> {
		const [
			contacts,
			companies,
			deals,
			activities,
			contactSources,
			companySources,
			stages,
			types,
			syncs,
			threads,
			messages,
			enrichment,
			suppressedDomains,
			suppressedContacts,
			workspaceProfile,
			nonSeedContacts,
		] = await Promise.all([
			this.db.$count(contact),
			this.db.$count(company),
			this.db.$count(deal),
			this.db.$count(activity),
			this.counted(contact, contact.source),
			this.counted(company, company.source),
			this.counted(deal, deal.stage),
			this.counted(activity, activity.type),
			this.counted(mailboxSync, mailboxSync.status),
			this.db.$count(emailThread, gte(emailThread.createdAt, since)),
			this.db.$count(emailMessage, gte(emailMessage.createdAt, since)),
			this.counted(company, company.enrichmentStatus),
			this.db.$count(suppressedDomain),
			this.db.$count(suppressedContact),
			this.db.$count(workspaceProfileTable),
			this.db.$count(
				contact,
				or(
					isNull(contact.ownerId),
					not(startsWith(contact.ownerId, SEED_OWNER_PREFIX)),
				),
			),
		]);

		const [
			trackingSite,
			trackingDomains,
			trackingViews,
			trackingForms,
			trackingContacts,
			trackingCapped,
			trackingPaused,
		] = await Promise.all([
			this.db.$count(appSetting, isNotNull(appSetting.trackingSiteId)),
			this.db.$count(trackedDomain),
			this.db.$count(
				trackedEvent,
				and(
					eq(trackedEvent.type, "page_view"),
					gte(trackedEvent.occurredAt, since),
				),
			),
			this.db.$count(formSubmission, gte(formSubmission.createdAt, since)),
			this.db.$count(
				contact,
				and(
					gte(contact.createdAt, since),
					eq(contact.source, RecordSource.TRACKING),
				),
			),
			this.db.$count(
				formSubmission,
				and(
					gte(formSubmission.createdAt, since),
					eq(formSubmission.skipReason, CONTACT_CAP_REASON),
				),
			),
			this.db.$count(appSetting, eq(appSetting.trackingPaused, true)),
		]);

		const configured = syncs.reduce((sum, row) => sum + row.count, 0);

		return {
			seed_only: contacts > 0 && nonSeedContacts === 0,

			contacts_bucket: bucket(contacts),
			companies_bucket: bucket(companies),
			deals_bucket: bucket(deals),
			activities_bucket: bucket(activities),

			contacts_by_source: countsOf(contactSources, Object.values(RecordSource)),
			companies_by_source: countsOf(
				companySources,
				Object.values(RecordSource),
			),
			deals_by_stage: countsOf(stages, Object.values(DealStage)),
			activities_by_type: countsOf(types, Object.values(ActivityType)),

			cap_tracking: trackingSite > 0,
			tracking_domains: bucket(trackingDomains),
			tracking_page_views: trackingViews,
			tracking_forms: trackingForms,
			tracking_contacts_created: trackingContacts,
			tracking_capped: trackingCapped,
			tracking_paused: trackingPaused > 0,

			mailbox_sync_configured: configured > 0,
			mailbox_sync_status: merge(syncs),
			threads_ingested: threads,
			messages_ingested: messages,

			enrichment_by_status: countsOf(
				enrichment,
				Object.values(EnrichmentStatus),
			),

			suppressed_domains: suppressedDomains,
			suppressed_contacts: suppressedContacts,
			workspace_profile_written: workspaceProfile > 0,
		};
	}
}

function isSet(name: string): boolean {
	return Boolean(process.env[name]?.trim());
}

type CountsByKey = Record<string, number>;

function byKind(rows: Counted[]): CountsByKey {
	return merge(
		rows.map((row) => ({ ...row, key: permittedTaskKind(row.key) })),
	);
}

function merge(rows: Counted[]): CountsByKey {
	const counts: CountsByKey = {};

	for (const row of rows) {
		counts[row.key] = (counts[row.key] ?? 0) + row.count;
	}

	return counts;
}

function countsOf(rows: Counted[], keys: readonly string[]): CountsByKey {
	const merged = merge(rows);
	const complete: CountsByKey = {};

	for (const key of keys) complete[key] = merged[key] ?? 0;

	return complete;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
