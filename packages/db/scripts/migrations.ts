import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const MIGRATIONS_FOLDER = join(dirname(import.meta.dirname), "drizzle");

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

type JournalEntry = { idx: number; when: number; tag: string };

export function journal(): JournalEntry[] {
	const raw = readFileSync(
		join(MIGRATIONS_FOLDER, "meta", "_journal.json"),
		"utf8",
	);
	return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

export function migrationHash(tag: string): string {
	const sql = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8");
	return createHash("sha256").update(sql).digest("hex");
}

function legacyPrismaMigrations(): string[] {
	return readFileSync(
		join(MIGRATIONS_FOLDER, "legacy-prisma-migrations.txt"),
		"utf8",
	)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function tableExists(
	client: pg.Client,
	schema: string,
	table: string,
): Promise<boolean> {
	const result = await client.query(
		"SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
		[schema, table],
	);
	return (result.rowCount ?? 0) > 0;
}

export async function appliedHashes(
	client: pg.Client,
): Promise<string[] | null> {
	if (!(await tableExists(client, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE)))
		return null;
	const rows = await client.query<{ hash: string }>(
		`SELECT hash FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ORDER BY created_at`,
	);
	return rows.rows.map((row) => row.hash);
}

async function adoptPrismaDatabase(client: pg.Client): Promise<void> {
	if (!(await tableExists(client, "public", "_prisma_migrations"))) return;
	if ((await appliedHashes(client)) !== null) return;

	const applied = await client.query<{ migration_name: string }>(
		"SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
	);
	const done = new Set(applied.rows.map((row) => row.migration_name));
	const missing = legacyPrismaMigrations().filter((name) => !done.has(name));

	if (missing.length > 0) {
		throw new Error(
			[
				`This database was created by Prisma and is missing ${missing.length} of its migrations, starting with ${missing[0]}.`,
				"The Drizzle baseline equals the schema after the last Prisma migration.",
				"Apply the remaining Prisma migrations from the last Prisma release first, then run this again.",
			].join("\n"),
		);
	}

	const [baseline] = journal();
	if (!baseline)
		throw new Error("drizzle/meta/_journal.json lists no migrations.");
	await client.query("BEGIN");
	try {
		await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
		await client.query(
			`CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
		);
		await client.query(
			`INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at) VALUES ($1, $2)`,
			[migrationHash(baseline.tag), baseline.when],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
	console.log(
		"  adopted the existing Prisma schema as Drizzle migration 0000_baseline",
	);
}

export async function migrateDatabase(url: string): Promise<void> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		await adoptPrismaDatabase(client);
		await migrate(drizzle({ client }), {
			migrationsFolder: MIGRATIONS_FOLDER,
			migrationsSchema: MIGRATIONS_SCHEMA,
			migrationsTable: MIGRATIONS_TABLE,
		});
	} finally {
		await client.end();
	}
}

export function databaseUrl(): string {
	const url =
		process.env.DIRECT_DATABASE_URL ||
		process.env.POSTGRES_URL_NON_POOLING ||
		process.env.DATABASE_URL;
	if (!url) {
		throw new Error(
			"DATABASE_URL is not set. Copy .env.example to .env at the root of the repo and fill it in.",
		);
	}
	return url;
}
