import {
	and,
	asc,
	db,
	type Executor,
	eq,
	member,
	organization,
	user,
} from "@crm/db";
import { WORKSPACE_ID, workspaceSlug } from "@crm/db/workspace";

export { WORKSPACE_ID };

export const DEFAULT_WORKSPACE_NAME = "CRM";

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: string): value is WorkspaceRole {
	return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function isWorkspaceAdmin(role: WorkspaceRole | null): boolean {
	return role === "owner" || role === "admin";
}

export function canRenameWorkspace(role: WorkspaceRole | null): boolean {
	return isWorkspaceAdmin(role);
}

export function canChangeRole(role: WorkspaceRole | null): boolean {
	return isWorkspaceAdmin(role);
}

export function canManageCurrency(role: WorkspaceRole | null): boolean {
	return isWorkspaceAdmin(role);
}

export function canManageConnections(role: WorkspaceRole | null): boolean {
	return isWorkspaceAdmin(role);
}

export function canManageTracking(role: WorkspaceRole | null): boolean {
	return isWorkspaceAdmin(role);
}

export async function ensureWorkspaceMembership(
	userId: string,
): Promise<string | undefined> {
	try {
		return await db.transaction(async (tx) => {
			await tx
				.insert(organization)
				.values({
					id: WORKSPACE_ID,
					name: DEFAULT_WORKSPACE_NAME,
					slug: workspaceSlug(DEFAULT_WORKSPACE_NAME),
					createdAt: new Date(),
				})
				.onConflictDoNothing({ target: organization.id });

			const [workspace] = await tx
				.select({
					id: organization.id,
					name: organization.name,
					slug: organization.slug,
				})
				.from(organization)
				.where(eq(organization.id, WORKSPACE_ID))
				.limit(1);
			if (!workspace)
				throw new Error(`Workspace ${WORKSPACE_ID} is missing after insert.`);

			const slug = workspaceSlug(workspace.name);

			if (workspace.slug !== slug) {
				await tx
					.update(organization)
					.set({ slug })
					.where(eq(organization.id, workspace.id));
			}

			const enrolled = await tx.$count(
				member,
				eq(member.organizationId, workspace.id),
			);

			if (enrolled === 0) {
				const existing = await tx
					.select({ id: user.id })
					.from(user)
					.orderBy(asc(user.createdAt), asc(user.id));

				if (existing.length > 0) {
					await tx
						.insert(member)
						.values(
							existing.map((row, index) => ({
								id: crypto.randomUUID(),
								organizationId: workspace.id,
								userId: row.id,
								role: index === 0 ? "owner" : "member",
								createdAt: new Date(),
							})),
						)
						.onConflictDoNothing();
				}
			}

			await tx
				.insert(member)
				.values({
					id: crypto.randomUUID(),
					organizationId: workspace.id,
					userId,
					role: "member",
					createdAt: new Date(),
				})
				.onConflictDoNothing({
					target: [member.organizationId, member.userId],
				});

			return workspace.id;
		});
	} catch (error) {
		console.error(
			`[auth] could not enrol user ${userId} in workspace ${WORKSPACE_ID}; the next sign-in will retry`,
			error,
		);
		return undefined;
	}
}

export function toWorkspaceRole(value: string): WorkspaceRole {
	return isWorkspaceRole(value) ? value : "member";
}

export type WorkspaceMemberReader = Executor;

export async function workspaceRoleOf(
	userId: string,
	client: WorkspaceMemberReader = db,
): Promise<WorkspaceRole | null> {
	const [row] = await client
		.select({ role: member.role })
		.from(member)
		.where(
			and(eq(member.organizationId, WORKSPACE_ID), eq(member.userId, userId)),
		)
		.limit(1);

	return row ? toWorkspaceRole(row.role) : null;
}
