// Test-only D1 stand-in. Wraps node:sqlite behind the same narrow D1Like surface players.ts
// uses (prepare().bind().first()/run()/all(), batch()), seeded from the real migration so
// tests exercise the actual schema instead of a hand-rolled approximation of it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1ResultLike, D1Row, D1StatementLike } from "../d1-types.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../../../../../db/migrations");
const MIGRATION_FILES = ["0001_init.sql", "0002_auth_hardening.sql", "0003_shadow_judgments.sql", "0004_auth_one_email_per_player.sql"];
const MIGRATION_SQL = MIGRATION_FILES.map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8")).join("\n");

// D1's bind() is `(...values: unknown[])`, so D1Like's is too; node:sqlite's is narrower
// (`SQLInputValue`, not exported by @types/node). We only ever bind strings/numbers/null, so
// this cast at the node:sqlite boundary is safe.
type SqliteBindable = null | number | bigint | string | NodeJS.ArrayBufferView;
const asBindable = (values: readonly unknown[]): SqliteBindable[] => values as SqliteBindable[];

type BoundStatement = D1StatementLike & { readonly sql: string; readonly values: readonly unknown[] };

const makeStatement = (db: DatabaseSync, sql: string, values: readonly unknown[]): BoundStatement => ({
	sql,
	values,
	bind(...nextValues: unknown[]): D1StatementLike {
		return makeStatement(db, sql, nextValues);
	},
	async first<T = D1Row>(): Promise<T | null> {
		const row = db.prepare(sql).get(...asBindable(values)) as T | undefined;
		return row ?? null;
	},
	async run<T = D1Row>(): Promise<D1ResultLike<T>> {
		return { results: db.prepare(sql).all(...asBindable(values)) as T[] };
	},
	async all<T = D1Row>(): Promise<D1ResultLike<T>> {
		return { results: db.prepare(sql).all(...asBindable(values)) as T[] };
	},
});

export class SqliteD1 implements D1Like {
	private readonly db: DatabaseSync;

	constructor() {
		this.db = new DatabaseSync(":memory:");
		this.db.exec(MIGRATION_SQL);
	}

	prepare(sql: string): D1StatementLike {
		return makeStatement(this.db, sql, []);
	}

	// D1's batch() runs every statement in one atomic transaction; mirror that so merge /
	// rotate logic that depends on all-or-nothing semantics behaves the same way under test.
	async batch<T = D1Row>(statements: D1StatementLike[]): Promise<D1ResultLike<T>[]> {
		const bound = statements as BoundStatement[];
		this.db.exec("BEGIN");
		try {
			const results = bound.map((statement) => ({
				results: this.db.prepare(statement.sql).all(...asBindable(statement.values)) as T[],
			}));
			this.db.exec("COMMIT");
			return results;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	// Direct escape hatch for test setup/assertions that don't go through players.ts.
	exec(sql: string): void {
		this.db.exec(sql);
	}

	close(): void {
		this.db.close();
	}
}
