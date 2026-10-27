import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations plus the `migrations.js` bundle consumed by
// `useMigrations` / `migrate` from `drizzle-orm/expo-sqlite/migrator`.
// Run: `npx drizzle-kit generate --name <slug>` from apps/mobile.
export default defineConfig({
  dialect: 'sqlite',
  driver: 'expo',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
});
