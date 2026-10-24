import { eq } from "drizzle-orm";
import type { Executor } from "./client";
import {
	type JsonValue,
	jsonObject,
	jsonText,
	type WorkspaceProfileSections,
} from "./json";
import { organization, workspaceProfile } from "./schema/schema";
import {
	clamp,
	MAX_NARRATIVE,
	profileOf,
	trimSections,
	WORKSPACE_ID,
	type WorkspaceIdentity,
	type WorkspaceProfile,
} from "./workspace-shape";

export * from "./workspace-shape";

const PROFILE_COLUMNS = {
	website: workspaceProfile.website,
	narrative: workspaceProfile.narrative,
	sections: workspaceProfile.sections,
	sourceUrl: workspaceProfile.sourceUrl,
	refreshedAt: workspaceProfile.refreshedAt,
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

function readSections(value: JsonValue): WorkspaceProfileSections {
	const record = jsonObject(value);
	const text = (key: string) => jsonText(record[key])?.trim() || undefined;

	return trimSections({
		sells: text("sells"),
		sellsTo: text("sellsTo"),
		edge: text("edge"),
	});
}
