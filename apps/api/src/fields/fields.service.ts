import {
	and,
	asc,
	company,
	contact,
	count,
	type Db,
	deal,
	desc,
	type Executor,
	eq,
	exists,
	type FieldEntity,
	fieldDefinition,
	fieldOption,
	fieldValue,
	hasValues,
	inArray,
	isNotNull,
	isNull,
	notExists,
	notInArray,
	type SQL,
} from "@crm/db";
import {
	attachValues,
	type FieldDefinitionWithOptions,
	FieldValueError,
	type FieldValueJson,
	fieldKeyFromLabel,
	type RecordField,
	readValue,
	recordColumn,
	type SerializedField,
	serializeField,
	usesOptions,
	writeValues,
} from "@crm/db/fields";
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { InjectDatabase } from "../database/database.constants";
import type {
	FieldCreateInput,
	FieldReorderInput,
	FieldUpdateData,
} from "./fields.contracts";
import { FIELDS_CONFIG } from "./fields-config";

const WITH_OPTIONS = {
	options: { orderBy: [asc(fieldOption.position)] },
};

const RECORD_TABLES = {
	COMPANY: company,
	CONTACT: contact,
	DEAL: deal,
} as const;

function recordIdColumn(entity: FieldEntity) {
	return RECORD_TABLES[entity].id;
}

function valueRecordColumn(entity: FieldEntity) {
	return fieldValue[recordColumn(entity)];
}

