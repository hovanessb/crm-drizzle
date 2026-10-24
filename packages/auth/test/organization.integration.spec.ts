import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { and, db, endsWith, eq, member, startsWith, user } from "@crm/db";
import { ensureWorkspaceMembership, WORKSPACE_ID } from "../src/organization";

const suffix = process.env.TEST_RUN_ID ?? "organization-spec";

const emailOf = (label: string) => `${label}.${suffix}@example.test`;

let firstId: string;
let secondId: string;

const seedUser = async (label: string, createdAt: Date): Promise<string> => {
	const [row] = await db
		.insert(user)
		.values({
			id: `${suffix}-${label}`,
			name: label,
			email: emailOf(label),
			createdAt,
			updatedAt: createdAt,
		})
		.returning({ id: user.id });

	if (!row) throw new Error(`Could not seed ${label}.`);
	return row.id;
};

const roleOf = async (userId: string): Promise<string | null> => {
	const [row] = await db
		.select({ role: member.role })
		.from(member)
		.where(
			and(eq(member.organizationId, WORKSPACE_ID), eq(member.userId, userId)),
		);

	return row?.role ?? null;
};

const clear = async () => {
	await db.delete(member).where(startsWith(member.userId, `${suffix}-`));
	await db.delete(user).where(endsWith(user.email, `.${suffix}@example.test`));

	const strangers = await db.$count(
		member,
		eq(member.organizationId, WORKSPACE_ID),
	);

	if (strangers > 0) {
		throw new Error(
			`${strangers} member row(s) this spec did not create are in the workspace, and it needs an empty one to test the owner backfill. It will not delete them: that is somebody's access. Point TEST_DATABASE_URL at a database of your own, or find the spec that leaked them.`,
		);
	}
};

beforeEach(async () => {
	await clear();

	firstId = await seedUser("first", new Date("2020-01-01T00:00:00Z"));
	secondId = await seedUser("second", new Date("2021-01-01T00:00:00Z"));
});

afterAll(clear);

describe("ensureWorkspaceMembership", () => {
	it("creates the one workspace and enrols everyone who already had an account", async () => {
		const workspaceId = await ensureWorkspaceMembership(secondId);

		expect(workspaceId).toBe(WORKSPACE_ID);
		expect(await roleOf(firstId)).toBe("owner");
		expect(await roleOf(secondId)).toBe("member");
	});

	it("is idempotent, so signing in again neither duplicates nor re-roles", async () => {
		await ensureWorkspaceMembership(secondId);

		await db
			.update(member)
			.set({ role: "admin" })
			.where(
				and(
					eq(member.organizationId, WORKSPACE_ID),
					eq(member.userId, secondId),
				),
			);

		await ensureWorkspaceMembership(secondId);
		await ensureWorkspaceMembership(secondId);

		const rows = await db
			.select()
			.from(member)
			.where(
				and(
					eq(member.organizationId, WORKSPACE_ID),
					eq(member.userId, secondId),
				),
			);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("admin");
	});

	it("joins someone who signs up later as a member", async () => {
		await ensureWorkspaceMembership(secondId);

		const laterId = await seedUser("later", new Date("2026-01-01T00:00:00Z"));

		await ensureWorkspaceMembership(laterId);

		expect(await roleOf(laterId)).toBe("member");
	});

	it("leaves the owner alone when a later arrival signs in", async () => {
		await ensureWorkspaceMembership(secondId);

		const laterId = await seedUser("later", new Date("2026-01-01T00:00:00Z"));

		await ensureWorkspaceMembership(laterId);

		expect(await roleOf(firstId)).toBe("owner");

		const owners = await db.$count(
			member,
			and(eq(member.organizationId, WORKSPACE_ID), eq(member.role, "owner")),
		);

		expect(owners).toBe(1);
	});
});
