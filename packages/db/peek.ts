import { count } from "drizzle-orm";
import { db } from "./src/client";
import {
	agentDefinition,
	formSubmission,
	trackedDomain,
	trackedEvent,
} from "./src/schema/schema";

console.log(
	"trackedDomain:",
	await db
		.select({
			host: trackedDomain.host,
			scope: trackedDomain.scope,
			pageViews: trackedDomain.pageViews,
		})
		.from(trackedDomain),
);
console.log(
	"trackedEvent hosts:",
	await db
		.select({ host: trackedEvent.host, count: count() })
		.from(trackedEvent)
		.groupBy(trackedEvent.host),
);
console.log(
	"formSubmission:",
	await db
		.select({
			host: formSubmission.host,
			email: formSubmission.email,
			filedAt: formSubmission.filedAt,
		})
		.from(formSubmission),
);
console.log(
	"agentDefinitions:",
	await db
		.select({
			id: agentDefinition.id,
			name: agentDefinition.name,
			createdAt: agentDefinition.createdAt,
		})
		.from(agentDefinition),
);

await db.$client.end();
