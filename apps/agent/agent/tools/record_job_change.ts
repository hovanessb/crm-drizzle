import {
	contact as contactTable,
	db,
	firstRow,
	requireRow,
	whereEq,
} from "@crm/db";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { sensitiveWrite } from "../lib/approval";
import { writeTimelineNote } from "../lib/crm";
import { lastEmployerChange } from "../lib/facts";
import { focusOn } from "../lib/focus";
import { assertResearchPurpose } from "../lib/session-purpose";

export default defineTool({
	description:
		"Raise a job change on a contact's timeline and task their owner. Reads the change from the facts already recorded; call it after recording a new employer.",
	inputSchema: z.object({
		contactId: z.string(),
		moveToCompanyId: z
			.string()
			.optional()
			.describe(
				"Only when the new employer is already a company in the CRM and a person has approved the move.",
			),
	}),
	approval: sensitiveWrite(
		"Raise the change without `moveToCompanyId` — the alert lands on the timeline and their owner decides whether to move them.",
	),
	async execute({ contactId, moveToCompanyId }, ctx) {
		assertResearchPurpose(ctx);
		focusOn({ contactId });

		const change = await lastEmployerChange(contactId);
		if (!change) {
			return {
				raised: false as const,
				reason: "No employer change on the facts for this contact.",
			};
		}

		const contact = await firstRow(
			db
				.select({
					firstName: contactTable.firstName,
					lastName: contactTable.lastName,
					ownerId: contactTable.ownerId,
					companyId: contactTable.companyId,
				})
				.from(contactTable)
				.where(whereEq(contactTable.id, contactId))
				.limit(1),
		);
		if (!contact) return { raised: false as const, reason: "No such contact." };

		const name = [contact.firstName, contact.lastName]
			.filter(Boolean)
			.join(" ");

		await writeTimelineNote(
			contactId,
			`${name} has moved to ${change.to}`,
			[
				`${name} appears to have left ${change.from} for ${change.to}.`,
				change.sourceUrl ?? "",
				"",
				"Worth a conversation either way: a champion in a new seat is the",
				"warmest introduction there is, and their replacement at the old",
				"account is a relationship nobody owns yet.",
			]
				.filter(Boolean)
				.join("\n"),
			{ source: "job-change", from: change.from, to: change.to },
		);

		if (moveToCompanyId) {
			await requireRow(
				db
					.update(contactTable)
					.set({ companyId: moveToCompanyId })
					.where(whereEq(contactTable.id, contactId))
					.returning(),
			);
		}

		return {
			raised: true as const,
			from: change.from,
			to: change.to,
			moved: Boolean(moveToCompanyId),
			ownerNotified: contact.ownerId !== null,
		};
	},
});
