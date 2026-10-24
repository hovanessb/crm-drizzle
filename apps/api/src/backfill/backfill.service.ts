import { onSignedIn } from "@crm/auth/signed-in";
import {
	agentTask,
	and,
	asc,
	company,
	contact,
	type Db,
	deal,
	EnrichmentStatus,
	eq,
	exists,
	gte,
	inArray,
	isNotNull,
	isNull,
	notInArray,
	or,
	type SQL,
} from "@crm/db";
import { PRIORITY } from "@crm/db/agent-tasks";
import { readWorkspaceIdentity } from "@crm/db/workspace";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Cache } from "cache-manager";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { FaviconService } from "../companies/favicon.service";
import { InjectDatabase } from "../database/database.constants";
import { ImageMirrorService } from "./image-mirror.service";

export type BackfillScope = "companies" | "contacts" | "deals";

export type BackfillResult = {
	queued: number;
	alreadyQueued: number;
	remaining: number;
	iconsResolving: number;
};

const MAX_PER_RUN = 500;

const MAX_FAVICONS = 25;

const NEVER_SUCCEEDED = [EnrichmentStatus.PENDING, EnrichmentStatus.FAILED];

const AUTO_KEY = "backfill:auto";

const AUTO_EVERY_MS = 5 * 60_000;

/**
 * How long a fruitless photo search stands the contact down for.
 *
 * Long, because the answer rarely changes: somebody with no LinkedIn account
 * and no headshot on their employer's site is unlikely to acquire either this
 * week, and the team-page read costs credits every time it is asked.
 */
const RECHECK_PHOTO_AFTER_MS = 30 * 24 * 60 * 60_000;

const RECHECK_BRAND_AFTER_MS = 30 * 24 * 60 * 60_000;

const RECHECK_WORKSPACE_AFTER_MS = 7 * 24 * 60 * 60_000;

@Injectable()
export class BackfillService implements OnModuleInit {
	private readonly logger = new Logger(BackfillService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
		private readonly favicon: FaviconService,
		private readonly images: ImageMirrorService,
		@Inject(CACHE_MANAGER) private readonly cache: Cache,
	) {}

	onModuleInit(): void {
		onSignedIn(() => {
			void this.auto();
		});
	}

	async auto(): Promise<{ started: boolean }> {
		if (await this.cache.get(AUTO_KEY)) return { started: false };
		await this.cache.set(AUTO_KEY, true, AUTO_EVERY_MS);

		void (async () => {
			try {
				await this.sweepWorkspace();

				const companies = await this.runCompanies(false);
				const contacts = await this.runContacts();

				const mirrored = await this.images.sweep();

				this.logger.log({
					message: "Automatic backfill swept",
					queued: companies.queued + contacts.queued,
					remaining: companies.remaining + contacts.remaining,
					iconsResolving: companies.iconsResolving,
					imagesMirrored: mirrored.copied,
				});
			} catch (error) {
				this.logger.error(
					{ message: "Automatic backfill failed" },
					error instanceof Error ? error.stack : String(error),
				);
			}
		})();

		return { started: true };
	}

	private async sweepWorkspace(): Promise<void> {
		const us = await readWorkspaceIdentity(this.db);

		if (!us?.website || us.profile) return;

		const [attempted] = await this.db
			.select({ id: agentTask.id })
			.from(agentTask)
			.where(
				and(
					eq(agentTask.kind, "workspace-profile"),
					gte(
						agentTask.finishedAt,
						new Date(Date.now() - RECHECK_WORKSPACE_AFTER_MS),
					),
				),
			)
			.limit(1);

		if (attempted) return;

		await this.agent.workspaceChanged(
			us.website,
			"We still have no profile of the company using this CRM",
		);
	}

	async run(scope: BackfillScope): Promise<BackfillResult> {
		if (scope === "contacts") return this.runContacts();

		return this.runCompanies(scope === "deals");
	}

	private async runCompanies(dealsOnly: boolean): Promise<BackfillResult> {
		const onDeals = dealsOnly
			? exists(
					this.db
						.select({ id: deal.id })
						.from(deal)
						.where(eq(deal.companyId, company.id)),
				)
			: undefined;

		const needsBrand = this.companiesNeedingBrand();
		const needsArtwork = await this.companiesNeedingArtwork();

		const [total, rows, artworkRows] = await Promise.all([
			this.db.$count(company, and(onDeals, or(needsBrand, needsArtwork))),
			this.db
				.select({ id: company.id })
				.from(company)
				.where(and(needsBrand, onDeals))
				.orderBy(asc(company.createdAt))
				.limit(MAX_PER_RUN),
			this.db
				.select({ id: company.id })
				.from(company)
				.where(and(needsArtwork, onDeals))
				.orderBy(asc(company.createdAt))
				.limit(MAX_PER_RUN),
		]);

		const companyIds = [
			...new Set([
				...rows.map((row) => row.id),
				...artworkRows.map((row) => row.id),
			]),
		].slice(0, MAX_PER_RUN);

		const brand = await this.agent.backfill({
			kind: "brand",
			reason: "Backfill — this company has no logo or icon",
			companyIds,
			budget: 2,
			priority: PRIORITY.brand,
		});

		const profile = await this.agent.backfill({
			kind: "company-profile",
			reason: "Backfill — this company was never successfully looked up",
			companyIds: rows.map((row) => row.id),
		});

		const queued = {
			queued: brand.queued + profile.queued,
			alreadyQueued: brand.alreadyQueued + profile.alreadyQueued,
		};

		const iconsResolving = dealsOnly ? 0 : await this.sweepFavicons();

		return {
			...queued,
			remaining: Math.max(0, total - companyIds.length),
			iconsResolving,
		};
	}

