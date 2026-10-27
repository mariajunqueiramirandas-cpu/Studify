// Jest module mock for `expo-sqlite`: use with `jest.mock('expo-sqlite', () => require('<rel>/testing/expo-sqlite.mock'))`.
import { NodeSqliteClient } from './node-sqlite';

export const openDatabaseSync = (_name: string, _options?: unknown) => new NodeSqliteClient(':memory:');
export const addDatabaseChangeListener = (_listener: unknown) => ({ remove: () => undefined });
