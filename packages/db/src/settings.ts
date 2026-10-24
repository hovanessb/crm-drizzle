import { eq } from "drizzle-orm";
import type { Executor } from "./client";
import {
	DEFAULT_REPORTING_CURRENCY,
	isCurrencyCode,
	normalizeCurrency,
} from "./currency";
import { defaultAgentModel } from "./local-model";
import type { NewAppSetting } from "./schema/models";
import { appSetting } from "./schema/schema";
import {
	type AgentModelSetting,
	DEFAULT_ARCHIVE_RETENTION_DAYS,
	MAX_ARCHIVE_RETENTION_DAYS,
	MIN_ARCHIVE_RETENTION_DAYS,
	SETTINGS_ID,
} from "./settings-shape";

export * from "./settings-shape";

async function readSettings(db: Executor) {
	const [row] = await db
		.select()
		.from(appSetting)
		.where(eq(appSetting.id, SETTINGS_ID))
		.limit(1);
	return row;
}

async function writeSettings(
	db: Executor,
	fields: Omit<Partial<NewAppSetting>, "id">,
): Promise<void> {
	await db
		.insert(appSetting)
		.values({ id: SETTINGS_ID, ...fields })
		.onConflictDoUpdate({ target: appSetting.id, set: fields });
}

export async function readAgentModel(db: Executor): Promise<AgentModelSetting> {
	const row = await readSettings(db);

	const fallback = defaultAgentModel();

	if (!row?.agentModelId) {
		return { ...fallback, isDefault: true };
	}

	return {
		id: row.agentModelId,
		contextWindowTokens:
			row.agentModelContextWindow ?? fallback.contextWindowTokens,
		isDefault: false,
	};
}

export async function writeAgentModel(
	db: Executor,
	model: { id: string; contextWindowTokens: number } | null,
): Promise<void> {
	const fields = {
		agentModelId: model?.id ?? null,
		agentModelContextWindow: model?.contextWindowTokens ?? null,
	};

	await writeSettings(db, fields);
}

export async function readContextDevKey(db: Executor): Promise<string | null> {
	const row = await readSettings(db);

	return row?.contextDevApiKey?.trim() || null;
}

export async function writeContextDevKey(
	db: Executor,
	key: string,
): Promise<void> {
	const contextDevApiKey = key.trim();

	await writeSettings(db, { contextDevApiKey });
}

export async function readReportingCurrency(db: Executor): Promise<string> {
	const row = await readSettings(db);

	const stored = normalizeCurrency(row?.reportingCurrency);

	return isCurrencyCode(stored) ? stored : DEFAULT_REPORTING_CURRENCY;
}

export async function writeReportingCurrency(
	db: Executor,
	code: string,
): Promise<string> {
	const reportingCurrency = normalizeCurrency(code);

	await writeSettings(db, { reportingCurrency });

	return reportingCurrency;
}

export async function readRatesRefreshedAt(db: Executor): Promise<Date | null> {
	const row = await readSettings(db);

	return row?.ratesRefreshedAt ?? null;
}

export async function writeRatesRefreshedAt(
	db: Executor,
	ratesRefreshedAt: Date,
): Promise<void> {
	await writeSettings(db, { ratesRefreshedAt });
}

export async function readArchiveRetentionDays(db: Executor): Promise<number> {
	const row = await readSettings(db);

	return row?.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS;
}

export async function writeArchiveRetentionDays(
	db: Executor,
	days: number,
): Promise<number> {
	const archiveRetentionDays = Math.min(
		Math.max(Math.round(days), MIN_ARCHIVE_RETENTION_DAYS),
		MAX_ARCHIVE_RETENTION_DAYS,
	);

	await writeSettings(db, { archiveRetentionDays });

	return archiveRetentionDays;
}
