import {
	and,
	contactFact,
	contact as contactTable,
	db,
	desc,
	eq,
	FactStatus,
	inArray,
	ne,
	requireRow,
	whereEq,
} from "@crm/db";
import {
	canonicalValue,
	type FactField,
	type FactSubject,
	factColumn,
	fillsBlank,
} from "./facts";
import { splitName } from "./names";

const SCAN = 2000;

const MAX_FILLS = 500;

const CONTACT_SELECT = {
	id: true,
	email: true,
	firstName: true,
	lastName: true,
	title: true,
	seniority: true,
	function: true,
	linkedinUrl: true,
	twitterUrl: true,
	githubUrl: true,
} as const;

export type BlankFactFill = {
	contactId: string;
	contact: string;
	field: FactField;
	value: string;
	score: number;
	dropped: number;
};

export type BlankFactSweep = {
	scanned: number;
	filled: number;
	settled: number;
	waiting: number;
	unscanned: number;
	fills: BlankFactFill[];
};

export async function sweepBlankFacts(
	options: { dry?: boolean } = {},
): Promise<BlankFactSweep> {
	const [pending, proposals] = await Promise.all([
		db.$count(contactFact, eq(contactFact.status, FactStatus.PROPOSED)),
		db.query.contactFact.findMany({
			where: eq(contactFact.status, FactStatus.PROPOSED),
			columns: {
				id: true,
				contactId: true,
				field: true,
				value: true,
				score: true,
			},
			with: { contact: { columns: CONTACT_SELECT } },
			orderBy: [desc(contactFact.score), desc(contactFact.observedAt)],
			limit: SCAN,
		}),
	]);

	const sweep: BlankFactSweep = {
		scanned: proposals.length,
		filled: 0,
		settled: 0,
		waiting: 0,
		unscanned: Math.max(0, pending - proposals.length),
		fills: [],
	};

	if (proposals.length === 0) return sweep;

	const applied = await appliedValues([
		...new Set(proposals.map((row) => row.contactId)),
	]);

	for (const group of groupByField(proposals)) {
		const [best] = group;
		const field = best.field as FactField;
		const contact: FactSubject = best.contact;
		const column = factColumn(field);
		const current = applied.get(key(best.contactId, field));

		if (!fillsBlank({ field, contact, hasAgentFact: current !== undefined })) {
			const value = current ?? (column ? contact[column] : null);
			const stale = redundant(group, value);

			sweep.waiting += group.length - stale.length;
			if (stale.length === 0) continue;

			if (!options.dry) {
				await db
					.update(contactFact)
					.set({ status: FactStatus.SUPERSEDED, supersededAt: new Date() })
					.where(
						inArray(
							contactFact.id,
							stale.map((row) => row.id),
						),
					);
			}

			sweep.settled += stale.length;
			continue;
		}

		if (sweep.filled >= MAX_FILLS) {
			sweep.waiting += group.length;
			continue;
		}

		if (!options.dry) {
			await fill(best.id, best.contactId, field, best.value, column);
		}

		sweep.filled += 1;
		sweep.settled += group.length - 1;
		sweep.fills.push({
			contactId: best.contactId,
			contact: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
			field,
			value: best.value,
			score: best.score,
			dropped: group.length - 1,
		});
	}

	return sweep;
}

type Proposal = {
	id: string;
	contactId: string;
	field: string;
	value: string;
	score: number;
	contact: {
		id: string;
		email: string | null;
		firstName: string;
		lastName: string | null;
		title: string | null;
		seniority: string | null;
		function: string | null;
		linkedinUrl: string | null;
		twitterUrl: string | null;
		githubUrl: string | null;
	};
};

async function appliedValues(
	contactIds: string[],
): Promise<Map<string, string>> {
	const values = new Map<string, string>();

	for (let start = 0; start < contactIds.length; start += 1000) {
		const rows = await db
			.select({
				contactId: contactFact.contactId,
				field: contactFact.field,
				value: contactFact.value,
			})
			.from(contactFact)
			.where(
				and(
					eq(contactFact.status, FactStatus.APPLIED),
					inArray(contactFact.contactId, contactIds.slice(start, start + 1000)),
				),
			);

		for (const row of rows)
			values.set(key(row.contactId, row.field), row.value);
	}

	return values;
}

function groupByField(proposals: Proposal[]): [Proposal, ...Proposal[]][] {
	const groups = new Map<string, [Proposal, ...Proposal[]]>();

	for (const row of proposals) {
		const id = key(row.contactId, row.field);
		const group = groups.get(id);
		if (group) group.push(row);
		else groups.set(id, [row]);
	}

	return [...groups.values()];
}

function redundant(group: Proposal[], value: string | null): Proposal[] {
	const onRecord = value ? canonicalValue(value) : null;
	const kept = new Set<string>();

	return group.filter((row) => {
		const seen = canonicalValue(row.value);
		if (seen === onRecord) return true;
		if (kept.has(seen)) return true;

		kept.add(seen);
		return false;
	});
}

async function fill(
	factId: string,
	contactId: string,
	field: FactField,
	value: string,
	column: string | null,
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(contactFact)
			.set({ status: FactStatus.SUPERSEDED, supersededAt: new Date() })
			.where(
				and(
					whereEq(contactFact.contactId, contactId),
					whereEq(contactFact.field, field),
					ne(contactFact.id, factId),
					inArray(contactFact.status, [
						FactStatus.APPLIED,
						FactStatus.PROPOSED,
					]),
				),
			);

		await requireRow(
			tx
				.update(contactFact)
				.set({ status: FactStatus.APPLIED })
				.where(whereEq(contactFact.id, factId))
				.returning(),
		);

		if (column) {
			await requireRow(
				tx
					.update(contactTable)
					.set({ [column]: value })
					.where(whereEq(contactTable.id, contactId))
					.returning(),
			);
		}

		if (field === "name") {
			const split = splitName(value);
			if (split) {
				await requireRow(
					tx
						.update(contactTable)
						.set({ firstName: split.firstName, lastName: split.lastName })
						.where(whereEq(contactTable.id, contactId))
						.returning(),
				);
			}
		}
	});
}

function key(contactId: string, field: string): string {
	return `${contactId}:${field}`;
}
