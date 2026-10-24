import {
	asc,
	company,
	contact,
	contains,
	type Db,
	deal,
	eq,
	or,
} from "@crm/db";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

export type SearchHit = {
	kind: "company" | "contact" | "deal";
	id: string;
	label: string;
	detail: string | null;
	iconUrl: string | null;
	iconDarkUrl: string | null;
	iconTone: string | null;
	imageUrl: string | null;
};

const PER_KIND = 5;

@Injectable()
export class SearchService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async quick(q: string): Promise<{ hits: SearchHit[] }> {
		const term = q.trim();
		if (term.length < 2) return { hits: [] };

		const [companies, contacts, deals] = await Promise.all([
			this.db
				.select({
					id: company.id,
					name: company.name,
					domain: company.domain,
					iconUrl: company.iconUrl,
					iconDarkUrl: company.iconDarkUrl,
					iconTone: company.iconTone,
				})
				.from(company)
				.where(
					or(
						contains(company.name, term, { insensitive: true }),
						contains(company.domain, term, { insensitive: true }),
					),
				)
				.orderBy(asc(company.name))
				.limit(PER_KIND),
			this.db
				.select({
					id: contact.id,
					firstName: contact.firstName,
					lastName: contact.lastName,
					email: contact.email,
					imageUrl: contact.imageUrl,
					company: { name: company.name },
				})
				.from(contact)
				.leftJoin(company, eq(company.id, contact.companyId))
				.where(
					or(
						contains(contact.firstName, term, { insensitive: true }),
						contains(contact.lastName, term, { insensitive: true }),
						contains(contact.email, term, { insensitive: true }),
					),
				)
				.orderBy(asc(contact.lastName), asc(contact.firstName))
				.limit(PER_KIND),
			this.db
				.select({
					id: deal.id,
					name: deal.name,
					company: {
						name: company.name,
						iconUrl: company.iconUrl,
						iconDarkUrl: company.iconDarkUrl,
						iconTone: company.iconTone,
					},
				})
				.from(deal)
				.innerJoin(company, eq(company.id, deal.companyId))
				.where(contains(deal.name, term, { insensitive: true }))
				.orderBy(asc(deal.stage), asc(deal.name))
				.limit(PER_KIND),
		]);

		return {
			hits: [
				...companies.map(
					(company): SearchHit => ({
						kind: "company",
						id: company.id,
						label: company.name,
						detail: company.domain,
						iconUrl: company.iconUrl,
						iconDarkUrl: company.iconDarkUrl,
						iconTone: company.iconTone,
						imageUrl: null,
					}),
				),
				...contacts.map(
					(contact): SearchHit => ({
						kind: "contact",
						id: contact.id,
						label:
							[contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
							(contact.email ?? "Unnamed"),
						detail: contact.company?.name ?? contact.email,
						iconUrl: null,
						iconDarkUrl: null,
						iconTone: null,
						imageUrl: contact.imageUrl,
					}),
				),
				...deals.map(
					(deal): SearchHit => ({
						kind: "deal",
						id: deal.id,
						label: deal.name,
						detail: deal.company.name,
						iconUrl: deal.company.iconUrl,
						iconDarkUrl: deal.company.iconDarkUrl,
						iconTone: deal.company.iconTone,
						imageUrl: null,
					}),
				),
			],
		};
	}
}
