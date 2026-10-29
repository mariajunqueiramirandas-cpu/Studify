// Energy-aware study (GOL-10). performance_windows is computed by the worker (energy.windows); the app reads the
// good buckets to order Hoje, suggest reminder times and place calendar blocks.
import { ENERGY } from '@studify/shared';
import { useQuery } from '@tanstack/react-query';
import { data as callData } from '../../api/data';
import { useSession } from '../auth/session';

export interface WindowRow {
  bucket: number;
  n_events: number;
  mean_residual: number;
  ci_low: number | null;
  ci_high: number | null;
  good: boolean;
}

export interface EnergyWindows {
  rows: WindowRow[];
  /** Up to 2 good buckets, best first (empty until there is enough data, GOL-10.1). */
  best: number[];
}

export function usePerformanceWindows() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['performanceWindows', userId],
    enabled: !!userId,
    staleTime: 6 * 3600_000,
    queryFn: async (): Promise<EnergyWindows> => {
      const data = await callData<WindowRow[]>('energy-windows').catch(() => [] as WindowRow[]);
      const best = data
        .filter((w) => w.good)
        .sort((a, b) => b.mean_residual - a.mean_residual || a.bucket - b.bucket)
        .slice(0, ENERGY.maxGoodWindows)
        .map((w) => w.bucket);
      return { rows: data, best };
    },
  });
}

/** "14h–16h" for a 2-hour bucket. */
export function bucketLabel(bucket: number): string {
  const start = bucket * (ENERGY.bucketMinutes / 60);
  return `${start}h–${start + ENERGY.bucketMinutes / 60}h`;
}

/** GOL-10.2: learning new material, practice and simulados are the demanding units. */
export function isDemandingUnit(unitType: string): boolean {
  return unitType === 'learn' || unitType === 'practice' || unitType === 'mock';
}
