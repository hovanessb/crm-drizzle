import { appUrl } from "@crm/auth/env";
import {
	canManageTracking,
	isWorkspaceRole,
	WORKSPACE_ID,
	type WorkspaceRole,
} from "@crm/auth/organization";
import {
	and,
	appSetting,
	asc,
	contact,
	count,
	type Db,
	DomainScope,
	desc,
	eq,
	formSubmission,
	gte,
	inArray,
	isNotNull,
	isUniqueViolation,
	max,
	member,
	type NewAppSetting,
	sql,
	trackedDomain,
	trackedEvent,
	trackedVisitor,
} from "@crm/db";
import { describeTouch } from "@crm/db/attribution";
import { safeFetch } from "@crm/db/safe-fetch";
import { SETTINGS_ID } from "@crm/db/settings";
import {
	COOKIE_LIFETIMES,
	gtmContainers,
	gtmContainerUrl,
	gtmSnippet,
	gtmTag,
	hostAllowed,
	loaderUrl,
	MAX_VERIFY_BYTES,
	normalizeHost,
	trackingReady,
	trackingSnippet,
	VERIFY_WINDOW_MS,
} from "@crm/db/tracking";
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import type {
	FoundInContainer,
	SourceRow,
	TouchSummary,
	TrackedDomainRow,
	TrackingSettings,
	VerifyResult,
	WebsiteActivity,
} from "./tracking.contracts";
import { TrackingConfigService } from "./tracking-config.service";

