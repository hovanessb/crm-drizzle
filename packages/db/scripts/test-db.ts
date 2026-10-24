import pg from "pg";
import {
	appliedHashes,
	journal,
	migrateDatabase,
	migrationHash,
} from "./migrations";

const url = resolve();

if (!url) {
	fail([
		"Neither TEST_DATABASE_URL nor DATABASE_URL is set.",
		"Copy .env.example to .env at the repo root.",
	]);
}

const name = databaseName(url);

if (!name.endsWith("_test")) {
	fail([
		`TEST_DATABASE_URL names "${name}", which does not end in _test.`,
		"The suite refuses anything else, because it deletes rows it expects to",
		"put back and an interrupted run leaves them deleted.",
	]);
}

await create(url, name, process.argv.includes("--reset"));
await migrateDatabase(url);

if (!process.env.TEST_DATABASE_URL) {
	console.log(
		[
			"",
			"  Add this to .env so the suite finds it:",
			"",
			`    TEST_DATABASE_URL="${url}"`,
			"",
		].join("\n"),
	);
}

async function create(
	target: string,
	database: string,
	forced: boolean,
): Promise<void> {
	const maintenance = new URL(target);
	maintenance.pathname = "/postgres";
	maintenance.search = "";

	const client = new pg.Client({ connectionString: maintenance.toString() });

	try {
		await client.connect();
	} catch (error) {
		fail([
			`Could not reach the server at ${new URL(target).host}.`,
			"Is Postgres running?  docker compose up -d",
			"",
			error instanceof Error ? error.message : String(error),
		]);
	}

	try {
		const existing = await client.query(
			"SELECT 1 FROM pg_database WHERE datname = $1",
			[database],
		);

		if (existing.rowCount) {
			const reason = forced
				? "you asked for --reset"
				: await stale(target, database);

			if (!reason) {
				console.log(`  ${database} already exists`);
				return;
			}

			console.log(`  rebuilding ${database}: ${reason}`);
			await drop(client, database);
		}

		await client.query(`CREATE DATABASE "${database}"`);
		console.log(`  created ${database}`);
	} finally {
		await client.end();
	}
}

async function drop(client: pg.Client, database: string): Promise<void> {
	await client.query(
		`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
		 WHERE datname = $1 AND pid <> pg_backend_pid()`,
		[database],
	);
	await client.query(`DROP DATABASE IF EXISTS "${database}"`);
}

async function stale(target: string, database: string): Promise<string | null> {
	const client = new pg.Client({ connectionString: target });

	try {
		await client.connect();
	} catch {
		return null;
	}

	try {
		const applied = await appliedHashes(client);
		if (applied === null) return null;

		const onDisk = journal().map((entry) => migrationHash(entry.tag));
		const known = new Set(onDisk);
		const foreign = applied.filter((hash) => !known.has(hash));

		if (foreign.length > 0) {
			return `${database} holds ${foreign.length} migration(s) this branch does not have`;
		}

		const changed = applied.some((hash, index) => onDisk[index] !== hash);
		return changed
			? `${database} was migrated from different migration files`
			: null;
	} finally {
		await client.end();
	}
}

function resolve(): string | null {
	const explicit = process.env.TEST_DATABASE_URL;
	if (explicit) return explicit;

	const live = process.env.DATABASE_URL;
	if (!live) return null;

	try {
		const parsed = new URL(live);
		const database = parsed.pathname.replace(/^\//, "");
		if (!database) return null;

		parsed.pathname = `/${database.endsWith("_test") ? database : `${database}_test`}`;

		return parsed.toString();
	} catch {
		return null;
	}
}

function databaseName(value: string): string {
	try {
		return new URL(value).pathname.replace(/^\//, "");
	} catch {
		return value;
	}
}

function fail(lines: string[]): never {
	console.error(["", ...lines.map((line) => `  ${line}`), ""].join("\n"));
	process.exit(1);
}
