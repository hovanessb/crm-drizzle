import "@crm/env/load";

import { createHash } from "node:crypto";
import {
	db,
	eq,
	gt,
	install,
	sql,
	telemetryCounter,
	telemetryMilestone,
} from "@crm/db";
import { crmVersion } from "./version";

export const INSTALL_ID = "install";

export type Install = {
	uuid: string;
	version: string;
	createdAt: Date;
	lastRollupAt: Date | null;
};

const FIELDS = {
	uuid: install.uuid,
	version: install.version,
	createdAt: install.createdAt,
	lastRollupAt: install.lastRollupAt,
};

let cached: Install | null = null;

const MISSING_FOR_MS = 30_000;

let missingSince = 0;

export async function readInstall(): Promise<Install | null> {
	if (cached) return cached;
	if (missingSince && Date.now() - missingSince < MISSING_FOR_MS) return null;

	try {
		const [row] = await db
			.select(FIELDS)
			.from(install)
			.where(eq(install.id, INSTALL_ID))
			.limit(1);

		if (row) cached = row;
		missingSince = row ? 0 : Date.now();

		return row ?? null;
	} catch {
		missingSince = Date.now();
		return null;
	}
}

export function forgetInstall(): void {
	cached = null;
	missingSince = 0;
}

export async function syncVersion(
	version = crmVersion(),
): Promise<Install | null> {
	if (!version) return readInstall();

	try {
		const [row] = await db
			.update(install)
			.set({ version })
			.where(eq(install.id, INSTALL_ID))
			.returning(FIELDS);
		if (!row) return readInstall();

		cached = row;
		missingSince = 0;

		return row;
	} catch {
		return readInstall();
	}
}

export const MILESTONES = [
	"migrations_applied",
	"first_sign_in",
	"google_oauth_configured",
	"first_mailbox_sync",
	"first_non_seed_contact",
	"first_agent_task_claimed",
	"first_agent_task_completed",
	"first_fact_applied",
] as const;

export type Milestone = (typeof MILESTONES)[number];

export async function reachMilestone(step: Milestone): Promise<boolean> {
	try {
		const inserted = await db
			.insert(telemetryMilestone)
			.values({ step })
			.onConflictDoNothing()
			.returning({ step: telemetryMilestone.step });

		return inserted.length === 1;
	} catch {
		return false;
	}
}

export async function forgetMilestone(step: Milestone): Promise<void> {
	try {
		await db
			.delete(telemetryMilestone)
			.where(eq(telemetryMilestone.step, step));
	} catch {}
}

export async function reachedMilestones(): Promise<Milestone[]> {
	try {
		const rows = await db
			.select({ step: telemetryMilestone.step })
			.from(telemetryMilestone);

		const reached = new Set(rows.map((row) => row.step));
		return MILESTONES.filter((step) => reached.has(step));
	} catch {
		return [];
	}
}

export const COUNTERS = {
	budgetExhausted: "budget_exhausted",
} as const;

export async function bumpCounter(name: string, by = 1): Promise<void> {
	try {
		await db
			.insert(telemetryCounter)
			.values({ name, count: by })
			.onConflictDoUpdate({
				target: telemetryCounter.name,
				set: { count: sql`${telemetryCounter.count} + ${by}` },
			});
	} catch {
		try {
			await db
				.update(telemetryCounter)
				.set({ count: sql`${telemetryCounter.count} + ${by}` })
				.where(eq(telemetryCounter.name, name));
		} catch {}
	}
}

export async function drainCounters(): Promise<Record<string, number>> {
	try {
		const rows = await db
			.delete(telemetryCounter)
			.where(gt(telemetryCounter.count, 0))
			.returning({
				name: telemetryCounter.name,
				count: telemetryCounter.count,
			});

		return Object.fromEntries(rows.map((row) => [row.name, row.count]));
	} catch {
		return {};
	}
}

export async function restoreCounters(
	counts: Record<string, number>,
): Promise<void> {
	for (const [name, count] of Object.entries(counts)) {
		if (count > 0) await bumpCounter(name, count);
	}
}

export type RollupRefusal = "no install row" | "already sent today" | "failed";

export type RollupClaim =
	| { claimed: true; previous: Date | null }
	| { claimed: false; reason: RollupRefusal };

export async function claimRollup(
	at: Date,
	force = false,
): Promise<RollupClaim> {
	try {
		return await db.transaction(async (tx): Promise<RollupClaim> => {
			const locked = await tx
				.select({ lastRollupAt: install.lastRollupAt })
				.from(install)
				.where(eq(install.id, INSTALL_ID))
				.for("update");

			if (locked.length === 0) {
				return { claimed: false, reason: "no install row" };
			}

			const previous = locked[0]?.lastRollupAt ?? null;
			if (!force && sameUtcDay(previous, at)) {
				return { claimed: false, reason: "already sent today" };
			}

			const [row] = await tx
				.update(install)
				.set({ lastRollupAt: at })
				.where(eq(install.id, INSTALL_ID))
				.returning(FIELDS);
			cached = row ?? null;

			return { claimed: true, previous };
		});
	} catch {
		return { claimed: false, reason: "failed" };
	}
}

export async function releaseRollup(previous: Date | null): Promise<void> {
	try {
		const [row] = await db
			.update(install)
			.set({ lastRollupAt: previous })
			.where(eq(install.id, INSTALL_ID))
			.returning(FIELDS);
		cached = row ?? null;
	} catch {}
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysSince(from: Date, now = new Date()): number {
	return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

export function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10);
}

export function stableUuid(...parts: string[]): string {
	const digest = createHash("sha256").update(parts.join(":")).digest();
	const bytes = Uint8Array.from(digest.subarray(0, 16));

	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

	const hex = Buffer.from(bytes).toString("hex");

	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32),
	].join("-");
}

export function sameUtcDay(a: Date | null, b: Date): boolean {
	if (!a) return false;

	return (
		a.getUTCFullYear() === b.getUTCFullYear() &&
		a.getUTCMonth() === b.getUTCMonth() &&
		a.getUTCDate() === b.getUTCDate()
	);
}
