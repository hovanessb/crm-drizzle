import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	and,
	contactBrief,
	contactFact,
	contact as contactTable,
	db,
	eq,
	firstRow,
	requireRow,
	whereEq,
} from "@crm/db";
import type { Evidence } from "../agent/lib/evidence";
import { recordFact, writeBrief } from "../agent/lib/facts";

const suffix = process.env.TEST_RUN_ID ?? "facts-spec";
const email = `evidence.subject.${suffix}@example.test`;

let contactId: string;

const seen = (kind: Evidence["kind"], detail = "observed"): Evidence => ({
	kind,
	detail,
});

beforeAll(async () => {
	await db.delete(contactTable).where(whereEq(contactTable.email, email));
	const contact = await requireRow(
		db
			.insert(contactTable)
			.values({ firstName: "Subject", lastName: null, email })
			.returning({ id: contactTable.id }),
	);
	contactId = contact.id;
});

afterAll(async () => {
	await db.delete(contactTable).where(whereEq(contactTable.email, email));
});

describe("recordFact", () => {
	it("writes a verified fact through to the record", async () => {
		const result = await recordFact({
			contactId,
			field: "title",
			value: "Head of Security",
			evidence: [seen("crm.thread-reply"), seen("crm.signature-block")],
			method: "crm.thread",
		});

		expect(result.applied).toBe(true);
		expect(result.band).toBe("VERIFIED");

		const contact = await firstRow(
			db
				.select({ title: contactTable.title })
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.title).toBe("Head of Security");
	});

	it("fills an empty field without asking anybody", async () => {
		const result = await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/subject",
			evidence: [seen("handle.name-form"), seen("search.cites-profile")],
			method: "x.handle+citation",
		});

		expect(result.applied).toBe(true);
		expect(result.band).toBe("PROBABLE");

		const contact = await firstRow(
			db
				.select({ twitterUrl: contactTable.twitterUrl })
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.twitterUrl).toBe("https://x.com/subject");
	});

	it("fills a field the record keeps no column for", async () => {
		const result = await recordFact({
			contactId,
			field: "location",
			value: "Brooklyn, NY",
			evidence: [seen("web.cited-claim")],
			method: "web",
		});

		expect(result.applied).toBe(true);
		expect(result.band).toBe("POSSIBLE");
	});

	it("offers rather than replaces a value it already found", async () => {
		const result = await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/someone-else",
			evidence: [seen("handle.name-form"), seen("search.cites-profile")],
			method: "x.handle+citation",
		});

		expect(result.stored).toBe(true);
		expect(result.applied).toBe(false);
		expect(result.reason).toContain("already carries a value");

		const contact = await firstRow(
			db
				.select({ twitterUrl: contactTable.twitterUrl })
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.twitterUrl).toBe("https://x.com/subject");
	});

	it("puts the same suggestion in front of a rep only once", async () => {
		const result = await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/someone-else",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});

		expect(result.stored).toBe(false);
		expect(result.reason).toContain("already in front of a rep");

		const offers = await db.$count(
			contactFact,
			and(
				whereEq(contactFact.contactId, contactId),
				eq(contactFact.field, "twitterUrl"),
				eq(contactFact.status, "PROPOSED"),
			),
		);
		expect(offers).toBe(1);
	});

	it("settles the suggestions a stronger fact has answered", async () => {
		await recordFact({
			contactId,
			field: "twitterUrl",
			value: "https://x.com/the-real-one",
			evidence: [seen("profile.email-match")],
			method: "x.profile",
		});

		const facts = await db
			.select({ value: contactFact.value, status: contactFact.status })
			.from(contactFact)
			.where(
				and(
					whereEq(contactFact.contactId, contactId),
					eq(contactFact.field, "twitterUrl"),
				),
			);

		expect(facts.filter((fact) => fact.status === "PROPOSED")).toHaveLength(0);
		expect(
			facts.find((f) => f.value === "https://x.com/the-real-one")?.status,
		).toBe("APPLIED");
	});

	it("never overwrites what a person typed", async () => {
		await requireRow(
			db
				.update(contactTable)
				.set({ githubUrl: "https://github.com/typed-by-a-human" })
				.where(whereEq(contactTable.id, contactId))
				.returning(),
		);

		const result = await recordFact({
			contactId,
			field: "githubUrl",
			value: "https://github.com/found-on-the-web",
			evidence: [seen("github.account-identity")],
			method: "github.api",
		});

		expect(result.applied).toBe(false);
		expect(result.reason).toContain("A person already filled in");

		const contact = await firstRow(
			db
				.select({ githubUrl: contactTable.githubUrl })
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		expect(contact?.githubUrl).toBe("https://github.com/typed-by-a-human");
	});

	it("never re-offers a value a person dismissed", async () => {
		const offer = await recordFact({
			contactId,
			field: "title",
			value: "Head of Trust",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});
		expect(offer.applied).toBe(false);

		const proposal = await firstRow(
			db
				.select({ id: contactFact.id })
				.from(contactFact)
				.where(
					and(
						whereEq(contactFact.contactId, contactId),
						eq(contactFact.field, "title"),
						eq(contactFact.status, "PROPOSED"),
					),
				)
				.limit(1),
		);
		await requireRow(
			db
				.update(contactFact)
				.set({ status: "DISMISSED", decidedAt: new Date() })
				.where(whereEq(contactFact.id, proposal?.id))
				.returning(),
		);

		const result = await recordFact({
			contactId,
			field: "title",
			value: "Head of Trust",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});

		expect(result.stored).toBe(false);
		expect(result.reason).toContain("dismissed");
	});

	it("supersedes rather than replaces, which is how a job change is noticed", async () => {
		await recordFact({
			contactId,
			field: "employer",
			value: "Fleetio",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		await recordFact({
			contactId,
			field: "employer",
			value: "Comp AI",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		const facts = await db
			.select({ value: contactFact.value, status: contactFact.status })
			.from(contactFact)
			.where(
				and(
					whereEq(contactFact.contactId, contactId),
					eq(contactFact.field, "employer"),
				),
			);

		expect(facts).toHaveLength(2);
		expect(facts.find((f) => f.value === "Fleetio")?.status).toBe("SUPERSEDED");
		expect(facts.find((f) => f.value === "Comp AI")?.status).toBe("APPLIED");
	});

	it("lets verified evidence settle the suggestion it matches", async () => {
		const offer = await recordFact({
			contactId,
			field: "employer",
			value: "Fleetio Inc",
			evidence: [seen("web.cited-claim"), seen("search.cites-profile")],
			method: "web",
		});
		expect(offer.applied).toBe(false);

		const result = await recordFact({
			contactId,
			field: "employer",
			value: "Fleetio Inc",
			evidence: [seen("linkedin.employer-and-name")],
			method: "linkedin.profile",
		});

		expect(result.stored).toBe(true);
		expect(result.applied).toBe(true);

		const facts = await db
			.select({
				value: contactFact.value,
				status: contactFact.status,
				score: contactFact.score,
			})
			.from(contactFact)
			.where(
				and(
					whereEq(contactFact.contactId, contactId),
					eq(contactFact.field, "employer"),
				),
			);

		const live = facts.filter((fact) => fact.status === "APPLIED");
		expect(live).toHaveLength(1);
		expect(live[0]?.value).toBe("Fleetio Inc");
		expect(facts.filter((fact) => fact.status === "PROPOSED")).toHaveLength(0);
	});

	it("stores the evidence, so the score can be explained later", async () => {
		const fact = await firstRow(
			db
				.select({
					evidence: contactFact.evidence,
					score: contactFact.score,
					sourceUrl: contactFact.sourceUrl,
				})
				.from(contactFact)
				.where(
					and(
						whereEq(contactFact.contactId, contactId),
						eq(contactFact.field, "title"),
					),
				)
				.limit(1),
		);

		expect(Array.isArray(fact?.evidence)).toBe(true);
		expect(fact?.score).toBeGreaterThan(0.85);
	});
});

describe("writeBrief", () => {
	it("upserts the background panel", async () => {
		await writeBrief({
			contactId,
			narrative: "Subject is Head of Security at Example.",
			sections: { currentRole: "Head of Security · Example" },
			evidence: [seen("linkedin.employer-and-name")],
			sourceUrl: "https://www.linkedin.com/in/subject",
		});

		await writeBrief({
			contactId,
			narrative: "Subject is now VP Security at Example.",
			sections: { currentRole: "VP Security · Example" },
			evidence: [seen("linkedin.employer-and-name")],
		});

		const brief = await firstRow(
			db
				.select()
				.from(contactBrief)
				.where(whereEq(contactBrief.contactId, contactId))
				.limit(1),
		);
		expect(brief?.narrative).toBe("Subject is now VP Security at Example.");
	});

	it("refuses a brief nothing supports", async () => {
		const result = await writeBrief({
			contactId,
			narrative: "Subject seems like a great person to know.",
			sections: {},
			evidence: [seen("employer-only")],
		});

		expect(result.written).toBe(false);
	});
});