@Injectable()
export class FieldsService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly agent: AgentTriggerService,
	) {}

	async list(
		entity: FieldEntity,
		includeArchived: boolean,
	): Promise<SerializedField[]> {
		const definitions = await this.db.query.fieldDefinition.findMany({
			where: and(
				eq(fieldDefinition.entity, entity),
				includeArchived ? undefined : isNull(fieldDefinition.archivedAt),
			),
			with: WITH_OPTIONS,
			orderBy: [asc(fieldDefinition.position)],
		});

		return definitions.map(serializeField);
	}

	async byKey(entity: FieldEntity, key: string): Promise<SerializedField> {
		const definition = await this.db.query.fieldDefinition.findFirst({
			where: and(
				eq(fieldDefinition.entity, entity),
				eq(fieldDefinition.key, key),
			),
			with: WITH_OPTIONS,
		});

		if (!definition) throw new NotFoundException("That field does not exist.");

		return serializeField(definition);
	}

	async create(input: FieldCreateInput): Promise<SerializedField> {
		const key = fieldKeyFromLabel(input.label);

		if (!key) {
			throw new BadRequestException("That label does not make a usable key.");
		}

		const [taken] = await this.db
			.select({ id: fieldDefinition.id })
			.from(fieldDefinition)
			.where(
				and(
					eq(fieldDefinition.entity, input.entity),
					eq(fieldDefinition.key, key),
				),
			)
			.limit(1);

		if (taken) {
			throw new ConflictException(`There is already a field called "${key}".`);
		}

		if (usesOptions(input.type) && input.options.length === 0) {
			throw new BadRequestException("A select needs at least one option.");
		}

		const [last] = await this.db
			.select({ position: fieldDefinition.position })
			.from(fieldDefinition)
			.where(eq(fieldDefinition.entity, input.entity))
			.orderBy(desc(fieldDefinition.position))
			.limit(1);

		const definition = await this.db.transaction(async (tx) => {
			const [created] = await tx
				.insert(fieldDefinition)
				.values({
					entity: input.entity,
					key,
					label: input.label,
					type: input.type,
					agentFilled: input.agentFilled,
					agentBrief: input.agentBrief,
					required: input.required,
					showOnSheet: input.showOnSheet,
					showOnTable: input.showOnTable,
					showOnFilter: input.showOnFilter,
					position: (last?.position ?? -1) + 1,
				})
				.returning({ id: fieldDefinition.id });
			if (!created) throw new Error("The field insert returned no row.");

			if (usesOptions(input.type) && input.options.length > 0) {
				await tx.insert(fieldOption).values(
					input.options.map((option, index) => ({
						fieldId: created.id,
						label: option.label,
						position: index,
					})),
				);
			}

			return this.definitionById(created.id, tx);
		});

		if (definition.agentFilled) {
			const ids = await this.missingRecordIds(
				definition.entity,
				definition.id,
				FIELDS_CONFIG.backfill.maxRecordsPerRun,
			);
			await this.agent.fieldBackfillRecords(
				definition.entity,
				[definition.key],
				ids,
				`New field: ${definition.label}`,
			);
		}

		return serializeField(definition);
	}

	async update(id: string, data: FieldUpdateData): Promise<SerializedField> {
		const existing = await this.db.query.fieldDefinition.findFirst({
			where: eq(fieldDefinition.id, id),
			with: WITH_OPTIONS,
		});

		if (!existing) throw new NotFoundException("That field does not exist.");

		const type = data.type ?? existing.type;

		if (data.type && data.type !== existing.type) {
			const values = await this.db.$count(
				fieldValue,
				eq(fieldValue.fieldId, id),
			);

			if (values > 0) {
				throw new ConflictException(
					"This field already holds values, so its type cannot change. Archive it and make a new one.",
				);
			}
		}

		const optionCount = data.options
			? data.options.length
			: existing.options.filter((option) => option.archivedAt === null).length;

		if (usesOptions(type) && optionCount === 0) {
			throw new BadRequestException("A select needs at least one option.");
		}

		const definition = await this.db.transaction(async (tx) => {
			if (data.options && usesOptions(type)) {
				const keep = new Set(
					data.options
						.map((option) => option.id)
						.filter((value): value is string => Boolean(value)),
				);

				await tx
					.update(fieldOption)
					.set({ archivedAt: new Date() })
					.where(
						and(
							eq(fieldOption.fieldId, id),
							keep.size > 0 ? notInArray(fieldOption.id, [...keep]) : undefined,
							isNull(fieldOption.archivedAt),
						),
					);

				for (const [index, option] of data.options.entries()) {
					if (option.id) {
						const [moved] = await tx
							.update(fieldOption)
							.set({ label: option.label, position: index })
							.where(eq(fieldOption.id, option.id))
							.returning({ id: fieldOption.id });
						if (!moved)
							throw new NotFoundException("That option does not exist.");
						continue;
					}

					await tx
						.insert(fieldOption)
						.values({ fieldId: id, label: option.label, position: index });
				}
			}

			const changes = {
				label: data.label,
				type: data.type,
				agentFilled: data.agentFilled,
				agentBrief: data.agentBrief,
				required: data.required,
				showOnSheet: data.showOnSheet,
				showOnTable: data.showOnTable,
				showOnFilter: data.showOnFilter,
			};
			if (hasValues(changes)) {
				await tx
					.update(fieldDefinition)
					.set(changes)
					.where(eq(fieldDefinition.id, id));
			}

			return this.definitionById(id, tx);
		});

		const briefChanged =
			data.agentBrief !== undefined && data.agentBrief !== existing.agentBrief;
		const turnedOn = data.agentFilled === true && !existing.agentFilled;

		if (definition.agentFilled && (briefChanged || turnedOn)) {
			const ids = await this.missingRecordIds(
				definition.entity,
				definition.id,
				FIELDS_CONFIG.backfill.maxRecordsPerRun,
			);
			await this.agent.fieldBackfillRecords(
				definition.entity,
				[definition.key],
				ids,
				briefChanged
					? `Brief changed: ${definition.label}`
					: `Turned on: ${definition.label}`,
			);
		}

		return serializeField(definition);
	}

	async reorder(input: FieldReorderInput): Promise<SerializedField[]> {
		const owned = await this.db
			.select({ id: fieldDefinition.id })
			.from(fieldDefinition)
			.where(
				and(
					inArray(fieldDefinition.id, input.ids),
					eq(fieldDefinition.entity, input.entity),
				),
			);

		if (owned.length !== input.ids.length) {
			throw new BadRequestException(
				"That order names a field which is not on this record type.",
			);
		}

		await this.db.transaction(async (tx) => {
			for (const [index, id] of input.ids.entries()) {
				await tx
					.update(fieldDefinition)
					.set({ position: index })
					.where(eq(fieldDefinition.id, id));
			}
		});

		return this.list(input.entity, false);
	}

	async archive(id: string): Promise<SerializedField> {
		return this.setArchivedAt(id, new Date());
	}

	async restore(id: string): Promise<SerializedField> {
		return this.setArchivedAt(id, null);
	}

	private async setArchivedAt(
		id: string,
		archivedAt: Date | null,
	): Promise<SerializedField> {
		const [updated] = await this.db
			.update(fieldDefinition)
			.set({ archivedAt })
			.where(eq(fieldDefinition.id, id))
			.returning({ id: fieldDefinition.id });

		if (!updated) throw new NotFoundException("That field does not exist.");

		return serializeField(await this.definitionById(id));
	}

	async delete(id: string): Promise<{ id: string }> {
		const [deleted] = await this.db
			.delete(fieldDefinition)
			.where(eq(fieldDefinition.id, id))
			.returning({ id: fieldDefinition.id });

		if (!deleted) throw new NotFoundException("That field does not exist.");

		return { id };
	}

	private async definitionById(
		id: string,
		client: Executor = this.db,
	): Promise<FieldDefinitionWithOptions> {
		const definition = await client.query.fieldDefinition.findFirst({
			where: eq(fieldDefinition.id, id),
			with: WITH_OPTIONS,
		});

		if (!definition) throw new NotFoundException("That field does not exist.");

		return definition;
	}

	async backfill(id: string): Promise<{ queued: boolean }> {
		const [definition] = await this.db
			.select({
				entity: fieldDefinition.entity,
				key: fieldDefinition.key,
				label: fieldDefinition.label,
				agentFilled: fieldDefinition.agentFilled,
				archivedAt: fieldDefinition.archivedAt,
			})
			.from(fieldDefinition)
			.where(eq(fieldDefinition.id, id))
			.limit(1);

		if (!definition) throw new NotFoundException("That field does not exist.");

		if (!definition.agentFilled || definition.archivedAt !== null) {
			throw new BadRequestException(
				"Your agents do not fill this field, so there is nothing to run.",
			);
		}

		const ids = await this.missingRecordIds(
			definition.entity,
			id,
			FIELDS_CONFIG.backfill.maxRecordsPerRun,
		);
		const result = await this.agent.fieldBackfillRecords(
			definition.entity,
			[definition.key],
			ids,
			"Asked to fill the rest",
		);

		return { queued: result.queued > 0 || result.merged > 0 };
	}

	/** Every agent-filled field is inherently blank on a record that was just created. */
	async queueBackfillForNewRecord(
		entity: FieldEntity,
		recordId: string,
	): Promise<void> {
		await this.queueBackfillForNewRecords(entity, [recordId]);
	}

	async queueBackfillForNewRecords(
		entity: FieldEntity,
		recordIds: string[],
	): Promise<void> {
		if (recordIds.length === 0) return;
		const definitions = await this.db
			.select({ key: fieldDefinition.key })
			.from(fieldDefinition)
			.where(
				and(
					eq(fieldDefinition.entity, entity),
					isNull(fieldDefinition.archivedAt),
					eq(fieldDefinition.agentFilled, true),
				),
			);

		if (definitions.length === 0) return;

		await this.agent.fieldBackfillNewRecords(
			entity,
			definitions.map((definition) => definition.key),
			recordIds,
			"New record",
		);
	}

	private async missingRecordIds(
		entity: FieldEntity,
		fieldId: string,
		cap: number,
	): Promise<string[]> {
		const table = RECORD_TABLES[entity];
		const rows = await this.db
			.select({ id: table.id })
			.from(table)
			.where(
				notExists(
					this.db
						.select({ id: fieldValue.id })
						.from(fieldValue)
						.where(
							and(
								eq(fieldValue.fieldId, fieldId),
								eq(valueRecordColumn(entity), recordIdColumn(entity)),
							),
						),
				),
			)
			.limit(cap);

		return rows.map((row) => row.id);
	}

	async coverage(id: string): Promise<{ filled: number; total: number }> {
		const [definition] = await this.db
			.select({ entity: fieldDefinition.entity })
			.from(fieldDefinition)
			.where(eq(fieldDefinition.id, id))
			.limit(1);

		if (!definition) throw new NotFoundException("That field does not exist.");

		const [filled, total] = await Promise.all([
			this.db.$count(
				fieldValue,
				and(
					eq(fieldValue.fieldId, id),
					isNotNull(valueRecordColumn(definition.entity)),
				),
			),
			this.db.$count(RECORD_TABLES[definition.entity]),
		]);

		return { filled, total };
	}

	async definitionsFor(
		entity: FieldEntity,
		client: Executor = this.db,
	): Promise<FieldDefinitionWithOptions[]> {
		return client.query.fieldDefinition.findMany({
			where: and(
				eq(fieldDefinition.entity, entity),
				isNull(fieldDefinition.archivedAt),
			),
			with: WITH_OPTIONS,
			orderBy: [asc(fieldDefinition.position)],
		});
	}

	async valuesFor(
		entity: FieldEntity,
		recordId: string,
	): Promise<RecordField[]> {
		const [definitions, rows] = await Promise.all([
			this.definitionsFor(entity),
			this.db
				.select()
				.from(fieldValue)
				.where(eq(valueRecordColumn(entity), recordId)),
		]);

		return attachValues(definitions, rows);
	}

	async tableValuesFor(
		entity: FieldEntity,
		recordIds: string[],
	): Promise<Map<string, Record<string, FieldValueJson>>> {
		const byRecord = new Map<string, Record<string, FieldValueJson>>();

		if (recordIds.length === 0) return byRecord;

		const definitions = await this.db.query.fieldDefinition.findMany({
			where: and(
				eq(fieldDefinition.entity, entity),
				isNull(fieldDefinition.archivedAt),
				eq(fieldDefinition.showOnTable, true),
			),
			with: WITH_OPTIONS,
			orderBy: [asc(fieldDefinition.position)],
		});

		if (definitions.length === 0) return byRecord;

		const column = recordColumn(entity);

		const rows = await this.db
			.select()
			.from(fieldValue)
			.where(
				and(
					inArray(valueRecordColumn(entity), recordIds),
					inArray(
						fieldValue.fieldId,
						definitions.map((definition) => definition.id),
					),
				),
			);

		const byId = new Map(definitions.map((entry) => [entry.id, entry]));

		for (const row of rows) {
			const recordId = row[column];
			if (!recordId) continue;

			const definition = byId.get(row.fieldId);
			if (!definition) continue;

			const current = byRecord.get(recordId) ?? {};
			current[definition.key] = tableValue(
				definition,
				readValue(definition, row),
			);
			byRecord.set(recordId, current);
		}

		return byRecord;
	}

	/**
	 * SELECT and USER fields are the only types with a fixed, small
	 * vocabulary a facet can count, but only the ones an admin turned on
	 * (`showOnFilter`) actually render — same opt-in as `showOnTable`, so the
	 * filter bar doesn't fill up with every field ever created.
	 */
	async filters(entity: FieldEntity): Promise<SerializedField[]> {
		const definitions = await this.filterableFieldsFor(entity);
		return definitions.map(serializeField);
	}

	async filterableFieldsFor(
		entity: FieldEntity,
	): Promise<FieldDefinitionWithOptions[]> {
		return this.db.query.fieldDefinition.findMany({
			where: and(
				eq(fieldDefinition.entity, entity),
				isNull(fieldDefinition.archivedAt),
				eq(fieldDefinition.showOnFilter, true),
				inArray(fieldDefinition.type, ["SELECT", "USER"]),
			),
			with: WITH_OPTIONS,
			orderBy: [asc(fieldDefinition.position)],
		});
	}

	/**
	 * Counted by joining straight to the entity table through `FieldValue`'s
	 * relation, filtered by the same search/archived condition as the rest of
	 * that list's facets — never by first fetching every matching id, which
	 * would not scale past a few thousand records.
	 */
	async filterFacetCounts(
		entity: FieldEntity,
		relationWhere: SQL | undefined,
		definitions: FieldDefinitionWithOptions[],
	): Promise<Record<string, Record<string, number>>> {
		const facetCounts: Record<string, Record<string, number>> = {};
		if (definitions.length === 0) return facetCounts;

		const table = RECORD_TABLES[entity];
		const joinOn = eq(valueRecordColumn(entity), recordIdColumn(entity));
		const byId = new Map(
			definitions.map((definition) => [definition.id, definition]),
		);
		const selectIds = definitions
			.filter((definition) => definition.type === "SELECT")
			.map((definition) => definition.id);
		const userIds = definitions
			.filter((definition) => definition.type === "USER")
			.map((definition) => definition.id);

		const [selectGroups, userGroups] = await Promise.all([
			selectIds.length > 0
				? this.db
						.select({
							fieldId: fieldValue.fieldId,
							optionId: fieldValue.optionId,
							count: count(),
						})
						.from(fieldValue)
						.innerJoin(table, joinOn)
						.where(
							and(
								inArray(fieldValue.fieldId, selectIds),
								isNotNull(fieldValue.optionId),
								relationWhere,
							),
						)
						.groupBy(fieldValue.fieldId, fieldValue.optionId)
				: [],
			userIds.length > 0
				? this.db
						.select({
							fieldId: fieldValue.fieldId,
							userId: fieldValue.userId,
							count: count(),
						})
						.from(fieldValue)
						.innerJoin(table, joinOn)
						.where(
							and(
								inArray(fieldValue.fieldId, userIds),
								isNotNull(fieldValue.userId),
								relationWhere,
							),
						)
						.groupBy(fieldValue.fieldId, fieldValue.userId)
				: [],
		]);

		for (const group of selectGroups) {
			const definition = byId.get(group.fieldId);
			if (!definition || !group.optionId) continue;
			const bucket = facetCounts[definition.key] ?? {};
			facetCounts[definition.key] = bucket;
			bucket[group.optionId] = (bucket[group.optionId] ?? 0) + group.count;
		}

		for (const group of userGroups) {
			const definition = byId.get(group.fieldId);
			if (!definition || !group.userId) continue;
			const bucket = facetCounts[definition.key] ?? {};
			facetCounts[definition.key] = bucket;
			bucket[group.userId] = (bucket[group.userId] ?? 0) + group.count;
		}

		return facetCounts;
	}

	/** Translates selected filter values (by field key) into `FieldValue` `AND` conditions. */
	fieldFilters(
		entity: FieldEntity,
		definitions: FieldDefinitionWithOptions[],
		selected: Record<string, string[]>,
	): SQL[] {
		const byKey = new Map(
			definitions.map((definition) => [definition.key, definition]),
		);

		return Object.entries(selected)
			.filter(([, values]) => values.length > 0)
			.flatMap(([key, values]) => {
				const definition = byKey.get(key);
				if (!definition) return [];

				return [
					exists(
						this.db
							.select({ id: fieldValue.id })
							.from(fieldValue)
							.where(
								and(
									eq(fieldValue.fieldId, definition.id),
									eq(valueRecordColumn(entity), recordIdColumn(entity)),
									definition.type === "USER"
										? inArray(fieldValue.userId, values)
										: inArray(fieldValue.optionId, values),
								),
							),
					),
				];
			});
	}

	async applyValues(
		tx: Executor,
		entity: FieldEntity,
		recordId: string,
		values: Record<string, unknown>,
	): Promise<void> {
		if (Object.keys(values).length === 0) return;

		const definitions = await this.definitionsFor(entity, tx);

		try {
			await writeValues(tx, entity, recordId, definitions, values);
		} catch (error) {
			if (error instanceof FieldValueError) {
				throw new BadRequestException(error.message);
			}

			throw error;
		}
	}
}

function tableValue(
	definition: FieldDefinitionWithOptions,
	value: FieldValueJson,
): FieldValueJson {
	if (definition.type !== "SELECT" || typeof value !== "string") return value;

	return (
		definition.options.find((option) => option.id === value)?.label ?? null
	);
}
