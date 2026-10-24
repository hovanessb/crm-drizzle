export async function one<Row>(rows: PromiseLike<Row[]>): Promise<Row> {
	const [row] = await rows;
	if (row === undefined) throw new Error("The query returned no row.");
	return row;
}

export async function first<Row>(
	rows: PromiseLike<Row[]>,
): Promise<Row | null> {
	const [row] = await rows;
	return row ?? null;
}
