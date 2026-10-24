import {
	and,
	asc,
	company,
	contact,
	contains,
	type Db,
	eq,
	isNotNull,
	isNull,
	type NewCompany,
	not,
	or,
	type SQL,
	user,
} from "@crm/db";
import { blobEnabled, mirror } from "@crm/db/blob";
import {
	BLOB_HOST_SUFFIX,
	COMPANY_IMAGE_FIELDS,
	type CompanyImageField,
} from "@crm/db/images";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

const MAX_PER_SWEEP = 25;

type CompanyImageRow = Record<CompanyImageField, string | null>;

const EXTERNAL_CONTACT_IMAGE = and(
	isNotNull(contact.imageUrl),
	not(contains(contact.imageUrl, BLOB_HOST_SUFFIX)),
);

const EXTERNAL_USER_IMAGE = and(
	isNotNull(user.image),
	not(contains(user.image, BLOB_HOST_SUFFIX)),
);

export type ImageMirrorResult = {
	scanned: number;
	copied: number;
};

@Injectable()
export class ImageMirrorService {
	private readonly logger = new Logger(ImageMirrorService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async sweep(): Promise<ImageMirrorResult> {
		if (!blobEnabled()) return { scanned: 0, copied: 0 };

		const results = [
			await this.sweepCompanies(),
			await this.sweepContacts(),
			await this.sweepUsers(),
		];

		const total = results.reduce(
			(sum, result) => ({
				scanned: sum.scanned + result.scanned,
				copied: sum.copied + result.copied,
			}),
			{ scanned: 0, copied: 0 },
		);

		if (total.copied > 0) {
			this.logger.log({ message: "Mirrored external images", ...total });
		}

		return total;
	}

	private async sweepCompanies(): Promise<ImageMirrorResult> {
		const rows = await this.db
			.select({
				id: company.id,
				logoUrl: company.logoUrl,
				logoDarkUrl: company.logoDarkUrl,
				iconUrl: company.iconUrl,
				iconDarkUrl: company.iconDarkUrl,
			})
			.from(company)
			.where(or(...COMPANY_IMAGE_FIELDS.map(externalCompanyImage)))
			.orderBy(asc(company.createdAt))
			.limit(MAX_PER_SWEEP);

		let copied = 0;

		for (const row of rows) {
			const data: Partial<NewCompany> = {};

			for (const field of COMPANY_IMAGE_FIELDS) {
				const current = row[field];
				if (!current) continue;

				const stored = await mirror(current, `companies/${row.id}/${field}`);
				if (!stored || stored === current) continue;

				data[field] = stored;
				copied += 1;
			}

			if (Object.keys(data).length === 0) continue;

			await this.db
				.update(company)
				.set(data)
				.where(and(eq(company.id, row.id), unchanged(row)));
		}

		return { scanned: rows.length, copied };
	}

	private async sweepContacts(): Promise<ImageMirrorResult> {
		const rows = await this.db
			.select({ id: contact.id, imageUrl: contact.imageUrl })
			.from(contact)
			.where(EXTERNAL_CONTACT_IMAGE)
			.orderBy(asc(contact.createdAt))
			.limit(MAX_PER_SWEEP);

		let copied = 0;

		for (const row of rows) {
			if (!row.imageUrl) continue;

			const stored = await mirror(row.imageUrl, `contacts/${row.id}`);
			if (!stored || stored === row.imageUrl) continue;

			const changed = await this.db
				.update(contact)
				.set({ imageUrl: stored })
				.where(and(eq(contact.id, row.id), eq(contact.imageUrl, row.imageUrl)))
				.returning({ id: contact.id });

			copied += changed.length;
		}

		return { scanned: rows.length, copied };
	}

	private async sweepUsers(): Promise<ImageMirrorResult> {
		const rows = await this.db
			.select({ id: user.id, image: user.image })
			.from(user)
			.where(EXTERNAL_USER_IMAGE)
			.limit(MAX_PER_SWEEP);

		let copied = 0;

		for (const row of rows) {
			if (!row.image) continue;

			const stored = await mirror(row.image, `users/${row.id}/avatar`);
			if (!stored || stored === row.image) continue;

			const changed = await this.db
				.update(user)
				.set({ image: stored })
				.where(and(eq(user.id, row.id), eq(user.image, row.image)))
				.returning({ id: user.id });

			copied += changed.length;
		}

		return { scanned: rows.length, copied };
	}
}

function externalCompanyImage(field: CompanyImageField): SQL | undefined {
	return and(
		isNotNull(company[field]),
		not(contains(company[field], BLOB_HOST_SUFFIX)),
	);
}

function unchanged(row: CompanyImageRow): SQL | undefined {
	return and(
		...COMPANY_IMAGE_FIELDS.map((field) => {
			const value = row[field];
			return value === null
				? isNull(company[field])
				: eq(company[field], value);
		}),
	);
}
