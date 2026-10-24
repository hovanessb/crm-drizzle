import { isSlackConfigured } from "@crm/auth/env";
import { canManageConnections, WORKSPACE_ID } from "@crm/auth/organization";
import {
	account as accountTable,
	agentDefinition,
	agentTask,
	agentVersion,
	and,
	asc,
	contains,
	type Db,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	member,
	or,
	type SQL,
	slackChannel,
	slackMemberMatch,
	slackWorkspaceGrant,
	sql,
	user,
} from "@crm/db";
import { SLACK_INVENTORY } from "@crm/db/slack-inventory";
import { schemas } from "@crm/validation";
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { AgentAccessService } from "../agent/agent-access.service";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { InjectDatabase } from "../database/database.constants";
import type {
	SlackChannelsInput,
	SlackChannelsResult,
	SlackCreateChannelInput,
	SlackCreateChannelResult,
	SlackDisconnectResult,
	SlackJoinChannelInput,
	SlackJoinChannelResult,
	SlackMatches,
	SlackRefreshPeopleResult,
	SlackStatus,
} from "./slack.contracts";
import { SlackChannelsService } from "./slack-channels.service";
import { SLACK, type SlackSyncState } from "./slack-config";

const SLACK_WORKSPACE_RESOURCE_ID =
	schemas.agents.CAPABILITY_RESOURCE_IDS.slack;

