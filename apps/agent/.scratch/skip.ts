import {
	company as companyTable,
	db,
	EnrichmentStatus,
	firstRow,
	requireRow,
	whereEq,
} from "@crm/db";
import { settle } from "../agent/lib/enrichment";

const company = await requireRow(db.insert(companyTable).values({
		name: "Settle Probe",
		domain: "settle-probe.test",
		enrichmentStatus: EnrichmentStatus.PENDING,
	}).returning({ id: companyTable.id, enrichmentStatus: companyTable.enrichmentStatus }));
console.log("created            ", company.enrichmentStatus);

// Exactly what runBrand does when there is no key: settle before anything marks it RUNNING.
await settle({ companyId: company.id }, EnrichmentStatus.SKIPPED, "no key");

const after = await firstRow(db.select({ enrichmentStatus: companyTable.enrichmentStatus }).from(companyTable).where(whereEq(companyTable.id, company.id)).limit(1));
console.log("after settle(SKIP) ", after?.enrichmentStatus);
console.log(
	"swept again?       ",
	after?.enrichmentStatus === "PENDING"
		? "YES — sweep re-queues PENDING"
		: "NO — stuck",
);

await requireRow(db.delete(companyTable).where(whereEq(companyTable.id, company.id)).returning());
await db.$client.end();
