import { auth, type Session } from "@crm/auth/auth";
import { needsMailboxGrant } from "@crm/auth/scopes";
import { account, db, eq } from "@crm/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

export const getSession = cache(
	async (): Promise<Session | null> =>
		auth.api.getSession({ headers: await headers() }),
);

export async function requireSession(): Promise<Session> {
	const session = await getSession();

	if (!session) {
		redirect("/sign-in");
	}

	return session;
}

export const signInAccounts = cache(async (userId: string) =>
	db
		.select({ providerId: account.providerId, scope: account.scope })
		.from(account)
		.where(eq(account.userId, userId)),
);

export async function requireMailboxAccess(): Promise<Session> {
	const session = await requireSession();

	if (needsMailboxGrant(await signInAccounts(session.user.id))) {
		redirect("/grant-access");
	}

	return session;
}
