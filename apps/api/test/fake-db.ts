import {
	type Db,
	type Decimal,
	getTableName,
	PgDialect,
	type PgTable,
	QueryPromise,
	type SQL,
} from "@crm/db";

const dialect = new PgDialect();

export function rendered(where: SQL | undefined) {
	if (!where) return null;
	const { sql, params } = dialect.sqlToQuery(where);
	return { sql, params };
}

export type Cell =
	| string
	| number
	| boolean
	| Date
	| null
	| undefined
	| SQL
	| Uint8Array
	| Decimal
	| Cell[]
	| { [key: string]: Cell };

export type Row = { [column: string]: Cell };

export type FakeCall = {
	op: "select" | "insert" | "update" | "delete";
	table: string;
	values?: Row | Row[];
	set?: Row;
	conflict?: { set?: Row };
	where?: SQL;
};

type Rows = Row[] | Promise<Row[]>;

export type FakeHandlers = {
	select?: (table: string, call: FakeCall) => Rows;
	count?: (table: string, where: SQL | undefined) => number;
	insert?: (call: FakeCall) => Rows;
	update?: (call: FakeCall) => Rows;
	delete?: (call: FakeCall) => Rows;
	query?: {
		[table: string]: {
			findFirst?: () => Row | undefined;
			findMany?: () => Row[];
		};
	};
};

class FakeQuery extends QueryPromise<Row[]> {
	constructor(
		private readonly call: FakeCall,
		private readonly run: (call: FakeCall) => Promise<Row[]>,
	) {
		super();
	}

	override execute(): Promise<Row[]> {
		return this.run(this.call);
	}

	from(table: PgTable) {
		this.call.table = getTableName(table);
		return this;
	}

	where(where: SQL) {
		this.call.where = where;
		return this;
	}

	values(values: Row | Row[]) {
		this.call.values = values;
		return this;
	}

	set(set: Row) {
		this.call.set = set;
		return this;
	}

	onConflictDoUpdate(conflict: { set?: Row }) {
		this.call.conflict = conflict;
		return this;
	}

	onConflictDoNothing() {
		return this;
	}

	limit() {
		return this;
	}

	offset() {
		return this;
	}

	orderBy() {
		return this;
	}

	groupBy() {
		return this;
	}

	returning() {
		return this;
	}

	innerJoin() {
		return this;
	}

	leftJoin() {
		return this;
	}

	for() {
		return this;
	}
}

type FakeExecutor = {
	query: FakeHandlers["query"];
	select: () => FakeQuery;
	insert: (table: PgTable) => FakeQuery;
	update: (table: PgTable) => FakeQuery;
	delete: (table: PgTable) => FakeQuery;
	$count: (table: PgTable, where?: SQL) => Promise<number>;
	transaction: <Result>(
		work: (tx: FakeExecutor) => Promise<Result>,
	) => Promise<Result>;
};

export function fakeDb(handlers: FakeHandlers) {
	const calls: FakeCall[] = [];

	const run = async (call: FakeCall): Promise<Row[]> => {
		calls.push(call);
		if (call.op === "select")
			return (await handlers.select?.(call.table, call)) ?? [];
		return (await handlers[call.op]?.(call)) ?? [];
	};

	const query = new Proxy(
		{},
		{
			get: (_target, name: string) => ({
				findFirst: async () => handlers.query?.[name]?.findFirst?.(),
				findMany: async () => handlers.query?.[name]?.findMany?.() ?? [],
			}),
		},
	);

	const fake: FakeExecutor = {
		query,
		select: () => new FakeQuery({ op: "select", table: "" }, run),
		insert: (table) =>
			new FakeQuery({ op: "insert", table: getTableName(table) }, run),
		update: (table) =>
			new FakeQuery({ op: "update", table: getTableName(table) }, run),
		delete: (table) =>
			new FakeQuery({ op: "delete", table: getTableName(table) }, run),
		$count: async (table, where) => {
			calls.push({ op: "select", table: getTableName(table), where });
			return handlers.count?.(getTableName(table), where) ?? 0;
		},
		transaction: (work) => work(fake),
	};

	return { db: fake as unknown as Db, calls };
}
