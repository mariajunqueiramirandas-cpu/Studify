// Opens the on-device SQLite database (expo-sqlite + Drizzle) and applies migrations.
// Shared by the React tree (DatabaseProvider) and headless tasks (home-screen widget, notification
// actions), which run in the same app process and must not depend on React being mounted.
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import * as schema from './schema';
import migrations from './migrations/migrations';

export const DB_NAME = 'studify.db';

export type AppDb = ExpoSQLiteDatabase<typeof schema>;
/** Accepts the root database or a transaction handle (both are BaseSQLiteDatabase). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = BaseSQLiteDatabase<'sync', any, any>;

interface OpenHandle {
  client: SQLiteDatabase;
  db: AppDb;
}

let handle: OpenHandle | null = null;
let ready = false;
let opening: Promise<AppDb> | null = null;

function openSync(): OpenHandle {
  if (handle) return handle;
  const client = openDatabaseSync(DB_NAME, { enableChangeListener: true });
  // WAL lets the widget / notification task read while the app writes.
  client.execSync('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  handle = { client, db: drizzle(client, { schema }) };
  return handle;
}

/**
 * Opens the database and runs pending migrations. Safe to call many times; the first call does the
 * work and every later call returns the same instance.
 */
export function ensureAppDatabase(): Promise<AppDb> {
  if (!opening) {
    opening = (async () => {
      const h = openSync();
      await migrate(h.db, migrations);
      ready = true;
      return h.db;
    })();
    opening.catch(() => {
      // Allow a retry on the next call after a failure.
      opening = null;
    });
  }
  return opening;
}

/** Synchronous accessor for code that runs after `ensureAppDatabase()` resolved. */
export function getAppDbSync(): AppDb {
  if (!handle || !ready) {
    throw new Error('Database used before ensureAppDatabase() resolved. Wrap the tree in <DatabaseProvider>.');
  }
  return handle.db;
}

/**
 * Empties every table (account reset): local copies, the outbox and the sync cursors, so nothing old is pushed back
 * and the next sync starts from scratch. The schema and its migration history stay.
 */
export async function wipeAppDatabase(): Promise<void> {
  await ensureAppDatabase();
  const { client } = openSync();
  const tables = client.getAllSync<{ name: string }>(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'",
  );
  client.execSync('PRAGMA foreign_keys = OFF;');
  try {
    client.withTransactionSync(() => {
      for (const { name } of tables) client.execSync(`DELETE FROM "${name.replace(/"/g, '""')}";`);
    });
  } finally {
    client.execSync('PRAGMA foreign_keys = ON;');
  }
}

export function closeAppDatabase(): void {
  if (handle) {
    handle.client.closeSync();
  }
  handle = null;
  ready = false;
  opening = null;
}
