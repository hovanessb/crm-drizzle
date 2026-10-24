import { describe, expect, it } from "bun:test";
import {
	defaultAgentModel,
	isLocalModelId,
	localModel,
	readLocalModel,
} from "../src/local-model";
import { DEFAULT_AGENT_MODEL } from "../src/settings-shape";

const complete = {
	LOCAL_MODEL_URL: "http://127.0.0.1:8080/v1/",
	LOCAL_MODEL_ID: "gemma-4",
	LOCAL_MODEL_CONTEXT_TOKENS: "131072",
};

describe("the local model setting", () => {
	it("is off when no URL is set", () => {
		expect(readLocalModel({})).toEqual({ status: "off" });
		expect(defaultAgentModel({})).toEqual({
			id: DEFAULT_AGENT_MODEL.id,
			contextWindowTokens: DEFAULT_AGENT_MODEL.contextWindowTokens,
		});
	});

	it("becomes the default model when all three values are set", () => {
		expect(localModel(complete)).toEqual({
			id: "local/gemma-4",
			name: "gemma-4",
			baseURL: "http://127.0.0.1:8080/v1",
			apiKey: null,
			contextWindowTokens: 131072,
		});
		expect(defaultAgentModel(complete)).toEqual({
			id: "local/gemma-4",
			contextWindowTokens: 131072,
		});
	});

	it("keeps the key for a server that asks for one", () => {
		expect(
			localModel({ ...complete, LOCAL_MODEL_API_KEY: " secret " })?.apiKey,
		).toBe("secret");
	});

	it("turns itself off and says why when a value is missing or wrong", () => {
		const cases = [
			{ ...complete, LOCAL_MODEL_URL: "localhost:8080" },
			{ ...complete, LOCAL_MODEL_ID: " " },
			{ ...complete, LOCAL_MODEL_CONTEXT_TOKENS: undefined },
			{ ...complete, LOCAL_MODEL_CONTEXT_TOKENS: "128k" },
			{ ...complete, LOCAL_MODEL_CONTEXT_TOKENS: "0" },
		];

		for (const env of cases) {
			const config = readLocalModel(env);
			expect(config.status).toBe("invalid");
			expect(localModel(env)).toBeNull();
			expect(defaultAgentModel(env).id).toBe(DEFAULT_AGENT_MODEL.id);
		}
	});

	it("recognises a local model id", () => {
		expect(isLocalModelId("local/gemma-4")).toBe(true);
		expect(isLocalModelId("zai/glm-5.2-fast")).toBe(false);
	});
});
