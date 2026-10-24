import { sql } from "drizzle-orm";
import type { Executor } from "./client";

export async function lockIdempotencyKey(
	tx: Executor,
	key: string,
): Promise<void> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS locked`,
	);
}

export async function lockIdempotencyKeys(
	tx: Executor,
	keys: string[],
): Promise<void> {
	const ordered = [...new Set(keys)].sort();
	if (ordered.length === 0) return;

	await tx.execute(sql`
		SELECT pg_advisory_xact_lock(hashtextextended(requested.key, 0)) IS NULL AS locked
		FROM (
			VALUES ${sql.join(
				ordered.map((key) => sql`(${key})`),
				sql`, `,
			)}
		) AS requested(key)
		ORDER BY requested.key
	`);
}
