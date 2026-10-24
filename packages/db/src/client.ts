import "@crm/env/load";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import pg, { Pool } from "pg";
import * as schema from "./schema/schema";

pg.defaults.parseInputDatesAsUTC = true;

const connectionString =
	process.env.NODE_ENV === "test" ? testDatabase() : liveDatabase();

function liveDatabase(): string {
	const url = process.env.DATABASE_URL;

	if (!url) {
		throw new Error(
			"DATABASE_URL is not set. Copy .env.example to .env at the root of the repo and fill it in, or set DATABASE_URL in the environment.",
		);
	}

	return url;
}

function testDatabase(): string {
	const url = process.env.TEST_DATABASE_URL;

	if (!url) {
		throw new Error(
			[
				"TEST_DATABASE_URL is not set, and the suite will not fall back to DATABASE_URL.",
				"",
				"These are real integration tests. They delete every workspace member and the",
				"organization row and put them back when the run finishes — so a run that is",
				"interrupted leaves everybody locked out of whatever database it was pointed at.",
				"The pre-push hook runs them, so that is one `git push` away from a database you",
				"care about.",
				"",
				"Make a throwaway one and point TEST_DATABASE_URL at it:",
				"",
				"    bun run db:test",
				"",
			].join("\n"),
		);
	}

	if (!databaseName(url).endsWith("_test")) {
		throw new Error(
			`TEST_DATABASE_URL must name a database ending in _test, so it cannot be one somebody is using. It names "${databaseName(url)}".`,
		);
	}

	return url;
}

function databaseName(url: string): string {
	try {
		return new URL(url).pathname.replace(/^\//, "");
	} catch {
		return url;
	}
}

export type DbLogLevel = "query" | "info" | "warn" | "error";

export interface DbLogRecord {
	level: DbLogLevel;
	message: string;
	target: string;
	durationMs?: number;
}

export type DbLogSink = (record: DbLogRecord) => void;

const consoleSink: DbLogSink = ({ level, message, target, durationMs }) => {
	const suffix = durationMs === undefined ? "" : ` (+${durationMs}ms)`;
	const line = `[db:${level}] ${message}${suffix} [${target}]`;

	if (level === "error") {
		console.error(line);
	} else if (level === "warn") {
		console.warn(line);
	} else {
		console.log(line);
	}
};

let sink: DbLogSink = consoleSink;

export function setDbLogSink(next: DbLogSink | null): void {
	sink = next ?? consoleSink;
}

const logQueries = process.env.DB_LOG_QUERIES === "true";

type Schema = typeof schema;

class ReopeningPool extends Pool {
	override async end(): Promise<void> {
		if (this.ending) return;
		await super.end();
		Object.assign(this, { ending: false, ended: false });
	}
}

const createDb = () => {
	const pool = new ReopeningPool({ connectionString });

	pool.on("error", (error) => {
		sink({ level: "error", message: error.message, target: "pg.pool" });
	});

	return drizzle({
		client: pool,
		schema,
		logger: logQueries
			? {
					logQuery(query) {
						sink({ level: "query", message: query, target: "drizzle" });
					},
				}
			: false,
	});
};

declare global {
	var crmDb: (NodePgDatabase<Schema> & { $client: Pool }) | undefined;
}

export const db = globalThis.crmDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
	globalThis.crmDb = db;
}

export type Db = typeof db;

export type Tx = PgTransaction<
	NodePgQueryResultHKT,
	Schema,
	ExtractTablesWithRelations<Schema>
>;

export type Executor = Db | Tx;
