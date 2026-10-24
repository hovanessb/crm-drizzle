import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { db } from "@crm/db";
import {
	defaultAgentModel,
	isLocalModelId,
	type LocalModel,
	readLocalModel,
} from "@crm/db/local-model";
import { readAgentModel } from "@crm/db/settings";
import type {
	AgentStaticModelDefinition,
	DynamicResolveContext,
	DynamicSentinel,
} from "eve";

export interface ModelSelection {
	model: string;
	modelContextWindowTokens: number;
}

type SessionModel = (
	ctx: DynamicResolveContext,
) => ModelSelection | Promise<ModelSelection>;

type ModelEvents = DynamicSentinel<
	ModelSelection | StepModelSelection
>["events"];

export type StepModelSelection = {
	model: AgentStaticModelDefinition;
	modelContextWindowTokens?: number;
};

const localConfig = readLocalModel();

export const LOCAL_MODEL: LocalModel | null =
	localConfig.status === "on" ? localConfig.model : null;

if (localConfig.status === "invalid") {
	console.error(
		`[agent] the local model is off: ${localConfig.reason} Sessions use the AI Gateway.`,
	);
}

export function fallbackModel(): ModelSelection {
	const model = defaultAgentModel();
	return {
		model: model.id,
		modelContextWindowTokens: model.contextWindowTokens,
	};
}

export async function selectedModel(): Promise<ModelSelection> {
	try {
		const setting = await readAgentModel(db);

		return {
			model: setting.id,
			modelContextWindowTokens: setting.contextWindowTokens,
		};
	} catch (error) {
		console.error(
			`[agent] could not read the configured model, falling back: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return fallbackModel();
	}
}

function localLanguageModel(local: LocalModel) {
	return createOpenAICompatible({
		name: "local",
		baseURL: local.baseURL,
		apiKey: local.apiKey ?? undefined,
	}).chatModel(local.name);
}

export function stepModel(
	local: LocalModel,
	ctx: DynamicResolveContext,
): StepModelSelection {
	const id = ctx.model?.id ?? local.id;

	if (isLocalModelId(id)) {
		return {
			model: localLanguageModel(local),
			modelContextWindowTokens: local.contextWindowTokens,
		};
	}

	return { model: id };
}

export function modelEvents(session: SessionModel): ModelEvents {
	const local = LOCAL_MODEL;

	if (!local) {
		return { "session.started": (_event, ctx) => session(ctx) };
	}

	return {
		"session.started": (_event, ctx) => session(ctx),
		"step.started": (_event, ctx) => stepModel(local, ctx),
	};
}
