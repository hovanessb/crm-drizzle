import { Decimal } from "decimal.js";
import { customType } from "drizzle-orm/pg-core";

export const decimal = customType<{
	data: Decimal;
	driverData: string | number;
	config: { precision: number; scale: number };
}>({
	dataType(config) {
		return config ? `numeric(${config.precision}, ${config.scale})` : "numeric";
	},
	fromDriver(value) {
		return new Decimal(value);
	},
	toDriver(value) {
		return new Decimal(value).toString();
	},
});

export const bytea = customType<{
	data: Uint8Array<ArrayBuffer>;
	driverData: Buffer | string;
}>({
	dataType() {
		return "bytea";
	},
	fromDriver(value) {
		if (Buffer.isBuffer(value)) return new Uint8Array(value);
		const hex = String(value);
		return new Uint8Array(
			Buffer.from(hex.startsWith("\\x") ? hex.slice(2) : hex, "hex"),
		);
	},
	toDriver(value) {
		return Buffer.from(value);
	},
});
