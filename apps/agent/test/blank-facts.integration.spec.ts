import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	and,
	contactFact,
	contact as contactTable,
	db,
	eq,
	FactBand,
	FactStatus,
	firstRow,
	requireRow,
	whereEq,
} from "@crm/db";
import { sweepBlankFacts } from "../agent/lib/blank-facts";

const suffix = process.env.TEST_RUN_ID ?? "blank-facts-spec";
const email = `blank.subject.${suffix}@example.test`;

let contactId: string;

async function propose(input: {
	field: string;
	value: string;
	score: number;
}): Promise<string> {
	const fact = await requireRow(
		db
			.insert(contactFact)
			.values({
				contactId,
				field: input.field,
				value: input.value,
				score: input.score,
				band: input.score >= 0.55 ? FactBand.PROBABLE : FactBand.POSSIBLE,
				evidence: [{ kind: "web.cited-claim", detail: "a page said so" }],
				method: "web",
				status: FactStatus.PROPOSED,
			})
			.returning({ id: contactFact.id }),
	);

	return fact.id;
}

function statusOf(id: string) {
	return db
		.select({ status: contactFact.status })
		.from(contactFact)
		.where(eq(contactFact.id, id))
		.then(([fact]) => fact?.status);
}

beforeEach(async () => {
	await db.delete(contactTable).where(whereEq(contactTable.email, email));
	const contact = await requireRow(
		db
			.insert(contactTable)
			.values({ firstName: "Blank", lastName: "Subject", email })
			.returning({ id: contactTable.id }),
	);
	contactId = contact.id;
});

afterAll(async () => {
	await db.delete(contactTable).where(whereEq(contactTable.email, email));
});

describe("sweepBlankFacts", () => {
	it("fills an empty field from the best-evidenced suggestion", async () => {
		const weak = await propose({
			field: "linkedinUrl",
			value: "https://www.linkedin.com/in/maybe",
			score: 0.35,
		});
		const strong = await propose({
			field: "linkedinUrl",
			value: "https://www.linkedin.com/in/subject",
			score: 0.61,
		});

		const sweep = await sweepBlankFacts();

		expect(sweep.filled).toBe(1);
		expect(await statusOf(strong)).toBe("APPLIED");
		expect(await statusOf(weak)).toBe("SUPERSEDED");

		const contact = await firstRow(
			db
				.select({ linkedinUrl: contactTable.linkedinUrl })
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.linkedinUrl).toBe("https://www.linkedin.com/in/subject");
	});

	it("leaves a suggestion that disagrees with what is already there", async () => {
		await requireRow(
			db
				.update(contactTable)
				.set({ title: "Head of Security" })
				.where(whereEq(contactTable.id, contactId))
				.returning(),
		);

		const offer = await propose({
			field: "title",
			value: "VP Security",
			score: 0.61,
		});

		const sweep = await sweepBlankFacts();

		expect(sweep.filled).toBe(0);
		expect(sweep.waiting).toBe(1);
		expect(await statusOf(offer)).toBe("PROPOSED");
	});

	it("clears a suggestion that only repeats the record", async () => {
		await requireRow(
			db
				.update(contactTable)
				.set({ title: "Head of Security" })
				.where(whereEq(contactTable.id, contactId))
				.returning(),
		);

		const echo = await propose({
			field: "title",
			value: "head of security",
			score: 0.61,
		});

		const sweep = await sweepBlankFacts();

		expect(sweep.settled).toBe(1);
		expect(sweep.waiting).toBe(0);
		expect(await statusOf(echo)).toBe("SUPERSEDED");
	});

	it("clears a suggestion that differs only by a trailing slash", async () => {
		await requireRow(
			db
				.update(contactTable)
				.set({ linkedinUrl: "https://www.linkedin.com/in/pogrebs" })
				.where(whereEq(contactTable.id, contactId))
				.returning(),
		);

		const echo = await propose({
			field: "linkedinUrl",
			value: "https://www.linkedin.com/in/pogrebs/",
			score: 0.61,
		});

		const sweep = await sweepBlankFacts();

		expect(sweep.settled).toBe(1);
		expect(sweep.waiting).toBe(0);
		expect(await statusOf(echo)).toBe("SUPERSEDED");
	});

	it("keeps one of two suggestions offering the same value", async () => {
		await requireRow(
			db
				.update(contactTable)
				.set({ title: "Head of Security" })
				.where(whereEq(contactTable.id, contactId))
				.returning(),
		);

		await propose({ field: "title", value: "VP Security", score: 0.61 });
		await propose({ field: "title", value: "VP Security", score: 0.61 });

		await sweepBlankFacts();

		const left = await db.$count(
			contactFact,
			and(
				whereEq(contactFact.contactId, contactId),
				eq(contactFact.field, "title"),
				eq(contactFact.status, FactStatus.PROPOSED),
			),
		);
		expect(left).toBe(1);
	});

	it("counts without writing when it is only reading", async () => {
		const offer = await propose({
			field: "githubUrl",
			value: "https://github.com/subject",
			score: 0.4,
		});

		const sweep = await sweepBlankFacts({ dry: true });

		expect(sweep.filled).toBe(1);
		expect(await statusOf(offer)).toBe("PROPOSED");

		const contact = await firstRow(
			db
				.select({ githubUrl: contactTable.githubUrl })
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.githubUrl).toBeNull();
	});
});
