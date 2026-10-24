import {
	account as accountTable,
	and,
	db,
	eq,
	lt,
	ne,
	slackInstallation,
	slackWorkspaceGrant,
} from "@crm/db";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import type { OauthAccess } from "@crm/validation";
import { SLACK_PROVIDER_ID } from "./scopes";
import { SLACK_CONNECTION } from "./slack-config";

export async function rememberSlackInstall(grant: OauthAccess): Promise<void> {
	const { team, authed_user: installer } = grant;
	if (!team || !installer) return;

	const install = {
		teamId: team.id,
		teamName: team.name ?? null,
		userToken: installer.access_token ?? null,
		userScopes: installer.scope ?? "",
		createdAt: new Date(),
	};

	await db
		.insert(slackInstallation)
		.values({ installerId: installer.id, ...install })
		.onConflictDoUpdate({
			target: slackInstallation.installerId,
			set: install,
		});

	await forgetStaleInstalls();
}

export async function replaceSlackConnection(account: {
	id: string;
	accountId: string;
}): Promise<void> {
	await db.transaction(async (tx) => {
		await lockIdempotencyKey(tx, SLACK_CONNECTION.locks.connection);

		await tx
			.delete(accountTable)
			.where(
				and(
					eq(accountTable.providerId, SLACK_PROVIDER_ID),
					ne(accountTable.id, account.id),
				),
			);

		const [install] = await tx
			.delete(slackInstallation)
			.where(eq(slackInstallation.installerId, account.accountId))
			.returning();
		if (!install) return;

		await tx
			.delete(slackWorkspaceGrant)
			.where(ne(slackWorkspaceGrant.teamId, install.teamId));

		if (!install.userToken) return;

		const grant = {
			teamName: install.teamName,
			userToken: install.userToken,
			userScopes: install.userScopes,
		};

		await tx
			.insert(slackWorkspaceGrant)
			.values({ teamId: install.teamId, ...grant })
			.onConflictDoUpdate({ target: slackWorkspaceGrant.teamId, set: grant });
	});
}

async function forgetStaleInstalls(): Promise<void> {
	await db
		.delete(slackInstallation)
		.where(
			lt(
				slackInstallation.createdAt,
				new Date(Date.now() - SLACK_CONNECTION.install.staleMs),
			),
		);
}
