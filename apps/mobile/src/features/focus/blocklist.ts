// WEL-02.1 apps the student chose to block, in the device-only focus_blocklist table (data-model §7). The list
// never leaves the phone (WEL-02.5).
import { eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { useLive } from '../../db/hooks';
import { focusBlocklist } from '../../db/schema';
import type { InstalledApp } from '../../platform/types';

export function blockedPackages(db: AppDb): string[] {
  return db.select({ p: focusBlocklist.packageName }).from(focusBlocklist).all().map((r) => r.p);
}

export function setAppBlocked(db: AppDb, app: InstalledApp, blocked: boolean): void {
  if (blocked) {
    db.insert(focusBlocklist).values({ packageName: app.packageName, label: app.label }).onConflictDoUpdate({ target: focusBlocklist.packageName, set: { label: app.label } }).run();
  } else {
    db.delete(focusBlocklist).where(eq(focusBlocklist.packageName, app.packageName)).run();
  }
}

export function useBlocklist() {
  return useLive((db) => blockedPackages(db), { tables: ['focus_blocklist'] });
}
