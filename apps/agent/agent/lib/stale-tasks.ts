import {
	agentTask,
	and,
	asc,
	company,
	contact,
	db,
	EnrichmentStatus,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
} from "@crm/db";
import {
	MAX_ATTEMPTS,
	ownsCompanyStatus,
	ownsContactStatus,
} from "@crm/db/agent-tasks";
import { DISPATCH } from "./dispatch-config";
import { settle } from "./enrichment";
import { retireExhausted, type TaskSubject } from "./tasks";

const SCAN = DISPATCH.reconcile.scan;

const LANDED_OUTCOME =
	"The record was already up to date when this was checked again.";

const RETIRED_ERROR =
	"Research was attempted several times and never completed.";

const UNTARGETED_OUTCOME =
	"No record was ever attached to this task, so it can never be worked. Retired.";

export type StaleTaskSweep = {
	scanned: number;
	closed: number;
	retired: number;
	released: number;
	waiting: number;
	unscanned: number;
	error: string | null;
};

type OpenTask = {
	id: string;
	kind: string;
	contactId: string | null;
	companyId: string | null;
	dealId: string | null;
	attempts: number;
	leasedUntil: Date | null;
	startedAt: Date | null;
};

let lastSweep: StaleTaskSweep | null = null;

export function staleTaskSweep(): StaleTaskSweep | null {
	return lastSweep;
}

export async function retireAbandoned(): Promise<TaskSubject[]> {
	let abandoned: TaskSubject[] = [];

	try {
		abandoned = await retireExhausted();
	} catch {
		return [];
	}

	for (const task of abandoned) {
		await settle(task, EnrichmentStatus.FAILED, RETIRED_ERROR).catch(() => {});
	}

	return abandoned;
}

export async function reconcileStaleTasks(): Promise<StaleTaskSweep> {
	const sweep: StaleTaskSweep = {
		scanned: 0,
		closed: 0,
		retired: 0,
		released: 0,
		waiting: 0,
		unscanned: 0,
		error: null,
	};

	try {
		await runSweep(sweep);
	} catch (cause) {
		sweep.error = cause instanceof Error ? cause.message : String(cause);
		console.error(`[agent] Stale task reconciliation failed: ${sweep.error}`);
	}

	lastSweep = sweep;
	return sweep;
}

async function runSweep(sweep: StaleTaskSweep): Promise<void> {
	const now = new Date();

	const where = and(
		isNull(agentTask.finishedAt),
		lte(agentTask.dueAt, now),
		or(isNull(agentTask.leasedUntil), lt(agentTask.leasedUntil, now)),
	);

	const [open, tasks] = await Promise.all([
		db.$count(agentTask, where),
		db
			.select({
				id: agentTask.id,
				kind: agentTask.kind,
				contactId: agentTask.contactId,
				companyId: agentTask.companyId,
				dealId: agentTask.dealId,
				attempts: agentTask.attempts,
				leasedUntil: agentTask.leasedUntil,
				startedAt: agentTask.startedAt,
			})
			.from(agentTask)
			.where(where)
			.orderBy(asc(agentTask.dueAt))
			.limit(SCAN),
	]);

	sweep.scanned = tasks.length;
	sweep.unscanned = Math.max(0, open - tasks.length);

	const completed = await completedSubjects(tasks);

	const landed: string[] = [];
	const untargeted: string[] = [];
	const dead: string[] = [];

	for (const task of tasks) {
		if (isUntargetedFieldBackfill(task)) {
			untargeted.push(task.id);
			continue;
		}

		if (finishedElsewhere(task, completed)) {
			landed.push(task.id);
			continue;
		}

		if (task.attempts >= MAX_ATTEMPTS) continue;

		if (task.leasedUntil !== null) dead.push(task.id);
		else sweep.waiting += 1;
	}

	if (landed.length > 0) {
		const { rowCount: count } = await db
			.update(agentTask)
			.set({ finishedAt: now, outcome: LANDED_OUTCOME })
			.where(
				and(
					inArray(agentTask.id, landed),
					isNull(agentTask.finishedAt),
					or(isNull(agentTask.leasedUntil), lt(agentTask.leasedUntil, now)),
				),
			);

		sweep.closed = count ?? 0;
	}

	if (untargeted.length > 0) {
		const { rowCount: count } = await db
			.update(agentTask)
			.set({ finishedAt: now, outcome: UNTARGETED_OUTCOME })
			.where(
				and(
					inArray(agentTask.id, untargeted),
					isNull(agentTask.finishedAt),
					or(isNull(agentTask.leasedUntil), lt(agentTask.leasedUntil, now)),
				),
			);

		sweep.closed += count ?? 0;
	}

	sweep.retired = (await retireAbandoned()).length;

	if (dead.length > 0) {
		const { rowCount: count } = await db
			.update(agentTask)
			.set({ leasedUntil: null })
			.where(
				and(
					inArray(agentTask.id, dead),
					isNull(agentTask.finishedAt),
					lt(agentTask.leasedUntil, now),
				),
			);

		sweep.released = count ?? 0;
	}
}

async function completedSubjects(
	tasks: readonly OpenTask[],
): Promise<Map<string, Date>> {
	const contactIds = unique(tasks.map((task) => task.contactId));
	const companyIds = unique(tasks.map((task) => task.companyId));

	const [contacts, companies] = await Promise.all([
		contactIds.length === 0
			? []
			: db
					.select({ id: contact.id, enrichedAt: contact.enrichedAt })
					.from(contact)
					.where(
						and(
							inArray(contact.id, contactIds),
							eq(contact.enrichmentStatus, EnrichmentStatus.COMPLETE),
							isNotNull(contact.enrichedAt),
						),
					),
		companyIds.length === 0
			? []
			: db
					.select({ id: company.id, enrichedAt: company.enrichedAt })
					.from(company)
					.where(
						and(
							inArray(company.id, companyIds),
							eq(company.enrichmentStatus, EnrichmentStatus.COMPLETE),
							isNotNull(company.enrichedAt),
						),
					),
	]);

	const completed = new Map<string, Date>();

	for (const row of [...contacts, ...companies]) {
		if (row.enrichedAt) completed.set(row.id, row.enrichedAt);
	}

	return completed;
}

function finishedElsewhere(
	task: OpenTask,
	completed: Map<string, Date>,
): boolean {
	if (task.attempts === 0 || task.startedAt === null) return false;

	const subjectId = task.contactId ?? task.companyId;
	if (!subjectId) return false;

	const owns = task.contactId
		? ownsContactStatus(task.kind)
		: ownsCompanyStatus(task.kind);
	if (!owns) return false;

	const enrichedAt = completed.get(subjectId);
	if (!enrichedAt) return false;

	return enrichedAt.getTime() >= task.startedAt.getTime();
}

function isUntargetedFieldBackfill(task: OpenTask): boolean {
	return (
		task.kind === "field-backfill" &&
		!task.contactId &&
		!task.companyId &&
		!task.dealId
	);
}

function unique(ids: readonly (string | null)[]): string[] {
	return [...new Set(ids.filter((id): id is string => id !== null))];
}
