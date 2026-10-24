import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { LocalModel } from "@crm/db/local-model";
import { generateText, type LanguageModel, stepCountIs, tool } from "ai";
import type { DynamicResolveContext } from "eve";
import { z } from "zod";
import { stepModel } from "../agent/lib/model";

const chatRequest = z.object({
	model: z.string(),
	tools: z
		.array(z.object({ function: z.object({ name: z.string() }) }))
		.optional(),
	messages: z.array(z.object({ role: z.string() })),
});

type ChatRequest = z.infer<typeof chatRequest>;

const requests: {
	path: string;
	authorization: string | null;
	body: ChatRequest;
}[] = [];

type AssistantMessage = {
	role: "assistant";
	content: string | null;
	tool_calls?: {
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}[];
};

function completion(message: AssistantMessage, finishReason: string) {
	return Response.json({
		id: "chatcmpl-local",
		object: "chat.completion",
		created: 1_800_000_000,
		model: "gemma-4",
		choices: [{ index: 0, message, finish_reason: finishReason }],
		usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
	});
}

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = chatRequest.parse(await request.json());
			requests.push({
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				body,
			});

			const answeredTool = body.messages.some(
				(message) => message.role === "tool",
			);

			return answeredTool
				? completion(
						{ role: "assistant", content: "Acme has 3 open deals." },
						"stop",
					)
				: completion(
						{
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "count_deals",
										arguments: JSON.stringify({ company: "Acme" }),
									},
								},
							],
						},
						"tool_calls",
					);
		},
	});
});

afterAll(() => server.stop(true));

function local(apiKey: string | null): LocalModel {
	return {
		id: "local/gemma-4",
		name: "gemma-4",
		baseURL: `http://127.0.0.1:${server.port}/v1`,
		apiKey,
		contextWindowTokens: 131_072,
	};
}

function context(id: string | null): DynamicResolveContext {
	return {
		model: id ? { id } : null,
		session: { id: "session-1", auth: { current: null, initiator: null } },
		channel: {},
		messages: [],
	} as unknown as DynamicResolveContext;
}

describe("the local model", () => {
	it("answers a local session with a direct model and its context size", () => {
		const selection = stepModel(local(null), context("local/gemma-4"));

		expect(selection.model).toHaveProperty("modelId", "gemma-4");
		expect(selection.modelContextWindowTokens).toBe(131_072);
	});

	it("leaves a Gateway session on its Gateway model", () => {
		expect(stepModel(local(null), context("zai/glm-5.2-fast"))).toEqual({
			model: "zai/glm-5.2-fast",
		});
	});

	it("calls the server's chat completions endpoint and runs a tool round trip", async () => {
		requests.length = 0;
		const selection = stepModel(local("secret"), context("local/gemma-4"));
		let counted: string | null = null;

		const result = await generateText({
			model: selection.model as LanguageModel,
			prompt: "How many open deals does Acme have?",
			tools: {
				count_deals: tool({
					description: "Count the open deals at a company.",
					inputSchema: z.object({ company: z.string() }),
					execute: async ({ company }) => {
						counted = company;
						return { open: 3 };
					},
				}),
			},
			stopWhen: stepCountIs(3),
		});

		expect(counted).toBe("Acme");
		expect(result.text).toBe("Acme has 3 open deals.");
		expect(requests).toHaveLength(2);
		expect(requests[0]?.path).toBe("/v1/chat/completions");
		expect(requests[0]?.authorization).toBe("Bearer secret");
		expect(requests[0]?.body.model).toBe("gemma-4");
		expect(requests[0]?.body.tools?.[0]?.function.name).toBe("count_deals");
	});
});