	private async runContacts(): Promise<BackfillResult> {
		const needsPhoto = await this.contactsNeedingPhoto();

		const [photoTotal, photoRows] = await Promise.all([
			this.db.$count(contact, needsPhoto),
			this.db
				.select({ id: contact.id })
				.from(contact)
				.where(needsPhoto)
				.orderBy(asc(contact.createdAt))
				.limit(MAX_PER_RUN),
		]);

		const photos = await this.agent.backfill({
			kind: "portrait",
			reason: "Backfill — somewhere to look for a picture, and no picture",
			contactIds: photoRows.map((row) => row.id),
			budget: 1,
			priority: PRIORITY.portrait,
		});

		const headroom = MAX_PER_RUN - photoRows.length;

		const [researchTotal, researchRows] = await Promise.all([
			this.db.$count(contact, this.contactsNeverResearched()),
			headroom > 0
				? this.db
						.select({ id: contact.id })
						.from(contact)
						.where(this.contactsNeverResearched())
						.orderBy(asc(contact.createdAt))
						.limit(headroom)
				: Promise.resolve([]),
		]);

		const research = await this.agent.backfill({
			kind: "identify",
			reason: "Backfill — this contact was never researched",
			contactIds: researchRows.map((row) => row.id),
		});

		return {
			queued: photos.queued + research.queued,
			alreadyQueued: photos.alreadyQueued + research.alreadyQueued,
			remaining:
				Math.max(0, photoTotal - photoRows.length) +
				Math.max(0, researchTotal - researchRows.length),
			iconsResolving: 0,
		};
	}

	private async sweepFavicons(): Promise<number> {
		const rows = await this.db
			.select({ id: company.id, domain: company.domain })
			.from(company)
			.where(and(isNotNull(company.domain), isNull(company.iconUrl)))
			.orderBy(asc(company.createdAt))
			.limit(MAX_FAVICONS);

		if (rows.length === 0) return 0;

		void (async () => {
			let resolved = 0;
			for (const row of rows) {
				if (await this.favicon.backfill(row.id, row.domain)) resolved += 1;
			}
			this.logger.log({
				message: "Favicon sweep finished",
				attempted: rows.length,
				resolved,
			});
		})();

		return rows.length;
	}

	private companiesNeedingBrand(): SQL | undefined {
		return and(
			isNotNull(company.domain),
			inArray(company.enrichmentStatus, NEVER_SUCCEEDED),
		);
	}

	private async companiesNeedingArtwork(): Promise<SQL | undefined> {
		const since = new Date(Date.now() - RECHECK_BRAND_AFTER_MS);

		const checked = await this.db
			.select({ companyId: agentTask.companyId })
			.from(agentTask)
			.where(
				and(eq(agentTask.kind, "brand"), gte(agentTask.finishedAt, since)),
			);

		const recentlyChecked = checked
			.map((row) => row.companyId)
			.filter((id): id is string => id !== null);

		return and(
			isNotNull(company.domain),
			isNull(company.logoUrl),
			isNull(company.iconUrl),
			recentlyChecked.length > 0
				? notInArray(company.id, recentlyChecked)
				: undefined,
		);
	}

	/**
	 * Contacts with a face to fetch and nowhere it has been put yet.
	 *
	 * Three doors qualify, matching the agent's chain: a LinkedIn URL, a GitHub
	 * URL, or an employer with a website. The third is the expensive one — it
	 * spends Context.dev credits reading the company's team page — and it is in
	 * here because it works, which is the only reason worth having.
	 *
	 * Which makes the exclusion below load-bearing rather than an optimisation.
	 * Most people are not on their employer's team page and never will be, so
	 * without it every sweep would pay to re-read the same forty sites and find
	 * the same nothing, for as long as the install runs. A finished `portrait`
	 * task is the record that we looked; a month is long enough that a rebuilt
	 * team page or a new LinkedIn account is still picked up eventually.
	 */
	private async contactsNeedingPhoto(): Promise<SQL | undefined> {
		const since = new Date(Date.now() - RECHECK_PHOTO_AFTER_MS);

		const checked = await this.db
			.select({ contactId: agentTask.contactId })
			.from(agentTask)
			.where(
				and(eq(agentTask.kind, "portrait"), gte(agentTask.finishedAt, since)),
			);

		const recentlyChecked = checked
			.map((row) => row.contactId)
			.filter((id): id is string => id !== null);

		return and(
			isNull(contact.imageUrl),
			or(
				isNotNull(contact.linkedinUrl),
				isNotNull(contact.githubUrl),
				inArray(
					contact.companyId,
					this.db
						.select({ id: company.id })
						.from(company)
						.where(isNotNull(company.domain)),
				),
			),
			recentlyChecked.length > 0
				? notInArray(contact.id, recentlyChecked)
				: undefined,
		);
	}

	private contactsNeverResearched(): SQL {
		return inArray(contact.enrichmentStatus, NEVER_SUCCEEDED);
	}
}
