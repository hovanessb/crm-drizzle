export type JsonObject = { [key in string]?: JsonValue };

export type JsonArray = JsonValue[];

export type JsonValue =
	| string
	| number
	| boolean
	| JsonObject
	| JsonArray
	| null;

export type InputJsonObject = { readonly [key: string]: InputJsonValue | null };

export type InputJsonArray = ReadonlyArray<InputJsonValue | null>;

export type InputJsonValue =
	| string
	| number
	| boolean
	| InputJsonObject
	| InputJsonArray;
