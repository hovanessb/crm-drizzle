import { and, company, EnrichmentStatus, eq, isNull } from "@crm/db";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { domainFromEmail } from "./domain";

@Injectable()
export class CompanyDirectoryService {
	private readonly logger = new Logger(CompanyDirectoryService.name);

	constructor(private readonly agent: AgentTriggerService) {}

	async companyForEmail(
		email: string,
		options: { ownerId?: string | null } = {},
	): Promise<string | null> {
		const domain = domainFromEmail(email);
		if (!domain) return null;

		const outcome = await this.agent.withCrmEvents(async (tx, emit) => {
			await lockIdempotencyKey(tx, `company-directory:${domain}`);
			const [existing] = await tx
				.select({ id: company.id })
				.from(company)
				.where(and(eq(company.domain, domain), isNull(company.archivedAt)))
				.limit(1);
			if (existing) return { id: existing.id, created: false as const };

			const [created] = await tx
				.insert(company)
				.values({
					name: domain,
					domain,
					website: `https://${domain}`,
					enrichmentStatus: EnrichmentStatus.PENDING,
					ownerId: options.ownerId ?? null,
				})
				.returning({
					id: company.id,
					name: company.name,
					domain: company.domain,
					createdAt: company.createdAt,
				});
			if (!created) throw new Error("The company insert returned no row.");
			await emit({
				type: "company.created",
				record: { kind: "company", id: created.id },
				occurredAt: created.createdAt,
				data: { name: created.name, domain: created.domain },
			});
			return { id: created.id, created: true as const };
		});
		if (!outcome.created) return outcome.id;

		await this.agent.companyCreated(
			outcome.id,
			`Created from an email domain (${domain}) — it has no name but the domain`,
		);

		this.logger.log({
			message: "Company created from an email domain",
			companyId: outcome.id,
			domain,
		});

		return outcome.id;
	}
}
