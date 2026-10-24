import {
	agentTask,
	and,
	type Db,
	eq,
	inArray,
	isNull,
	lte,
	type SQL,
} from "@crm/db";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

@Injectable()
export class AgentQueueService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async queuedCompanies(ids: readonly string[]): Promise<Set<string>> {
		if (ids.length === 0) return new Set();

		const rows = await this.db
			.selectDistinct({ companyId: agentTask.companyId })
			.from(agentTask)
			.where(this.due(inArray(agentTask.companyId, [...ids])));

		return this.identifiers(rows.map((row) => row.companyId));
	}

	async queuedContacts(ids: readonly string[]): Promise<Set<string>> {
		if (ids.length === 0) return new Set();

		const rows = await this.db
			.selectDistinct({ contactId: agentTask.contactId })
			.from(agentTask)
			.where(this.due(inArray(agentTask.contactId, [...ids])));

		return this.identifiers(rows.map((row) => row.contactId));
	}

	async isQueued(subject: {
		companyId?: string;
		contactId?: string;
	}): Promise<boolean> {
		const [row] = await this.db
			.select({ id: agentTask.id })
			.from(agentTask)
			.where(
				this.due(
					and(
						subject.companyId
							? eq(agentTask.companyId, subject.companyId)
							: undefined,
						subject.contactId
							? eq(agentTask.contactId, subject.contactId)
							: undefined,
					),
				),
			)
			.limit(1);

		return row !== undefined;
	}

	private due(subject: SQL | undefined): SQL | undefined {
		return and(
			subject,
			isNull(agentTask.finishedAt),
			lte(agentTask.dueAt, new Date()),
		);
	}

	private identifiers(values: (string | null)[]): Set<string> {
		return new Set(values.filter((value): value is string => value !== null));
	}
}
