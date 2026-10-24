import { DEFAULT_AGENT_MODEL } from "./settings-shape";

export const LOCAL_MODEL_PREFIX = "local/";

export type LocalModel = {
	id: string;
	name: string;
	baseURL: string;
	apiKey: string | null;
	contextWindowTokens: number;
};

export type LocalModelConfig =
	| { status: "off" }
	| { status: "on"; model: LocalModel }
	| { status: "invalid"; reason: string };

export type DefaultModel = { id: string; contextWindowTokens: number };

function text(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function httpUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? value.replace(/\/+$/, "")
			: null;
	} catch {
		return null;
	}
}

export function readLocalModel(
	env: NodeJS.ProcessEnv = process.env,
): LocalModelConfig {
	const url = text(env.LOCAL_MODEL_URL);
	if (!url) return { status: "off" };

	const baseURL = httpUrl(url);
	if (!baseURL) {
		return {
			status: "invalid",
			reason: `LOCAL_MODEL_URL "${url}" is not an http or https URL.`,
		};
	}

	const name = text(env.LOCAL_MODEL_ID);
	if (!name) {
		return {
			status: "invalid",
			reason:
				"LOCAL_MODEL_URL is set without LOCAL_MODEL_ID, the model name the server expects.",
		};
	}

	const tokens = Number(text(env.LOCAL_MODEL_CONTEXT_TOKENS));
	if (!Number.isInteger(tokens) || tokens <= 0) {
		return {
			status: "invalid",
			reason:
				"LOCAL_MODEL_CONTEXT_TOKENS must be the server's context size in tokens, the value of llama-server --ctx-size.",
		};
	}

	return {
		status: "on",
		model: {
			id: `${LOCAL_MODEL_PREFIX}${name}`,
			name,
			baseURL,
			apiKey: text(env.LOCAL_MODEL_API_KEY),
			contextWindowTokens: tokens,
		},
	};
}

export function localModel(
	env: NodeJS.ProcessEnv = process.env,
): LocalModel | null {
	const config = readLocalModel(env);
	return config.status === "on" ? config.model : null;
}

export function isLocalModelId(id: string): boolean {
	return id.startsWith(LOCAL_MODEL_PREFIX);
}

export function defaultAgentModel(
	env: NodeJS.ProcessEnv = process.env,
): DefaultModel {
	const local = localModel(env);
	if (local) {
		return { id: local.id, contextWindowTokens: local.contextWindowTokens };
	}
	return {
		id: DEFAULT_AGENT_MODEL.id,
		contextWindowTokens: DEFAULT_AGENT_MODEL.contextWindowTokens,
	};
}
