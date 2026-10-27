// Maps server rows (snake_case JSON from PostgREST) to Drizzle insert values (camelCase keys).
import { getTableColumns, type Column } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { parseInstantMs } from './clock';

/** Server column names to select for a pull: every mirrored column except local bookkeeping. */
export function selectColumnsFor(table: SQLiteTable): string[] {
  return Object.values(getTableColumns(table))
    .map((col) => col.name)
    .filter((name) => name !== '_pulled_at');
}

/** Server column name for a JS key of a local table. */
export function dbColumnName(table: SQLiteTable, key: string): string {
  const col = getTableColumns(table)[key];
  if (!col) throw new Error(`Unknown column "${key}" on table "${table.getSQL ? '' : ''}"`);
  return col.name;
}

export function isInstantColumn(col: Column): boolean {
  return col.columnType === 'SQLiteTimestamp';
}

/** Converts one server row to Drizzle insert values. Instants become `Date`, json stays as parsed JSON. */
export function serverRowToValues(table: SQLiteTable, row: Record<string, unknown>, pulledAt: Date): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    if (col.name === '_pulled_at') {
      values[key] = pulledAt;
      continue;
    }
    let value: unknown = row[col.name] ?? null;
    if (value !== null && isInstantColumn(col) && typeof value === 'string') {
      value = new Date(parseInstantMs(value));
    }
    values[key] = value;
  }
  return values;
}

/** Primary-key values (JS keys) of a row, in the order given by `pk`. */
export function keyValues(values: Record<string, unknown>, pk: readonly string[]): (string | number)[] {
  return pk.map((key) => {
    const v = values[key];
    return typeof v === 'number' ? v : String(v);
  });
}
