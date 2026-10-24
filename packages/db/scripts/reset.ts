import { loadRootEnv } from "@crm/env";
import pg from "pg";
import { databaseUrl, migrateDatabase } from "./migrations";

loadRootEnv();

const url = databaseUrl();
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
	await client.query('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
	await client.query("DROP SCHEMA IF EXISTS public CASCADE");
	await client.query("CREATE SCHEMA public");
} finally {
	await client.end();
}

await migrateDatabase(url);
console.log("Database reset and migrated.");

if (!process.argv.includes("--skip-seed")) {
	const seed = Bun.spawn([process.execPath, "scripts/seed.ts"], {
		cwd: `${import.meta.dir}/..`,
		env: process.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(await seed.exited);
}
