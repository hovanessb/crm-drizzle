export const SETTINGS_ID = "app";

export const DEFAULT_AGENT_MODEL = {
	id: "zai/glm-5.2-fast",
	contextWindowTokens: 1_000_000,
} as const;

export interface AgentModelSetting {
	id: string;
	contextWindowTokens: number;
	isDefault: boolean;
}

export const CONTEXT_DEV_SIGNUP_URL = "https://link.context.dev/crm";

export const CONTEXT_DEV_DISCOUNT_CODE = "CRM";

export const DEFAULT_ARCHIVE_RETENTION_DAYS = 180;

export const MIN_ARCHIVE_RETENTION_DAYS = 1;

export const MAX_ARCHIVE_RETENTION_DAYS = 3650;

export function maskKey(key: string): string {
	const trimmed = key.trim();
	return trimmed.length > 4 ? `••••${trimmed.slice(-4)}` : "••••";
}
