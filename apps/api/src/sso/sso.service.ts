import { auth } from "@crm/auth/auth";
import { isGoogleConfigured, isMicrosoftConfigured } from "@crm/auth/env";
import { WORKSPACE_ID, workspaceRoleOf } from "@crm/auth/organization";
import {
	canConfigureSso,
	ssoCallbackBase,
	ssoCallbackURL,
	ssoProviderName,
} from "@crm/auth/sso";
import {
	and,
	asc,
	contains,
	type Db,
	eq,
	or,
	type SQL,
	ssoProvider,
} from "@crm/db";
import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	Injectable,
	InternalServerErrorException,
	Logger,
} from "@nestjs/common";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import {
	type ListResult,
	type OrderByColumns,
	paginate,
	resolveOrderBy,
	sortBy,
} from "../trpc/list-input";
import type {
	DeleteSsoProviderInput,
	RegisterSsoProviderInput,
	SignInOptions,
	SsoProvider,
	SsoProviderListInput,
	SsoSettings,
} from "./sso.contracts";

const PROVIDER_FIELDS = {
	providerId: ssoProvider.providerId,
	issuer: ssoProvider.issuer,
	domain: ssoProvider.domain,
	oidcConfig: ssoProvider.oidcConfig,
	samlConfig: ssoProvider.samlConfig,
};

type ProviderRow = {
	providerId: string;
	issuer: string;
	domain: string;
	oidcConfig: string | null;
	samlConfig: string | null;
};

const SORTABLE: OrderByColumns<SQL> = {
	providerId: (dir) => sortBy(ssoProvider.providerId, dir),
	domain: (dir) => sortBy(ssoProvider.domain, dir),
	issuer: (dir) => sortBy(ssoProvider.issuer, dir),
};

const STATUS_BY_CODE = new Map<string, number>([
	["BAD_REQUEST", 400],
	["UNAUTHORIZED", 401],
	["FORBIDDEN", 403],
	["NOT_FOUND", 404],
	["CONFLICT", 409],
	["UNPROCESSABLE_ENTITY", 400],
]);

function splitDomains(value: string): string[] {
	return value
		.split(",")
		.map((part) =>
			part
				.trim()
				.replace(/^https?:\/\//i, "")
				.replace(/\/.*$/, ""),
		)
		.map((part) => part.toLowerCase())
		.filter(Boolean);
}

const oidcConfig = z
	.object({ clientId: z.string().catch("") })
	.catch({ clientId: "" });

type OidcConfig = z.infer<typeof oidcConfig>;

function lastFour(clientId: string): string | null {
	return clientId.length >= 4 ? clientId.slice(-4) : null;
}

function readOidcConfig(value: string | null): OidcConfig | null {
	if (!value) return null;

	try {
		return oidcConfig.parse(JSON.parse(value));
	} catch {
		return null;
	}
}

function toProvider(row: ProviderRow): SsoProvider {
	const oidc = readOidcConfig(row.oidcConfig);

	return {
		providerId: row.providerId,
		name: ssoProviderName(row.providerId),
		type: row.samlConfig ? "saml" : "oidc",
		issuer: row.issuer,
		domains: splitDomains(row.domain),
		clientIdLastFour: oidc ? lastFour(oidc.clientId) : null,
		callbackURL: ssoCallbackURL(row.providerId),
	};
}

@Injectable()
export class SsoService {
	private readonly logger = new Logger(SsoService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async signInOptions(): Promise<SignInOptions> {
		const rows = await this.db
			.select({ providerId: ssoProvider.providerId })
			.from(ssoProvider)
			.where(eq(ssoProvider.organizationId, WORKSPACE_ID))
			.orderBy(asc(ssoProvider.providerId));

		return {
			google: isGoogleConfigured(),
			microsoft: isMicrosoftConfigured(),
			providers: rows.map((row) => ({
				providerId: row.providerId,
				name: ssoProviderName(row.providerId),
			})),
		};
	}

	async settings(userId: string): Promise<SsoSettings> {
		return {
			canConfigure: canConfigureSso(await workspaceRoleOf(userId, this.db)),
			callbackBase: ssoCallbackBase(),
		};
	}

	async list(input: SsoProviderListInput): Promise<ListResult<SsoProvider>> {
		const where = this.searchWhere(input.q);
		const { skip, take } = paginate(input);

		const [rows, total] = await Promise.all([
			this.db
				.select(PROVIDER_FIELDS)
				.from(ssoProvider)
				.where(where)
				.orderBy(resolveOrderBy(input, SORTABLE, asc(ssoProvider.providerId)))
				.limit(take)
				.offset(skip),
			this.db.$count(ssoProvider, where),
		]);

		return { rows: rows.map(toProvider), total, facetCounts: {} };
	}

	async register(
		userId: string,
		headers: Headers,
		input: RegisterSsoProviderInput,
	): Promise<SsoProvider> {
		await this.requireConfigurer(userId);

		const domains = splitDomains(input.domain);

		if (domains.length === 0) {
			throw new BadRequestException(
				"Give the email domain your people sign in with, for example acme.com.",
			);
		}

		await this.call(() =>
			auth.api.registerSSOProvider({
				headers,
				body: {
					providerId: input.providerId,
					issuer: input.issuer,
					domain: domains.join(","),
					organizationId: WORKSPACE_ID,
					oidcConfig: {
						clientId: input.clientId,
						clientSecret: input.clientSecret,
						pkce: true,
					},
				},
			}),
		);

		this.logger.log({
			message: "SSO provider registered",
			userId,
			providerId: input.providerId,
			issuer: input.issuer,
		});

		const [row] = await this.db
			.select(PROVIDER_FIELDS)
			.from(ssoProvider)
			.where(eq(ssoProvider.providerId, input.providerId))
			.limit(1);
		if (!row) {
			throw new InternalServerErrorException(
				"The provider was saved but cannot be read back.",
			);
		}

		return toProvider(row);
	}

	async remove(
		userId: string,
		headers: Headers,
		input: DeleteSsoProviderInput,
	): Promise<{ providerId: string }> {
		await this.requireConfigurer(userId);

		await this.call(() =>
			auth.api.deleteSSOProvider({
				headers,
				body: { providerId: input.providerId },
			}),
		);

		this.logger.log({
			message: "SSO provider removed",
			userId,
			providerId: input.providerId,
		});

		return { providerId: input.providerId };
	}

	private searchWhere(q: string): SQL | undefined {
		const term = q.trim();
		return and(
			eq(ssoProvider.organizationId, WORKSPACE_ID),
			term
				? or(
						contains(ssoProvider.providerId, term, { insensitive: true }),
						contains(ssoProvider.domain, term, { insensitive: true }),
						contains(ssoProvider.issuer, term, { insensitive: true }),
					)
				: undefined,
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
					error.body?.message ?? "The identity provider could not be saved.",
					status,
				);
			}

			this.logger.error(
				{ message: "SSO provider call failed" },
				error instanceof Error ? error.stack : String(error),
			);

			throw new InternalServerErrorException(
				"Could not reach the identity provider.",
			);
		}
	}

	private async requireConfigurer(userId: string): Promise<void> {
		if (!canConfigureSso(await workspaceRoleOf(userId, this.db))) {
			throw new ForbiddenException(
				"Only an owner or an admin can change how people sign in.",
			);
		}
	}
}
