import { auth } from "@crm/auth/auth";
import {
	GOOGLE_PROVIDER_ID,
	type MailboxProviderId,
	parseScopes,
	type SignInAccount,
} from "@crm/auth/scopes";
import { account, and, type Db, eq } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import {
	PROVIDER_FOR_SOURCE,
	SCOPE_FOR_SOURCE,
	type SyncSource,
} from "./mailbox.constants";

type TokenFailure =
	| { outcome: "needs-reconnect"; reason: string }
	| { outcome: "not-connected"; reason: string };

export type TokenResult = { outcome: "ok"; accessToken: string } | TokenFailure;

const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

@Injectable()
export class MailboxTokenService {
	private readonly logger = new Logger(MailboxTokenService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async grantedScopes(
		userId: string,
		providerId: MailboxProviderId,
	): Promise<Set<string>> {
		const [row] = await this.db
			.select({ scope: account.scope })
			.from(account)
			.where(
				and(eq(account.userId, userId), eq(account.providerId, providerId)),
			)
			.limit(1);

		return parseScopes(row?.scope);
	}

	async isConnected(userId: string, source: SyncSource): Promise<boolean> {
		const scopes = await this.grantedScopes(
			userId,
			PROVIDER_FOR_SOURCE[source],
		);
		return scopes.has(SCOPE_FOR_SOURCE[source]);
	}

	async signInAccounts(userId: string): Promise<SignInAccount[]> {
		return this.db
			.select({ providerId: account.providerId, scope: account.scope })
			.from(account)
			.where(eq(account.userId, userId));
	}

	async hasRefreshToken(
		userId: string,
		providerId: MailboxProviderId,
	): Promise<boolean> {
		const [row] = await this.db
			.select({ refreshToken: account.refreshToken })
			.from(account)
			.where(
				and(eq(account.userId, userId), eq(account.providerId, providerId)),
			)
			.limit(1);

		return Boolean(row?.refreshToken);
	}

	async accessTokenFor(
		userId: string,
		source: SyncSource,
	): Promise<TokenResult> {
		const providerId = PROVIDER_FOR_SOURCE[source];

		if (!(await this.isConnected(userId, source))) {
			return {
				outcome: "not-connected",
				reason: `The ${source} scope has not been granted.`,
			};
		}

		try {
			const { accessToken } = await auth.api.getAccessToken({
				body: { providerId, userId },
			});

			if (!accessToken) {
				return {
					outcome: "needs-reconnect",
					reason: `${label(providerId)} returned no access token.`,
				};
			}

			return { outcome: "ok", accessToken };
		} catch (error) {
			this.logger.warn({
				message: "Mailbox token refresh failed",
				userId,
				providerId,
				source,
				reason: error instanceof Error ? error.message : String(error),
			});

			return {
				outcome: "needs-reconnect",
				reason: `${label(providerId)} would not refresh the access token.`,
			};
		}
	}

	async revoke(
		userId: string,
		providerId: MailboxProviderId,
	): Promise<boolean> {
		if (
			providerId === GOOGLE_PROVIDER_ID &&
			!(await this.revokeWithGoogle(userId))
		) {
			return false;
		}

		const cleared = await this.db
			.update(account)
			.set({
				accessToken: null,
				refreshToken: null,
				scope: null,
				accessTokenExpiresAt: null,
				refreshTokenExpiresAt: null,
			})
			.where(
				and(eq(account.userId, userId), eq(account.providerId, providerId)),
			)
			.returning({ id: account.id });

		if (cleared.length === 0) return false;

		this.logger.log({ message: "Mailbox access revoked", userId, providerId });
		return true;
	}

	private async revokeWithGoogle(userId: string): Promise<boolean> {
		const [row] = await this.db
			.select({
				refreshToken: account.refreshToken,
				accessToken: account.accessToken,
			})
			.from(account)
			.where(
				and(
					eq(account.userId, userId),
					eq(account.providerId, GOOGLE_PROVIDER_ID),
				),
			)
			.limit(1);

		const token = row?.refreshToken ?? row?.accessToken;
		if (!token) return true;

		const response = await fetch(GOOGLE_REVOKE_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }),
		});

		if (response.ok) return true;

		this.logger.warn({
			message: "Google token revocation failed",
			userId,
			status: response.status,
		});

		return false;
	}
}

function label(providerId: MailboxProviderId): string {
	return providerId === GOOGLE_PROVIDER_ID ? "Google" : "Microsoft";
}
