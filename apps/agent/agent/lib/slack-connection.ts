import {
	account as accountTable,
	and,
	db,
	desc,
	eq,
	firstRow,
	isNotNull,
	slackWorkspaceGrant,
} from "@crm/db";

export async function slackAccessToken(): Promise<string | null> {
	const account = await firstRow(
		db
			.select({ accessToken: accountTable.accessToken })
			.from(accountTable)
			.where(
				and(
					eq(accountTable.providerId, "slack"),
					isNotNull(accountTable.accessToken),
				),
			)
			.orderBy(desc(accountTable.updatedAt))
			.limit(1),
	);

	return account?.accessToken ?? null;
}

export async function slackConnected(): Promise<boolean> {
	return (await slackAccessToken()) !== null;
}

export async function slackUserToken(): Promise<string | null> {
	const grant = await firstRow(
		db
			.select({ userToken: slackWorkspaceGrant.userToken })
			.from(slackWorkspaceGrant)
			.orderBy(desc(slackWorkspaceGrant.updatedAt))
			.limit(1),
	);

	return grant?.userToken ?? null;
}

export async function slackCanInviteItself(): Promise<boolean> {
	return (await slackUserToken()) !== null;
}