@Injectable()
export class TrackingService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly config: TrackingConfigService,
	) {}

	async settings(userId: string): Promise<TrackingSettings> {
		const [row, domains, latest, pageViews, submissions] = await Promise.all([
			this.db
				.select({
					trackingSiteId: appSetting.trackingSiteId,
					trackingCrossDomain: appSetting.trackingCrossDomain,
					trackingLimitToDomains: appSetting.trackingLimitToDomains,
					trackingCookieSubdomains: appSetting.trackingCookieSubdomains,
					trackingSecureCookies: appSetting.trackingSecureCookies,
					trackingHonourDnt: appSetting.trackingHonourDnt,
					trackingCookieDays: appSetting.trackingCookieDays,
					trackingPaused: appSetting.trackingPaused,
				})
				.from(appSetting)
				.where(eq(appSetting.id, SETTINGS_ID))
				.limit(1)
				.then((rows) => rows[0]),
			this.db
				.select()
				.from(trackedDomain)
				.orderBy(asc(trackedDomain.createdAt)),
			this.db
				.select({ occurredAt: trackedEvent.occurredAt })
				.from(trackedEvent)
				.orderBy(desc(trackedEvent.occurredAt))
				.limit(1)
				.then((rows) => rows[0]),
			this.db.$count(trackedEvent, eq(trackedEvent.type, "page_view")),
			this.db.$count(formSubmission),
		]);

		const ready = trackingReady(
			row?.trackingLimitToDomains ?? true,
			domains.length,
		);

		const siteId = ready
			? await this.config.ensureSiteId()
			: (row?.trackingSiteId ?? null);

		return {
			siteId,
			ready,
			scriptUrl: scriptUrl(),
			snippet: siteId ? snippet(siteId) : null,
			tagManagerSnippet: siteId ? gtmSnippet(appUrl, siteId) : null,
			crossDomain: row?.trackingCrossDomain ?? true,
			limitToDomains: row?.trackingLimitToDomains ?? true,
			cookieSubdomains: row?.trackingCookieSubdomains ?? false,
			secureCookies: row?.trackingSecureCookies ?? true,
			honourDnt: row?.trackingHonourDnt ?? true,
			cookieDays: row?.trackingCookieDays ?? 395,
			paused: row?.trackingPaused ?? false,
			cookieLifetimes: [...COOKIE_LIFETIMES],
			domains: domains.map((domain) => ({
				id: domain.id,
				host: domain.host,
				scope: domain.scope,
				pageViews: domain.pageViews,
				lastSeenAt: domain.lastSeenAt?.toISOString() ?? null,
			})),
			receivingSince: latest?.occurredAt.toISOString() ?? null,
			pageViews,
			submissions,
			canManage: canManageTracking(await this.roleOf(userId)),
		};
	}

	async setFlag(
		userId: string,
		flag:
			| "crossDomain"
			| "limitToDomains"
			| "cookieSubdomains"
			| "secureCookies"
			| "honourDnt"
			| "paused",
		enabled: boolean,
	): Promise<void> {
		await this.assertCanManage(userId);

		const column = {
			crossDomain: "trackingCrossDomain",
			limitToDomains: "trackingLimitToDomains",
			cookieSubdomains: "trackingCookieSubdomains",
			secureCookies: "trackingSecureCookies",
			honourDnt: "trackingHonourDnt",
			paused: "trackingPaused",
		}[flag];

		const fields: Partial<NewAppSetting> = { [column]: enabled };
		await this.db
			.insert(appSetting)
			.values({ id: SETTINGS_ID, ...fields })
			.onConflictDoUpdate({ target: appSetting.id, set: fields });

		await this.config.invalidate();
	}

	async setCookieDays(userId: string, days: number): Promise<void> {
		await this.assertCanManage(userId);

		if (!COOKIE_LIFETIMES.some((entry) => entry.days === days)) {
			throw new BadRequestException("That is not a cookie lifetime we offer.");
		}

		await this.db
			.insert(appSetting)
			.values({ id: SETTINGS_ID, trackingCookieDays: days })
			.onConflictDoUpdate({
				target: appSetting.id,
				set: { trackingCookieDays: days },
			});

		await this.config.invalidate();
	}

	async addDomain(
		userId: string,
		input: { host: string; scope: DomainScope },
	): Promise<TrackedDomainRow> {
		await this.assertCanManage(userId);

		const host = normalizeHost(input.host);
		if (!host) {
			throw new BadRequestException(
				"That is not a domain. Try something like acme.com.",
			);
		}

		try {
			const [domain] = await this.db
				.insert(trackedDomain)
				.values({ host, scope: input.scope })
				.returning();
			if (!domain) throw new Error("The domain insert returned no row.");

			await this.config.invalidate();

			return {
				id: domain.id,
				host: domain.host,
				scope: domain.scope,
				pageViews: domain.pageViews,
				lastSeenAt: null,
			};
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new BadRequestException(`${host} is already on the list.`);
			}

			throw error;
		}
	}

	async removeDomain(userId: string, id: string): Promise<void> {
		await this.assertCanManage(userId);

		const removed = await this.db
			.delete(trackedDomain)
			.where(eq(trackedDomain.id, id))
			.returning({ id: trackedDomain.id });
		if (removed.length === 0) {
			throw new NotFoundException("That domain is already gone.");
		}

		await this.config.invalidate();
	}

	async rotateSiteId(userId: string): Promise<{ siteId: string }> {
		await this.assertCanManage(userId);

		return { siteId: await this.config.rotateSiteId() };
	}

	async verify(userId: string, url: string): Promise<VerifyResult> {
		await this.assertCanManage(userId);

		const domains = await this.db.$count(trackedDomain);
		const [row] = await this.db
			.select({ trackingLimitToDomains: appSetting.trackingLimitToDomains })
			.from(appSetting)
			.where(eq(appSetting.id, SETTINGS_ID))
			.limit(1);

		if (!trackingReady(row?.trackingLimitToDomains ?? true, domains)) {
			throw new BadRequestException(
				"Add the domain your website runs on first — there is no script to find yet.",
			);
		}

		const target = absolute(url);
		if (!target) {
			throw new BadRequestException(
				"That is not a URL. Try something like acme.com/pricing.",
			);
		}

		const compiled = await this.config.compiled();
		const started = Date.now();
		const fetched = await safeFetch(target.toString(), { timeoutMs: 8_000 });
		const responseMs = Date.now() - started;
		const host = (fetched?.url ?? target).hostname.toLowerCase();

		if (!fetched?.response.ok) {
			return {
				status: "unreachable",
				host,
				detail: fetched
					? `The page answered ${fetched.response.status}.`
					: "We could not reach that page.",
			};
		}

		const body = (await fetched.response.text()).slice(0, MAX_VERIFY_BYTES);
		const siteId = compiled?.config.siteId;

		if (!siteId) {
			return { status: "missing", host, responseMs, containers: [] };
		}

		const inHtml = mentions(body, siteId);
		const containers = inHtml ? [] : gtmContainers(body);
		const container = inHtml
			? null
			: await this.inContainers(containers, siteId);

		if (!inHtml && !container) {
			return { status: "missing", host, responseMs, containers };
		}

		const since = new Date(Date.now() - VERIFY_WINDOW_MS);
		const [seen] = await this.db
			.select({ id: trackedEvent.id })
			.from(trackedEvent)
			.where(
				and(eq(trackedEvent.host, host), gte(trackedEvent.occurredAt, since)),
			)
			.limit(1);

		return {
			status: "found",
			host,
			responseMs,
			allowed: compiled ? hostAllowed(host, compiled.config) : false,
			pageView: seen !== undefined,
			container,
		};
	}

	private async inContainers(
		containers: string[],
		siteId: string,
	): Promise<FoundInContainer | null> {
		let attribute: FoundInContainer | null = null;

		for (const id of containers) {
			const fetched = await safeFetch(gtmContainerUrl(id), {
				timeoutMs: 8_000,
			});
			if (!fetched?.response.ok) continue;

			const source = (await fetched.response.text()).slice(0, MAX_VERIFY_BYTES);
			const state = gtmTag(source, siteId);

			if (state === "url") return { id, carriesSiteId: true };
			if (state === "attribute" && !attribute) {
				attribute = { id, carriesSiteId: false };
			}
		}

		return attribute;
	}

	async activityForCompany(companyId: string): Promise<WebsiteActivity> {
		const visitors = await this.db
			.select({ id: trackedVisitor.id })
			.from(trackedVisitor)
			.innerJoin(contact, eq(contact.id, trackedVisitor.contactId))
			.where(eq(contact.companyId, companyId));

		return this.activityFor(visitors.map((visitor) => visitor.id));
	}

	async activityForContact(contactId: string): Promise<WebsiteActivity> {
		const visitors = await this.db
			.select({ id: trackedVisitor.id })
			.from(trackedVisitor)
			.where(eq(trackedVisitor.contactId, contactId));

		return this.activityFor(visitors.map((visitor) => visitor.id));
	}

	private async activityFor(visitorIds: string[]): Promise<WebsiteActivity> {
		if (visitorIds.length === 0) {
			return {
				identified: false,
				visitors: 0,
				views: 0,
				lastSeenAt: null,
				pages: [],
				firstTouch: null,
				lastTouch: null,
			};
		}

		const [[first], [last]] = await Promise.all([
			this.db
				.select()
				.from(trackedVisitor)
				.where(
					and(
						inArray(trackedVisitor.id, visitorIds),
						isNotNull(trackedVisitor.firstSource),
					),
				)
				.orderBy(asc(trackedVisitor.firstTouchAt))
				.limit(1),
			this.db
				.select()
				.from(trackedVisitor)
				.where(
					and(
						inArray(trackedVisitor.id, visitorIds),
						isNotNull(trackedVisitor.lastSource),
					),
				)
				.orderBy(sql`${trackedVisitor.lastTouchAt} desc nulls first`)
				.limit(1),
		]);

		const pageViews = and(
			inArray(trackedEvent.visitorId, visitorIds),
			eq(trackedEvent.type, "page_view"),
		);

		const [grouped, latest, views] = await Promise.all([
			this.db
				.select({
					host: trackedEvent.host,
					path: trackedEvent.path,
					views: count(),
					lastSeenAt: max(trackedEvent.occurredAt),
				})
				.from(trackedEvent)
				.where(pageViews)
				.groupBy(trackedEvent.host, trackedEvent.path)
				.orderBy(desc(count(trackedEvent.path)))
				.limit(10),
			this.db
				.select({ occurredAt: trackedEvent.occurredAt })
				.from(trackedEvent)
				.where(inArray(trackedEvent.visitorId, visitorIds))
				.orderBy(desc(trackedEvent.occurredAt))
				.limit(1)
				.then((rows) => rows[0]),
			this.db.$count(trackedEvent, pageViews),
		]);

		return {
			identified: true,
			visitors: visitorIds.length,
			views,
			lastSeenAt: latest?.occurredAt.toISOString() ?? null,
			pages: grouped.flatMap((row) =>
				row.lastSeenAt
					? [
							{
								host: row.host,
								path: row.path,
								views: row.views,
								lastSeenAt: row.lastSeenAt.toISOString(),
							},
						]
					: [],
			),
			firstTouch: first
				? summarise({
						source: first.firstSource,
						medium: first.firstMedium,
						campaign: first.firstCampaign,
						landing: first.firstLanding,
						referrer: first.firstReferrer,
						at: first.firstTouchAt,
					})
				: null,
			lastTouch: last
				? summarise({
						source: last.lastSource,
						medium: last.lastMedium,
						campaign: last.lastCampaign,
						landing: last.lastLanding,
						referrer: last.lastReferrer,
						at: last.lastTouchAt,
					})
				: null,
		};
	}

	async sources(userId: string): Promise<SourceRow[]> {
		await this.assertCanManage(userId);

		const [views, contacts] = await Promise.all([
			this.db
				.select({
					source: trackedEvent.source,
					medium: trackedEvent.medium,
					count: count(),
				})
				.from(trackedEvent)
				.where(
					and(
						eq(trackedEvent.type, "page_view"),
						isNotNull(trackedEvent.source),
					),
				)
				.groupBy(trackedEvent.source, trackedEvent.medium),
			this.db
				.execute<{
					firstSource: string;
					firstMedium: string | null;
					contacts: string;
				}>(sql`
				SELECT "firstSource", "firstMedium", count(DISTINCT "contactId") AS contacts
				FROM "trackedVisitor"
				WHERE "contactId" IS NOT NULL AND "firstSource" IS NOT NULL
				GROUP BY 1, 2;
			`)
				.then((result) => result.rows),
		]);

		const rows = new Map<string, SourceRow>();

		for (const row of views) {
			if (!row.source) continue;
			const key = `${row.source}|${row.medium ?? ""}`;
			rows.set(key, {
				source: row.source,
				medium: row.medium,
				views: row.count,
				contacts: 0,
			});
		}

		for (const row of contacts) {
			if (!row.firstSource) continue;
			const key = `${row.firstSource}|${row.firstMedium ?? ""}`;
			const existing = rows.get(key);
			const count = Number(row.contacts);

			if (existing) {
				existing.contacts = count;
				continue;
			}

			rows.set(key, {
				source: row.firstSource,
				medium: row.firstMedium,
				views: 0,
				contacts: count,
			});
		}

		return [...rows.values()]
			.sort((a, b) => b.contacts - a.contacts || b.views - a.views)
			.slice(0, 20);
	}

	private async assertCanManage(userId: string): Promise<void> {
		if (!canManageTracking(await this.roleOf(userId))) {
			throw new ForbiddenException(
				"Only an owner or an admin can change tracking.",
			);
		}
	}

	private async roleOf(userId: string): Promise<WorkspaceRole | null> {
		const [membership] = await this.db
			.select({ role: member.role })
			.from(member)
			.where(
				and(eq(member.organizationId, WORKSPACE_ID), eq(member.userId, userId)),
			)
			.limit(1);

		return membership && isWorkspaceRole(membership.role)
			? membership.role
			: null;
	}
}

function summarise(touch: {
	source: string | null;
	medium: string | null;
	campaign: string | null;
	landing: string | null;
	referrer: string | null;
	at: Date | null;
}): TouchSummary | null {
	if (!touch.source) return null;

	return {
		label: describeTouch(touch),
		source: touch.source,
		medium: touch.medium,
		campaign: touch.campaign,
		landing: touch.landing,
		referrer: touch.referrer,
		at: touch.at?.toISOString() ?? null,
	};
}

function scriptUrl(): string {
	return loaderUrl(appUrl);
}

function snippet(siteId: string): string {
	return trackingSnippet(appUrl, siteId);
}

function absolute(input: string): URL | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	try {
		const url = new URL(withScheme);
		return url.hostname.includes(".") ? url : null;
	} catch {
		return null;
	}
}

function mentions(body: string, siteId: string): boolean {
	return body.includes(siteId) && /\/t\/crm\.js/.test(body);
}
