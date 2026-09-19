// The subset of the D1 API players.ts uses: prepare().bind().first()/run()/all(), and batch().
// `platform.env.DB` (a real D1Database, from wrangler's generated types) satisfies this shape
// structurally, and so does the node:sqlite adapter in ./testing/sqlite-d1.ts used by tests.
// Keeping this narrow (rather than depending on the ambient D1Database class directly) is what
// lets a plain object stand in for D1 in tests without reimplementing methods we never call.
export type D1Row = Record<string, unknown>;

export type D1ResultLike<T = D1Row> = {
	results: T[];
};

export type D1StatementLike = {
	bind(...values: unknown[]): D1StatementLike;
	first<T = D1Row>(): Promise<T | null>;
	run<T = D1Row>(): Promise<D1ResultLike<T>>;
	all<T = D1Row>(): Promise<D1ResultLike<T>>;
};

export type D1Like = {
	prepare(query: string): D1StatementLike;
	batch<T = D1Row>(statements: D1StatementLike[]): Promise<D1ResultLike<T>[]>;
};
