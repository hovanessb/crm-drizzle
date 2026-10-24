import {
	isWorkspaceAdmin,
	toWorkspaceRole,
	WORKSPACE_ID,
	type WorkspaceRole,
	workspaceRoleOf,
} from "@crm/auth/organization";
import {
	agentDefinition,
	and,
	type Db,
	type Executor,
	eq,
	member,
	ne,
} from "@crm/db";
import {
	ForbiddenException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { canReadAgent, isPrivateAgentDraft } from "./agent-visibility";

@Injectable()
export class AgentAccessService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async assertMember(userId: string): Promise<WorkspaceRole> {
		const role = await workspaceRoleOf(userId);

		if (!role) {
			throw new ForbiddenException("You are not a member of this workspace.");
		}

		return role;
	}

	async assertCanManageInTransaction(
		tx: Executor,
		agentId: string,
		userId: string,
	) {
		const [membership] = await tx
			.select({ role: member.role })
			.from(member)
			.where(
				and(eq(member.organizationId, WORKSPACE_ID), eq(member.userId, userId)),
			)
			.for("share");

		if (!membership) {
			throw new ForbiddenException("You are not a member of this workspace.");
		}

		const role = toWorkspaceRole(membership.role);
		const [agent] = await tx
			.select({
				id: agentDefinition.id,
				createdById: agentDefinition.createdById,
				status: agentDefinition.status,
				name: agentDefinition.name,
				description: agentDefinition.description,
			})
			.from(agentDefinition)
			.where(
				and(
					eq(agentDefinition.id, agentId),
					ne(agentDefinition.status, "DELETED"),
				),
			)
			.limit(1);

		if (!agent) {
			throw new NotFoundException(`No agent with id ${agentId}.`);
		}

		if (isPrivateAgentDraft(agent.status) && agent.createdById !== userId) {
			throw new NotFoundException(`No agent with id ${agentId}.`);
		}

		if (agent.createdById !== userId && !isWorkspaceAdmin(role)) {
			throw new ForbiddenException(
				"Only the creator or a workspace admin can change this agent.",
			);
		}

		return agent;
	}

	async assertCanRead(agentId: string, userId: string) {
		const role = await this.assertMember(userId);
		const [agent] = await this.db
			.select({
				id: agentDefinition.id,
				createdById: agentDefinition.createdById,
				status: agentDefinition.status,
				currentVersionId: agentDefinition.currentVersionId,
			})
			.from(agentDefinition)
			.where(
				and(
					eq(agentDefinition.id, agentId),
					ne(agentDefinition.status, "DELETED"),
				),
			)
			.limit(1);

		if (!agent || !canReadAgent(agent.status, agent.createdById, userId)) {
			throw new NotFoundException(`No agent with id ${agentId}.`);
		}

		return {
			...agent,
			role,
			canManage: agent.createdById === userId || isWorkspaceAdmin(role),
		};
	}
}
