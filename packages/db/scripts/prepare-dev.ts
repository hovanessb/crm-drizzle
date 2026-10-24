import { join } from "node:path";
import { loadRootEnv } from "@crm/env";
import { schemaHasUnmigratedChanges } from "./check-drift";
import { databaseUrl, migrateDatabase } from "./migrations";

loadRootEnv();

const directory = join(import.meta.dir, "..");

const guard = Bun.spawn(
	[process.execPath, "scripts/require-local-db.ts", "dev"],
	{
		cwd: directory,
		env: process.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);
const guardCode = await guard.exited;
if (guardCode !== 0) process.exit(guardCode);

await migrateDatabase(databaseUrl());

if (await schemaHasUnmigratedChanges()) {
	console.error(
		"src/schema/schema.ts has changes that no migration covers. Create one with `bun run db:migrate` before starting dev.",
	);
	process.exit(1);
}

console.log("Database migrations are applied and match the Drizzle schema.");
