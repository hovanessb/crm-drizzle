import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Cache } from "cache-manager";
import {
	type CatalogModel,
	ModelCatalogService,
} from "../src/settings/model-catalog.service";

const LOCAL = {
	LOCAL_MODEL_URL: "http://127.0.0.1:8080/v1",
	LOCAL_MODEL_ID: "gemma-4",
	LOCAL_MODEL_CONTEXT_TOKENS: "131072",
};

type Cached = { models: CatalogModel[] | null };

type Entry = { value: Cached; ttl: number | undefined };

function memoryCache() {
	const entries = new Map<string, Entry>();
	const cache = {
		get: async (key: string) => entries.get(key)?.value,
		set: async (key: string, value: Cached, ttl?: number) => {
			entries.set(key, { value, ttl });
			return value;
		},
	} as unknown as Cache;
	return { cache, entries };
}

let previous: Partial<Record<keyof typeof LOCAL, string>> = {};

beforeEach(() => {
	previous = {};
	for (const key of Object.keys(LOCAL) as (keyof typeof LOCAL)[]) {
		previous[key] = process.env[key];
		process.env[key] = LOCAL[key];
	}
});

afterEach(() => {
	for (const key of Object.keys(LOCAL) as (keyof typeof LOCAL)[]) {
		const value = previous[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("the model catalog with a local model", () => {
	it("offers the local model when the AI Gateway is unreachable", async () => {
		const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("offline"),
		);
		const { cache, entries } = memoryCache();
		const catalog = new ModelCatalogService(cache);

		try {
			expect(await catalog.models()).toEqual([
				{
					id: "local/gemma-4",
					name: "gemma-4 (local)",
					provider: "local",
					contextWindowTokens: 131_072,
					pricing: null,
				},
			]);
			expect(await catalog.find("local/gemma-4")).not.toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect([...entries.values()][0]?.ttl).toBe(60_000);
		} finally {
			fetch.mockRestore();
		}
	});

	it("offers nothing when neither source is there", async () => {
		delete process.env.LOCAL_MODEL_URL;
		const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("offline"),
		);

		try {
			expect(
				await new ModelCatalogService(memoryCache().cache).models(),
			).toBeNull();
		} finally {
			fetch.mockRestore();
		}
	});
});
