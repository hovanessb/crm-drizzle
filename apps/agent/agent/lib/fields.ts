import {
	and,
	asc,
	db,
	desc,
	type Executor,
	eq,
	fieldDefinition,
	fieldOption,
	fieldValue,
	firstRow,
	isNull,
	requireRow,
	whereEq,
} from "@crm/db";
import type { FieldEntity, FieldType } from "@crm/db/enums";
import {
	attachValues,
	type FieldDefinitionWithOptions,
	FieldValueError,
	fieldKeyFromLabel,
	type RecordField,
	readValue,
	recordColumn,
	type SerializedField,
	serializeField,
	usesOptions,
	writeValues,
} from "@crm/db/fields";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { currentFocus } from "./focus";

const WITH_OPTIONS = { options: { orderBy: [asc(fieldOption.position)] } };

export type { FieldEntity, FieldType, RecordField, SerializedField };

async function definitionsFor(
	entity: FieldEntity,
): Promise<FieldDefinitionWithOptions[]> {
	return db.query.fieldDefinition.findMany({
		where: and(
			eq(fieldDefinition.entity, entity),
			isNull(fieldDefinition.archivedAt),
		),
		with: WITH_OPTIONS,
		orderBy: [asc(fieldDefinition.position)],
	});
}

async function definitionWithOptions(
	executor: Executor,
	id: string,
): Promise<FieldDefinitionWithOptions> {
	const definition = await executor.query.fieldDefinition.findFirst({
		where: eq(fieldDefinition.id, id),
		with: WITH_OPTIONS,
	});
	if (!definition) throw new Error(`No field definition with id ${id}.`);
	return definition;
}

export async function listFields(
	entity: FieldEntity,
): Promise<SerializedField[]> {
	const definitions = await definitionsFor(entity);
	return definitions.map(serializeField);
}

export async function readFields(
	entity: FieldEntity,
	recordId: string,
): Promise<RecordField[]> {
	const column = recordColumn(entity);

	const [definitions, rows] = await Promise.all([
		definitionsFor(entity),
		db.select().from(fieldValue).where(eq(fieldValue[column], recordId)),
	]);

	return attachValues(definitions, rows);
}

export type WriteResult =
	| { written: true; key: string; value: unknown }
	| { written: false; reason: string };

export async function writeField(input: {
	entity: FieldEntity;
	recordId: string;
	key: string;
	value: unknown;
}): Promise<WriteResult> {
	const definitions = await definitionsFor(input.entity);
	const definition = definitions.find((entry) => entry.key === input.key);

	if (!definition) {
		return {
			written: false,
			reason: `There is no field called "${input.key}" on ${input.entity.toLowerCase()}s. Call list_fields to see what exists.`,
		};
	}

	if (!definition.agentFilled) {
		return {
			written: false,
			reason: `"${input.key}" is marked manual only, so a rep keeps it by hand.`,
		};
	}

	const isBackfill = currentFocus().taskKind === "field-backfill";

	try {
		return await db.transaction(async (tx) => {
			if (isBackfill) {
				const column = recordColumn(input.entity);
				await lockIdempotencyKey(
					tx,
					`field-value:${definition.id}:${input.recordId}`,
				);

				const row = await firstRow(
					tx
						.select()
						.from(fieldValue)
						.where(
							and(
								eq(fieldValue.fieldId, definition.id),
								eq(fieldValue[column], input.recordId),
							),
						)
						.limit(1),
				);

				if (readValue(definition, row ?? undefined) !== null) {
					return {
						written: false,
						reason: `"${input.key}" already has a value on this record. Someone filled it since this task was queued — leave it as is.`,
					};
				}
			}

			await writeValues(tx, input.entity, input.recordId, definitions, {
				[input.key]: input.value,
			});

			return { written: true, key: input.key, value: input.value };
		});
	} catch (error) {
		if (error instanceof FieldValueError) {
			return { written: false, reason: error.message };
		}

		throw error;
	}
}

export async function createField(input: {
	entity: FieldEntity;
	label: string;
	type: FieldType;
	options?: string[];
	agentBrief?: string;
}): Promise<SerializedField | { created: false; reason: string }> {
	const key = fieldKeyFromLabel(input.label);

	if (!key) {
		return { created: false, reason: "That label does not make a usable key." };
	}

	const taken = await firstRow(
		db
			.select({ id: fieldDefinition.id })
			.from(fieldDefinition)
			.where(
				and(
					whereEq(fieldDefinition.entity, input.entity),
					whereEq(fieldDefinition.key, key),
				),
			)
			.limit(1),
	);

	if (taken) {
		return {
			created: false,
			reason: `There is already a field called "${key}" on ${input.entity.toLowerCase()}s.`,
		};
	}

	if (usesOptions(input.type) && (input.options ?? []).length === 0) {
		return { created: false, reason: "A select needs at least one option." };
	}

	const last = await firstRow(
		db
			.select({ position: fieldDefinition.position })
			.from(fieldDefinition)
			.where(whereEq(fieldDefinition.entity, input.entity))
			.orderBy(desc(fieldDefinition.position))
			.limit(1),
	);

	const definition = await db.transaction(async (tx) => {
		const created = await requireRow(
			tx
				.insert(fieldDefinition)
				.values({
					entity: input.entity,
					key,
					label: input.label,
					type: input.type,
					agentBrief: input.agentBrief ?? null,
					position: (last?.position ?? -1) + 1,
				})
				.returning({ id: fieldDefinition.id }),
		);
		const options = usesOptions(input.type) ? (input.options ?? []) : [];
		if (options.length > 0) {
			await tx.insert(fieldOption).values(
				options.map((label, index) => ({
					fieldId: created.id,
					label,
					position: index,
				})),
			);
		}
		return definitionWithOptions(tx, created.id);
	});

	return serializeField(definition);
}

export async function updateFieldBrief(input: {
	entity: FieldEntity;
	key: string;
	agentBrief: string | null;
	agentFilled?: boolean;
}): Promise<SerializedField | { updated: false; reason: string }> {
	const existing = await firstRow(
		db
			.select({ id: fieldDefinition.id })
			.from(fieldDefinition)
			.where(
				and(
					whereEq(fieldDefinition.entity, input.entity),
					whereEq(fieldDefinition.key, input.key),
				),
			)
			.limit(1),
	);

	if (!existing) {
		return {
			updated: false,
			reason: `There is no field called "${input.key}".`,
		};
	}

	await db
		.update(fieldDefinition)
		.set({ agentBrief: input.agentBrief, agentFilled: input.agentFilled })
		.where(eq(fieldDefinition.id, existing.id));
	const definition = await definitionWithOptions(db, existing.id);

	return serializeField(definition);
}

export async function archiveField(input: {
	entity: FieldEntity;
	key: string;
}): Promise<{ archived: boolean; reason?: string }> {
	const existing = await firstRow(
		db
			.select({ id: fieldDefinition.id })
			.from(fieldDefinition)
			.where(
				and(
					whereEq(fieldDefinition.entity, input.entity),
					whereEq(fieldDefinition.key, input.key),
				),
			)
			.limit(1),
	);

	if (!existing) {
		return {
			archived: false,
			reason: `There is no field called "${input.key}".`,
		};
	}

	await requireRow(
		db
			.update(fieldDefinition)
			.set({ archivedAt: new Date() })
			.where(whereEq(fieldDefinition.id, existing.id))
			.returning(),
	);

	return { archived: true };
}
