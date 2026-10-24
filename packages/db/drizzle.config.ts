import { loadRootEnv } from "@crm/env";

import { defineConfig } from "drizzle-kit";

loadRootEnv();

const url =
	process.env.DIRECT_DATABASE_URL ||
	process.env.POSTGRES_URL_NON_POOLING ||
	process.env.DATABASE_URL;

if (!url) {
	throw new Error(
		"DATABASE_URL is not set. Copy .env.example to .env at the root of the repo and fill it in.",
	);
}

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema/schema.ts",
	out: "./drizzle",
	dbCredentials: { url },
	strict: true,
	verbose: true,
});