@Injectable()
export class SlackConnectionService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
		private readonly slackChannels: SlackChannelsService,
		private readonly access: AgentAccessService,
	) {}

	async status(userId: string): Promise<SlackStatus> {
		const role = await this.access.assertMember(userId);
		const [account, agents, matches, memberCount, grant] = await Promise.all([
			this.slackAccount(),
			this.db
				.select({
					id: agentDefinition.id,
					name: agentDefinition.name,
					description: agentDefinition.description,
					status: agentDefinition.status,
				})
				.from(agentDefinition)
				.innerJoin(
					agentVersion,
					eq(agentVersion.id, agentDefinition.currentVersionId),
				)
				.where(
					and(
						inArray(agentDefinition.status, ["LIVE", "PAUSED"]),
						isNull(agentDefinition.deletedAt),
						isNotNull(agentDefinition.currentVersionId),
						sql`${agentVersion.manifest} #> '{dataScope,resources}' @> ${JSON.stringify([{ id: SLACK_WORKSPACE_RESOURCE_ID }])}::jsonb`,
					),
				)
				.orderBy(desc(agentDefinition.updatedAt))
				.limit(30),
			this.db
				.select({
					slackUserId: slackMemberMatch.slackUserId,
					updatedAt: slackMemberMatch.updatedAt,
				})
				.from(slackMemberMatch)
				.where(
					inArray(
						slackMemberMatch.crmUserId,
						this.db
							.select({ userId: member.userId })
							.from(member)
							.where(eq(member.organizationId, WORKSPACE_ID)),
					),
				),
			this.db.$count(member, eq(member.organizationId, WORKSPACE_ID)),
			this.db
				.select({
					id: slackWorkspaceGrant.id,
					teamName: slackWorkspaceGrant.teamName,
				})
				.from(slackWorkspaceGrant)
				.limit(1)
				.then((rows) => rows[0]),
		]);

		const matched = matches.filter((match) => match.slackUserId).length;
		const reviewed = matches.length;
		const inventoryFresh =
			account &&
			reviewed === memberCount &&
			matches.every((match) => match.updatedAt >= account.updatedAt);
		if (account && !inventoryFresh) {
			await this.agent.slackPeopleRequested(
				"Match workspace members to Slack accounts by exact email",
			);
		}

		return {
			configured: isSlackConfigured(),
			connected: Boolean(account),
			workspace: account ? (grant?.teamName ?? null) : null,
			lastConnectedAt: account?.updatedAt.toISOString() ?? null,
			scopes: (account?.scope ?? "")
				.split(",")
				.map((scope) => scope.trim())
				.filter(Boolean),
			canInviteItself: Boolean(grant),
			canManage: canManageConnections(role),
			agents,
			people: { matched, reviewed },
		};
	}

	async matches(userId: string): Promise<SlackMatches> {
		await this.access.assertMember(userId);
		const [members, syncing] = await Promise.all([
			this.db
				.select({
					user: { id: user.id, name: user.name, email: user.email },
					match: {
						slackUserId: slackMemberMatch.slackUserId,
						slackHandle: slackMemberMatch.slackHandle,
						slackEmail: slackMemberMatch.slackEmail,
						id: slackMemberMatch.id,
					},
				})
				.from(member)
				.innerJoin(user, eq(user.id, member.userId))
				.leftJoin(slackMemberMatch, eq(slackMemberMatch.crmUserId, user.id))
				.where(eq(member.organizationId, WORKSPACE_ID))
				.orderBy(asc(user.name)),
			this.peopleSyncState(),
		]);

		return {
			rows: members.map(({ user: person, match }) => ({
				crmUserId: person.id,
				name: person.name,
				email: person.email,
				match: match
					? {
							slackUserId: match.slackUserId,
							slackHandle: match.slackHandle,
							slackEmail: match.slackEmail,
						}
					: null,
			})),
			sync: syncing,
		};
	}

	private async peopleSyncState(): Promise<SlackSyncState> {
		const [pending] = await this.db
			.select({
				createdAt: agentTask.createdAt,
				startedAt: agentTask.startedAt,
				leasedUntil: agentTask.leasedUntil,
			})
			.from(agentTask)
			.where(
				and(
					eq(agentTask.kind, "slack-people-match"),
					isNull(agentTask.finishedAt),
				),
			)
			.orderBy(desc(agentTask.createdAt))
			.limit(1);
		if (!pending) return "idle";

		const now = Date.now();
		const leaseHeld = pending.leasedUntil
			? pending.leasedUntil.getTime() > now
			: false;
		if (leaseHeld || pending.startedAt) return "syncing";

		return now - pending.createdAt.getTime() < SLACK.sync.stalledAfterMs
			? "syncing"
			: "stalled";
	}

	async refreshPeople(userId: string): Promise<SlackRefreshPeopleResult> {
		await this.access.assertMember(userId);
		const account = await this.slackAccount();
		if (!account) throw new NotFoundException("Slack is not connected.");

		await this.agent.slackPeopleRequested(
			"Refresh Slack people and channels from the connection page",
			true,
		);

		return { requested: true };
	}

	async channels(
		input: SlackChannelsInput,
		userId: string,
	): Promise<SlackChannelsResult> {
		await this.access.assertMember(userId);

		const take = input.limit ?? SLACK.channels.pageSize;
		const needle = input.query?.trim() ?? "";

		const where = and(
			eq(slackChannel.available, true),
			needle
				? contains(slackChannel.name, needle, { insensitive: true })
				: undefined,
			input.cursor ? await this.channelsAfter(input.cursor) : undefined,
		);

		const [rows, grant, sync] = await Promise.all([
			this.db
				.select({
					id: slackChannel.id,
					name: slackChannel.name,
					memberCount: slackChannel.memberCount,
					isPrivate: slackChannel.isPrivate,
					isMember: slackChannel.isMember,
					classifiedAt: slackChannel.classifiedAt,
					inviteRequestedAt: slackChannel.inviteRequestedAt,
				})
				.from(slackChannel)
				.where(where)
				.orderBy(
					desc(slackChannel.isMember),
					asc(slackChannel.name),
					asc(slackChannel.id),
				)
				.limit(take + 1),
			this.grant(),
			this.peopleSyncState(),
		]);

		const page = rows.slice(0, take);
		const emptyInventory = sync === "idle" && !needle && page.length === 0;
		const [account, lastFill] = emptyInventory
			? await Promise.all([
					this.slackAccount(),
					this.db
						.select({ finishedAt: agentTask.finishedAt })
						.from(agentTask)
						.where(
							and(
								eq(agentTask.kind, SLACK_INVENTORY.kind),
								isNotNull(agentTask.finishedAt),
							),
						)
						.orderBy(desc(agentTask.finishedAt))
						.limit(1)
						.then((rows) => rows[0] ?? null),
				])
			: [null, null];
		const refillDue =
			account !== null &&
			(lastFill?.finishedAt === null ||
				lastFill?.finishedAt === undefined ||
				lastFill.finishedAt < account.updatedAt ||
				Date.now() - lastFill.finishedAt.getTime() >=
					SLACK_INVENTORY.throttleMs);
		if (refillDue) {
			await this.agent.slackPeopleRequested(
				"Fill the Slack channel inventory for the connections page",
			);
		}

		return {
			canInviteItself: Boolean(grant),
			sync: refillDue ? "syncing" : sync,
			nextCursor: rows.length > take ? (page.at(-1)?.id ?? null) : null,
			rows: page.map(({ classifiedAt, ...row }) => ({
				...row,
				classified: classifiedAt !== null,
				inviteRequestedAt: row.inviteRequestedAt?.toISOString() ?? null,
			})),
		};
	}

	async joinChannel(
		input: SlackJoinChannelInput,
		userId: string,
	): Promise<SlackJoinChannelResult> {
		await this.access.assertMember(userId);
		const [channel] = await this.db
			.select({
				id: slackChannel.id,
				name: slackChannel.name,
				isMember: slackChannel.isMember,
				isPrivate: slackChannel.isPrivate,
			})
			.from(slackChannel)
			.where(eq(slackChannel.id, input.channelId))
			.limit(1);
		if (!channel) throw new NotFoundException("No such Slack channel.");
		if (channel.isMember) return { queued: false, alreadyJoined: true };

		const grant = await this.grant();
		if (channel.isPrivate && !grant) {
			await this.db
				.update(slackChannel)
				.set({ inviteRequestedAt: new Date() })
				.where(eq(slackChannel.id, channel.id));
			return { queued: false, alreadyJoined: false };
		}

		await this.agent.slackChannelJoinRequested(channel.id, channel.name);
		return { queued: true, alreadyJoined: false };
	}

	async createChannel(
		input: SlackCreateChannelInput,
		userId: string,
	): Promise<SlackCreateChannelResult> {
		await this.access.assertMember(userId);
		const [existing] = await this.db
			.select({ id: slackChannel.id })
			.from(slackChannel)
			.where(eq(slackChannel.name, input.name))
			.limit(1);
		if (existing) {
			throw new BadRequestException("A channel with that name already exists.");
		}

		return this.slackChannels.create(input.name, input.isPrivate);
	}

	async disconnect(userId: string): Promise<SlackDisconnectResult> {
		const role = await this.access.assertMember(userId);

		if (!canManageConnections(role)) {
			throw new ForbiddenException(
				"Only an owner or an admin can disconnect Slack.",
			);
		}

		const removed = await this.db.transaction(async (tx) => {
			const accounts = await tx
				.delete(accountTable)
				.where(eq(accountTable.providerId, "slack"))
				.returning({ id: accountTable.id });
			await tx.delete(slackChannel);
			await tx.delete(slackWorkspaceGrant);
			return accounts.length;
		});

		if (removed === 0) throw new NotFoundException("Slack is not connected.");

		return { disconnected: true };
	}

	private async slackAccount() {
		const [row] = await this.db
			.select({
				id: accountTable.id,
				accountId: accountTable.accountId,
				updatedAt: accountTable.updatedAt,
				scope: accountTable.scope,
			})
			.from(accountTable)
			.where(
				and(
					eq(accountTable.providerId, "slack"),
					isNotNull(accountTable.accessToken),
				),
			)
			.orderBy(desc(accountTable.updatedAt))
			.limit(1);
		return row ?? null;
	}

	private async grant() {
		const [row] = await this.db
			.select({ id: slackWorkspaceGrant.id })
			.from(slackWorkspaceGrant)
			.limit(1);
		return row ?? null;
	}

	private async channelsAfter(cursorId: string): Promise<SQL | undefined> {
		const [cursor] = await this.db
			.select({
				id: slackChannel.id,
				name: slackChannel.name,
				isMember: slackChannel.isMember,
			})
			.from(slackChannel)
			.where(eq(slackChannel.id, cursorId))
			.limit(1);
		if (!cursor) return sql`false`;

		return or(
			lt(slackChannel.isMember, cursor.isMember),
			and(
				eq(slackChannel.isMember, cursor.isMember),
				gt(slackChannel.name, cursor.name),
			),
			and(
				eq(slackChannel.isMember, cursor.isMember),
				eq(slackChannel.name, cursor.name),
				gt(slackChannel.id, cursor.id),
			),
		);
	}
}
