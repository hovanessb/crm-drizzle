import {
	and,
	asc,
	type Db,
	eq,
	type FieldEntity,
	hasValues,
	isUniqueViolation,
	or,
	savedView,
} from "@crm/db";
import { parseSavedViewFilters } from "@crm/validation/saved-view";
import {
	ConflictException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import type {
	SavedView,
	SavedViewCreateInput,
	SavedViewUpdateData,
} from "./saved-views.contracts";

@Injectable()
export class SavedViewsService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async list(entity: FieldEntity, userId: string): Promise<SavedView[]> {
		const rows = await this.db
			.select()
			.from(savedView)
			.where(
				and(
					eq(savedView.entity, entity),
					or(eq(savedView.shared, true), eq(savedView.ownerId, userId)),
				),
			)
			.orderBy(asc(savedView.name));

		return rows.map((row) => this.serialize(row, userId));
	}

	async create(
		input: SavedViewCreateInput,
		userId: string,
	): Promise<SavedView> {
		try {
			const [row] = await this.db
				.insert(savedView)
				.values({
					entity: input.entity,
					name: input.name,
					shared: input.shared,
					filters: input.filters,
					ownerId: userId,
				})
				.returning();
			if (!row) throw new Error("The saved view insert returned no row.");

			return this.serialize(row, userId);
		} catch (error) {
			throw this.translate(error);
		}
	}

	async update(
		id: string,
		data: SavedViewUpdateData,
		userId: string,
	): Promise<SavedView> {
		const [existing] = await this.db
			.select()
			.from(savedView)
			.where(eq(savedView.id, id));
		if (!existing || existing.ownerId !== userId) {
			throw new NotFoundException(`No saved view with id ${id}.`);
		}

		try {
			const changes = {
				name: data.name,
				shared: data.shared,
				filters: data.filters,
			};
			const [row] = hasValues(changes)
				? await this.db
						.update(savedView)
						.set(changes)
						.where(eq(savedView.id, id))
						.returning()
				: [existing];
			if (!row) throw new NotFoundException(`No saved view with id ${id}.`);

			return this.serialize(row, userId);
		} catch (error) {
			throw this.translate(error, id);
		}
	}

	async delete(id: string, userId: string): Promise<{ id: string }> {
		const [existing] = await this.db
			.select()
			.from(savedView)
			.where(eq(savedView.id, id));
		if (!existing || existing.ownerId !== userId) {
			throw new NotFoundException(`No saved view with id ${id}.`);
		}

		const removed = await this.db
			.delete(savedView)
			.where(eq(savedView.id, id))
			.returning({ id: savedView.id });
		if (removed.length === 0)
			throw new NotFoundException(`No saved view with id ${id}.`);

		return { id };
	}

	private serialize(
		row: {
			id: string;
			entity: FieldEntity;
			name: string;
			shared: boolean;
			filters: unknown;
			ownerId: string;
			createdAt: Date;
			updatedAt: Date;
		},
		userId: string,
	): SavedView {
		return {
			id: row.id,
			entity: row.entity,
			name: row.name,
			shared: row.shared,
			filters: parseSavedViewFilters(row.filters),
			mine: row.ownerId === userId,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}

	private translate(cause: unknown, _id?: string): never {
		if (isUniqueViolation(cause)) {
			throw new ConflictException("You already have a view with that name.");
		}
		throw cause;
	}
}
