import { DAY_SECONDS } from "@crm/auth/api-keys";
import { auth } from "@crm/auth/auth";
import { and, apikey, contains, type Db, desc, eq, type SQL } from "@crm/db";
import {
	HttpException,
	Injectable,
	InternalServerErrorException,
	Logger,
} from "@nestjs/common";
import { APIError } from "better-auth/api";
import { InjectDatabase } from "../database/database.constants";
import {
	type ListResult,
	type OrderByColumns,
	paginate,
	resolveOrderBy,
	sortBy,
} from "../trpc/list-input";
import type {
	ApiKeyListInput,
	ApiKeySummary,
	CreateApiKeyInput,
	CreatedApiKey,
	RevokeApiKeyInput,
} from "./api-keys.contracts";

const KEY_FIELDS = {
	id: apikey.id,
	name: apikey.name,
	start: apikey.start,
	enabled: apikey.enabled,
	createdAt: apikey.createdAt,
	lastRequest: apikey.lastRequest,
	expiresAt: apikey.expiresAt,
};

type KeyRow = {
	id: string;
	name: string | null;
	start: string | null;
	enabled: boolean | null;
	createdAt: Date;
	lastRequest: Date | null;
	expiresAt: Date | null;
};

const SORTABLE: OrderByColumns<SQL> = {
	name: (dir) => sortBy(apikey.name, dir),
	createdAt: (dir) => sortBy(apikey.createdAt, dir),
	lastRequest: (dir) => sortBy(apikey.lastRequest, dir),
	expiresAt: (dir) => sortBy(apikey.expiresAt, dir),
};

const STATUS_BY_CODE = new Map<string, number>([
	["BAD_REQUEST", 400],
	["UNAUTHORIZED", 401],
	["FORBIDDEN", 403],
	["NOT_FOUND", 404],
	["CONFLICT", 409],
	["UNPROCESSABLE_ENTITY", 400],
]);

function toSummary(row: KeyRow): ApiKeySummary {
	return {
		id: row.id,
		name: row.name,
		start: row.start,
		enabled: row.enabled ?? true,
		createdAt: row.createdAt.toISOString(),
		lastRequest: row.lastRequest?.toISOString() ?? null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
	};
}

@Injectable()
export class ApiKeysService {
	private readonly logger = new Logger(ApiKeysService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async list(
		userId: string,
		input: ApiKeyListInput,
	): Promise<ListResult<ApiKeySummary>> {
		const where = this.searchWhere(userId, input.q);
		const { skip, take } = paginate(input);

		const [rows, total] = await Promise.all([
			this.db
				.select(KEY_FIELDS)
				.from(apikey)
				.where(where)
				.orderBy(resolveOrderBy(input, SORTABLE, desc(apikey.createdAt)))
				.limit(take)
				.offset(skip),
			this.db.$count(apikey, where),
		]);

		return { rows: rows.map(toSummary), total, facetCounts: {} };
	}

	async create(
		userId: string,
		headers: Headers,
		input: CreateApiKeyInput,
	): Promise<CreatedApiKey> {
		const created = await this.call(() =>
			auth.api.createApiKey({
				headers,
				body: {
					name: input.name,
					expiresIn:
						input.expiresInDays === null
							? null
							: input.expiresInDays * DAY_SECONDS,
				},
			}),
		);

		this.logger.log({
			message: "API key created",
			userId,
			apiKeyId: created.id,
		});

		return {
			id: created.id,
			name: created.name,
			start: created.start,
			enabled: created.enabled,
			createdAt: created.createdAt.toISOString(),
			lastRequest: created.lastRequest?.toISOString() ?? null,
			expiresAt: created.expiresAt?.toISOString() ?? null,
			key: created.key,
		};
	}

	async revoke(
		userId: string,
		headers: Headers,
		input: RevokeApiKeyInput,
	): Promise<{ id: string }> {
		await this.call(() =>
			auth.api.deleteApiKey({ headers, body: { keyId: input.id } }),
		);

		this.logger.log({
			message: "API key revoked",
			userId,
			apiKeyId: input.id,
		});

		return { id: input.id };
	}

	private searchWhere(userId: string, q: string): SQL | undefined {
		const term = q.trim();
		return and(
			eq(apikey.referenceId, userId),
			term ? contains(apikey.name, term, { insensitive: true }) : undefined,
		);
	}

	private async call<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof APIError) {
				const status =
					STATUS_BY_CODE.get(error.body?.code ?? "") ?? error.statusCode;

				throw new HttpException(
					error.body?.message ?? "The API key could not be saved.",
					status,
				);
			}

			this.logger.error(
				{ message: "API key call failed" },
				error instanceof Error ? error.stack : String(error),
			);

			throw new InternalServerErrorException(
				"Could not reach the auth service.",
			);
		}
	}
}
