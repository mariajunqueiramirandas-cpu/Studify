// Test-only SQLite client that implements the slice of the expo-sqlite API used by
// `drizzle-orm/expo-sqlite` (prepareSync -> executeSync / executeForRawResultSync), backed by
// Node's built-in `node:sqlite`. Lets Jest run the real Drizzle schema, migrations and queries.
// Not shipped: it lives in `testing/` and is only imported by tests.
// @ts-ignore node:sqlite typings are not part of this project's @types/node yet (test-only module).
import { DatabaseSync } from 'node:sqlite';

const ROW_RETURNING = /^\s*(select|with|pragma|values)\b|\breturning\b/i;

type Params = unknown[];

class NodeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly source: string,
  ) {}

  executeSync(params: Params = []) {
    const stmt = this.db.prepare(this.source);
    if (ROW_RETURNING.test(this.source)) {
      const rows = stmt.all(...(params as never[])) as Record<string, unknown>[];
      return {
        changes: 0,
        lastInsertRowId: 0,
        getAllSync: () => rows,
        getFirstSync: () => rows[0] ?? null,
      };
    }
    const result = stmt.run(...(params as never[]));
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
      getAllSync: () => [] as unknown[],
      getFirstSync: () => null,
    };
  }

  executeForRawResultSync(params: Params = []) {
    const stmt = this.db.prepare(this.source);
    stmt.setReturnArrays(true);
    const rows = stmt.all(...(params as never[])) as unknown as unknown[][];
    return { getAllSync: () => rows };
  }
}

export class NodeSqliteClient {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  prepareSync(source: string) {
    return new NodeStatement(this.db, source);
  }

  execSync(source: string) {
    this.db.exec(source);
  }

  closeSync() {
    this.db.close();
  }

  isInTransactionSync() {
    return this.db.isTransaction;
  }
}
