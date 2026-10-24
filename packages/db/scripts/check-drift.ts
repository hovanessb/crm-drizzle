import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { MIGRATIONS_FOLDER } from "./migrations";

const directory = dirname(import.meta.dirname);

export async function schemaHasUnmigratedChanges(): Promise<boolean> {
	const scratch = mkdtempSync(join(tmpdir(), "crm-drizzle-drift-"));
	try {
		cpSync(MIGRATIONS_FOLDER, scratch, { recursive: true });
		const before = readdirSync(scratch).length;
		const child = Bun.spawn(
			[
				process.execPath,
				"x",
				"drizzle-kit",
				"generate",
				"--dialect",
				"postgresql",
				"--schema",
				"./src/schema/schema.ts",
				"--out",
				relative(directory, scratch),
				"--name",
				"drift",
			],
			{ cwd: directory, env: process.env, stdout: "ignore", stderr: "inherit" },
		);
		const code = await child.exited;
		if (code !== 0) throw new Error(`drizzle-kit generate exited with ${code}`);
		return readdirSync(scratch).length !== before;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	if (await schemaHasUnmigratedChanges()) {
		console.error(
			"src/schema/schema.ts has changes that no migration in drizzle/ covers. Run `bun run db:migrate`.",
		);
		process.exit(1);
	}
	console.log("The schema and the migrations agree.");
}
