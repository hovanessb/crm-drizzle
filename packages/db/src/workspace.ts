import { eq } from "drizzle-orm";
import type { Executor } from "./client";
import {
	type JsonObject,
	type JsonValue,
	jsonObject,
	jsonText,
	type WorkspaceProfileSections,
} from "./json";
import { organization, workspaceProfile } from "./schema/schema";

export const WORKSPACE_ID = "workspace";

const PROFILE_COLUMNS = {
	website: workspaceProfile.website,
	narrative: workspaceProfile.narrative,
	sections: workspaceProfile.sections,
	sourceUrl: workspaceProfile.sourceUrl,
	refreshedAt: workspaceProfile.refreshedAt,
};

export const DEFAULT_WORKSPACE_SLUG = "workspace";

export const MAX_SLUG = 48;

export const RESERVED_SLUGS: readonly string[] = [
	"_next",
	"api",
	"agent",
	"agents",
	"chat",
	"companies",
	"contacts",
	"deals",
	"eve",
	"grant-access",
	"onboarding",
	"settings",
	"sign-in",
];

export function workspaceSlug(name: string): string {
	const base = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_SLUG)
		.replace(/^-+|-+$/g, "");

	if (!base) return DEFAULT_WORKSPACE_SLUG;

	return RESERVED_SLUGS.includes(base) ? `${base}-crm` : base;
}

export const MAX_NARRATIVE = 320;

export const MAX_LINE = 140;

export function isOnboarded(metadata: string | null): boolean {
	return jsonText(readMetadata(metadata).onboardedAt) !== undefined;
}

export function markOnboarded(metadata: string | null, at: Date): string {
	const current = readMetadata(metadata);

	return JSON.stringify(
		jsonText(current.onboardedAt) === undefined
			? { ...current, onboardedAt: at.toISOString() }
			: current,
	);
}

function readMetadata(metadata: string | null): JsonObject {
	if (!metadata) return {};

	try {
		const parsed: JsonValue = JSON.parse(metadata);

		return jsonObject(parsed);
	} catch {
		return {};
	}
}

export type WorkspaceProfile = {
	website: string;
	narrative: string;
	sections: WorkspaceProfileSections;
	sourceUrl: string | null;
	refreshedAt: Date;
};

export type WorkspaceIdentity = {
	name: string;
	website: string | null;
	profile: WorkspaceProfile | null;
};

export async function readWorkspaceProfile(
	db: Executor,
): Promise<WorkspaceProfile | null> {
	const [row] = await db
		.select(PROFILE_COLUMNS)
		.from(workspaceProfile)
		.where(eq(workspaceProfile.id, WORKSPACE_ID))
		.limit(1);

	if (!row) return null;

	return { ...row, sections: readSections(row.sections) };
}

export function websiteUrl(website: string | null | undefined): string | null {
	const trimmed = website?.trim();
	if (!trimmed) return null;

	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1];
	if (scheme && !/^https?$/i.test(scheme)) return null;

	let url: URL;
	try {
		url = new URL(scheme ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}

	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname)) return null;

	const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");

	return `${url.protocol}//${url.hostname}${path}`;
}

export function profileOf(
	profile: WorkspaceProfile | null,
	website: string | null,
): WorkspaceProfile | null {
	if (!profile || !website || profile.website !== website) return null;

	return profile;
}

export async function readWorkspaceIdentity(
	db: Executor,
): Promise<WorkspaceIdentity | null> {
	const [workspace, profile] = await Promise.all([
		db
			.select({ name: organization.name, website: organization.website })
			.from(organization)
			.where(eq(organization.id, WORKSPACE_ID))
			.limit(1)
			.then((rows) => rows[0]),
		readWorkspaceProfile(db),
	]);

	if (!workspace) return null;

	return {
		name: workspace.name,
		website: workspace.website,
		profile: profileOf(profile, workspace.website),
	};
}

export async function writeWorkspaceProfile(
	db: Executor,
	input: {
		website: string;
		narrative: string;
		sections: WorkspaceProfileSections;
		sourceUrl?: string | null;
		sessionId?: string | null;
	},
): Promise<WorkspaceProfile> {
	const fields = {
		website: input.website,
		narrative: clamp(input.narrative, MAX_NARRATIVE) ?? "",
		sections: trimSections(input.sections),
		sourceUrl: input.sourceUrl ?? null,
		sessionId: input.sessionId ?? null,
		refreshedAt: new Date(),
	};

	const [row] = await db
		.insert(workspaceProfile)
		.values({ id: WORKSPACE_ID, ...fields })
		.onConflictDoUpdate({ target: workspaceProfile.id, set: fields })
		.returning(PROFILE_COLUMNS);

	if (!row) throw new Error("The workspace profile upsert returned no row.");

	return { ...row, sections: readSections(row.sections) };
}

export function trimSections(
	sections: WorkspaceProfileSections,
): WorkspaceProfileSections {
	const trimmed: WorkspaceProfileSections = {};

	const sells = clamp(sections.sells, MAX_LINE);
	if (sells) trimmed.sells = sells;

	const sellsTo = clamp(sections.sellsTo, MAX_LINE);
	if (sellsTo) trimmed.sellsTo = sellsTo;

	const edge = clamp(sections.edge, MAX_LINE);
	if (edge) trimmed.edge = edge;

	return trimmed;
}

function clamp(value: string | undefined, max: number): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function readSections(value: JsonValue): WorkspaceProfileSections {
	const record = jsonObject(value);
	const text = (key: string) => jsonText(record[key])?.trim() || undefined;

	return trimSections({
		sells: text("sells"),
		sellsTo: text("sellsTo"),
		edge: text("edge"),
	});
}
