import { db, type Executor } from "@crm/db";
import type { CrmEventInput } from "../src/agent/agent-trigger.service";

export function withDiscardedCrmEvents<Result>(
	work: (
		tx: Executor,
		emit: (input: CrmEventInput) => Promise<void>,
	) => Promise<Result>,
): Promise<Result> {
	return db.transaction((tx) => work(tx, async () => undefined));
}
