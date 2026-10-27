// Builds an in-memory Drizzle database with the real migrations applied.
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import * as schema from '../schema';
import migrations from '../migrations/migrations';
import { NodeSqliteClient } from './node-sqlite';

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function createTestDb(): Promise<{ db: TestDb; client: NodeSqliteClient }> {
  const client = new NodeSqliteClient(':memory:');
  const db = drizzle(client as never, { schema });
  await migrate(db, migrations);
  return { db, client };
}
