import {
	canChangeRole,
	canRenameWorkspace,
	ensureWorkspaceMembership,
	isWorkspaceRole,
	WORKSPACE_ID,
	type WorkspaceRole,
	workspaceRoleOf,
} from "@crm/auth/organization";
import {
	and,
	asc,
	contains,
	type Db,
	type Executor,
	eq,
	inArray,
	member,
	or,
	organization,
	type SQL,
	user,
} from "@crm/db";
import { isOnboarded, markOnboarded, workspaceSlug } from "@crm/db/workspace";
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { normalizeDomain } from "../companies/domain";
import { InjectDatabase } from "../database/database.constants";
import {
	countsByKey,
	groupCounts,
	type ListResult,
	type OrderByColumns,
	paginate,
	resolveOrderBy,
	sortBy,
} from "../trpc/list-input";
import type {
	MemberListInput,
	SetMemberRoleInput,
	UpdateWorkspaceInput,
	Workspace,
	WorkspaceMember,
} from "./workspace.contracts";

const MEMBER_FIELDS = {
	id: member.id,
	role: member.role,
	createdAt: member.createdAt,
	userId: member.userId,
	user: { name: user.name, email: user.email, image: user.image },
};

type MemberRow = {
	id: string;
	role: string;
	createdAt: Date;
	userId: string;
	user: { name: string; email: string; image: string | null };
};

const SORTABLE: OrderByColumns<SQL> = {
	name: (dir) => sortBy(user.name, dir),
	email: (dir) => sortBy(user.email, dir),
	role: (dir) => sortBy(member.role, dir),
	joinedAt: (dir) => sortBy(member.createdAt, dir),
};

function members(db: Executor) {
	return db
		.select(MEMBER_FIELDS)
		.from(member)
		.innerJoin(user, eq(user.id, member.userId));
}

function toRole(value: string): WorkspaceRole {
	return isWorkspaceRole(value) ? value : "member";
}

@Injectable()
export class WorkspaceService {
	private readonly logger = new Logger(WorkspaceService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
	) {}

	async get(userId: string): Promise<Workspace> {
		let row = await this.readWorkspace();

		if (!row) {
			await ensureWorkspaceMembership(userId);
			row = await this.readWorkspace();
		}

		if (!row) {
			throw new ServiceUnavailableException(
				"The workspace could not be read. Sign in again in a moment.",
			);
		}

		const role = await workspaceRoleOf(userId);

		return {
			id: row.id,
			slug: row.slug,
			name: row.name,
			website: row.website,
			onboarded: isOnboarded(row.metadata),
			viewerRole: role,
			canRename: canRenameWorkspace(role),
			canChangeRoles: canChangeRole(role),
		};
	}

	async update(
		userId: string,
		input: UpdateWorkspaceInput,
	): Promise<Workspace> {
		const role = await workspaceRoleOf(userId);

		if (!canRenameWorkspace(role)) {
			throw new ForbiddenException(
				"Only an owner or an admin can change the workspace.",
			);
		}

		const [before] = await this.db
			.select({
				website: organization.website,
				metadata: organization.metadata,
			})
			.from(organization)
			.where(eq(organization.id, WORKSPACE_ID))
			.limit(1);

		const website = normalizeDomain(input.website);

		if (!website) {
			throw new BadRequestException(
				"That is not a website. Enter the domain, like acme.com.",
			);
		}

		const renamed = await this.db
			.update(organization)
			.set({
				name: input.name,
				slug: workspaceSlug(input.slug ?? input.name),
				website,
				metadata: markOnboarded(before?.metadata ?? null, new Date()),
			})
			.where(eq(organization.id, WORKSPACE_ID))
			.returning({ id: organization.id });
		if (renamed.length === 0)
			throw new NotFoundException("The workspace does not exist.");

		this.logger.log({ message: "Workspace updated", userId });

		if (website !== before?.website) {
			await this.agent.workspaceChanged(
				website,
				before?.website
					? "The company using this CRM changed its website"
					: "The company using this CRM said what its website is",
			);
		}

		return this.get(userId);
	}

	async members(
		userId: string,
		input: MemberListInput,
	): Promise<ListResult<WorkspaceMember>> {
		const where = this.buildWhere(input);
		const { skip, take } = paginate(input);

		const [rows, total, roles] = await Promise.all([
			members(this.db)
				.where(where)
				.orderBy(resolveOrderBy(input, SORTABLE, asc(member.createdAt)))
				.limit(take)
				.offset(skip),
			this.db.$count(member, where),
			groupCounts(this.db, member, member.role, this.searchWhere(input.q)),
		]);

		return {
			rows: rows.map((row) => this.toMember(row, userId)),
			total,
			facetCounts: { role: countsByKey(roles, "value") },
		};
	}

	async setMemberRole(
		userId: string,
		input: SetMemberRoleInput,
	): Promise<WorkspaceMember> {
		const role = await workspaceRoleOf(userId);

		if (!canChangeRole(role)) {
			throw new ForbiddenException(
				"Only an owner or an admin can change a member's role.",
			);
		}

		const updated = await this.db.transaction(async (tx) => {
			const [target] = await tx
				.select({ id: member.id, role: member.role })
				.from(member)
				.where(
					and(
						eq(member.id, input.memberId),
						eq(member.organizationId, WORKSPACE_ID),
					),
				)
				.limit(1);

			if (!target) {
				throw new NotFoundException("That person is not in this workspace.");
			}

			if (target.role === "owner" && input.role !== "owner") {
				const owners = await tx
					.select({ id: member.id })
					.from(member)
					.where(
						and(
							eq(member.organizationId, WORKSPACE_ID),
							eq(member.role, "owner"),
						),
					)
					.for("update");

				if (owners.length <= 1) {
					throw new ForbiddenException(
						"The workspace needs an owner. Make someone else an owner first.",
					);
				}
			}

			await tx
				.update(member)
				.set({ role: input.role })
				.where(eq(member.id, target.id));

			const [row] = await members(tx).where(eq(member.id, target.id));
			if (!row)
				throw new NotFoundException("That person is not in this workspace.");
			return row;
		});

		this.logger.log({
			message: "Workspace role changed",
			userId,
			memberId: updated.id,
			role: input.role,
		});

		return this.toMember(updated, userId);
	}

	private toMember(row: MemberRow, userId: string): WorkspaceMember {
		return {
			id: row.id,
			userId: row.userId,
			name: row.user.name,
			email: row.user.email,
			image: row.user.image,
			role: toRole(row.role),
			joinedAt: row.createdAt.toISOString(),
			isViewer: row.userId === userId,
		};
	}

	private searchWhere(q: string): SQL | undefined {
		const term = q.trim();
		return and(
			eq(member.organizationId, WORKSPACE_ID),
			term
				? inArray(
						member.userId,
						this.db
							.select({ id: user.id })
							.from(user)
							.where(
								or(
									contains(user.name, term, { insensitive: true }),
									contains(user.email, term, { insensitive: true }),
								),
							),
					)
				: undefined,
		);
	}

	private buildWhere(input: MemberListInput): SQL | undefined {
		return and(
			this.searchWhere(input.q),
			input.role.length > 0 ? inArray(member.role, input.role) : undefined,
		);
	}

	private async readWorkspace() {
		const [row] = await this.db
			.select({
				id: organization.id,
				slug: organization.slug,
				name: organization.name,
				website: organization.website,
				metadata: organization.metadata,
			})
			.from(organization)
			.where(eq(organization.id, WORKSPACE_ID))
			.limit(1);
		return row ?? null;
	}
}
