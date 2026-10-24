import {
	and,
	companyEnrichment,
	company as companyTable,
	db,
	EnrichmentStatus,
	eq,
	orNull,
	requireRow,
	whereEq,
} from "@crm/db";
import { mirrorBrandImages } from "./brand-images";
import { brandToUpdate, filledFields, stillFillable } from "./brand-mapping";
import { brandByDomain, contextDevEnabled } from "./context-dev";
import { guardSql, UNLESS_COMPLETE } from "./enrichment";

export type BrandResult = {
	enriched: boolean;
	filled?: string[];
	mirrored?: string[];
	reason?: string;
	retryable?: boolean;
};

export type Spend = (units?: number) => { ok: boolean; reason?: string };

export const FREE: Spend = () => ({ ok: true });

const COMPANY_FIELDS = {
	id: true,
	name: true,
	domain: true,
	description: true,
	logoUrl: true,
	logoDarkUrl: true,
	iconUrl: true,
	iconDarkUrl: true,
	iconTone: true,
	brandColor: true,
	industry: true,
	subIndustry: true,
	city: true,
	stateCode: true,
	country: true,
	countryCode: true,
	phone: true,
	email: true,
	linkedinUrl: true,
	twitterUrl: true,
	githubUrl: true,
	pricingUrl: true,
	careersUrl: true,
} as const;

export async function runBrand({
	companyId,
	fresh = false,
	spend = FREE,
}: {
	companyId: string;
	fresh?: boolean;
	spend?: Spend;
}): Promise<BrandResult> {
	const company = await db.query.company
		.findFirst({
			where: eq(companyTable.id, companyId),
			columns: COMPANY_FIELDS,
		})
		.then(orNull);

	if (!company) return { enriched: false, reason: "No such company." };

	if (!(await contextDevEnabled())) {
		const reason =
			"Context.dev is not configured, so there is nowhere to look.";
		await settle(companyId, EnrichmentStatus.SKIPPED, reason);
		return { enriched: false, reason };
	}

	if (!company.domain) {
		await settle(
			companyId,
			EnrichmentStatus.SKIPPED,
			"No domain to look up.",
			UNLESS_COMPLETE,
		);
		return { enriched: false, reason: "No domain on this company." };
	}

	const charge = spend(2);
	if (!charge.ok) return { enriched: false, reason: charge.reason };

	await db
		.update(companyTable)
		.set({
			enrichmentStatus: EnrichmentStatus.RUNNING,
			enrichmentError: null,
		})
		.where(
			and(
				eq(companyTable.id, companyId),
				guardSql(companyTable, UNLESS_COMPLETE),
			),
		);

	const result = await brandByDomain(company.domain, fresh ? 0 : undefined);

	if (result.outcome === "skipped") {
		await settle(companyId, EnrichmentStatus.SKIPPED, result.reason);
		return { enriched: false, reason: result.reason };
	}

	if (result.outcome === "failed") {
		await settle(companyId, EnrichmentStatus.FAILED, result.reason);
		return {
			enriched: false,
			reason: result.reason,
			retryable: result.retryable,
		};
	}

	const update = brandToUpdate(result.brand, snapshot(company));

	const { mirrored } = await mirrorBrandImages(companyId, update);

	const filled = await db.transaction(async (tx) => {
		const current = await tx.query.company
			.findFirst({
				where: eq(companyTable.id, companyId),
				columns: COMPANY_FIELDS,
			})
			.then(orNull);

		if (!current) return null;

		const data = stillFillable(update, snapshot(current));

		await requireRow(
			tx
				.update(companyTable)
				.set({
					...data,
					enrichmentStatus: EnrichmentStatus.COMPLETE,
					enrichedAt: new Date(),
					enrichmentError: null,
				})
				.where(whereEq(companyTable.id, companyId))
				.returning(),
		);

		await requireRow(
			tx
				.insert(companyEnrichment)
				.values({ companyId, raw: result.raw as object })
				.onConflictDoUpdate({
					target: companyEnrichment.companyId,
					set: { raw: result.raw as object, fetchedAt: new Date() },
				})
				.returning(),
		);

		return filledFields(data);
	});

	if (!filled) return { enriched: false, reason: "No such company." };

	return {
		enriched: true,
		filled,
		mirrored: mirrored.filter((slot) => filled.includes(slot)),
	};
}

function snapshot<T extends { name: string; domain: string | null }>(
	company: T,
) {
	return { ...company, nameIsPlaceholder: company.name === company.domain };
}

export function brandOutcome(result: BrandResult): string {
	if (!result.enriched) return result.reason ?? "Nothing to fill.";

	const filled = result.filled ?? [];
	const mirrored = result.mirrored ?? [];

	if (filled.length === 0) {
		return "Everything Context.dev returned was already on the record.";
	}

	return `Filled ${filled.join(", ")}.${mirrored.length > 0 ? ` Copied ${mirrored.length} image(s) in-house.` : ""}`;
}

type SettleGuard =
	| typeof UNLESS_COMPLETE
	| { enrichmentStatus: EnrichmentStatus };

async function settle(
	companyId: string,
	status: EnrichmentStatus,
	error: string,
	guard: SettleGuard = { enrichmentStatus: EnrichmentStatus.RUNNING },
): Promise<void> {
	await db
		.update(companyTable)
		.set({ enrichmentStatus: status, enrichmentError: error })
		.where(and(eq(companyTable.id, companyId), guardSql(companyTable, guard)));
}
