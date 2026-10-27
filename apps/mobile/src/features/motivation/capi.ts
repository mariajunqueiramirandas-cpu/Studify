// Capi's state for the current student (MOT-03): stage from the level, mood from what is happening now, and the
// accessories saved in profiles.settings.mascot that are still unlocked.
import { CAPI_ACCESSORIES, capiMood, capiStage, equippedAccessories, isAccessoryUnlocked, parseProfileSettings, type CapiAccessory, type CapiMood, type CapiStage } from '@studify/shared';
import { useState } from 'react';
import { daysBetween, parseDate } from '../common/format';
import { useSession } from '../auth/session';
import { useFocusStore } from '../../stores/focus';
import { useAchievements, useMotivation } from './api';

export interface CapiState {
  visible: boolean;
  stage: CapiStage;
  mood: CapiMood;
  accessories: CapiAccessory[];
  level: number;
  /** All accessories with their unlock state, for Perfil → Capi. */
  catalog: (CapiAccessory & { unlocked: boolean; equipped: boolean })[];
  requested: string[];
}

function settingsOf(raw: unknown) {
  try {
    return parseProfileSettings(raw);
  } catch {
    return parseProfileSettings({});
  }
}

export function useCapi(): CapiState {
  const { profile } = useSession();
  const motivation = useMotivation();
  const achievements = useAchievements();
  const focusActive = useFocusStore((s) => s.run !== null && s.run.pausedAt === null);
  // Read once per mount: the mood follows the time of day without re-rendering every minute.
  const [now] = useState(() => new Date());
  const settings = settingsOf(profile?.settings);
  const level = motivation.data?.level ?? 1;
  const unlockedCodes = new Set((achievements.data ?? []).filter((a) => a.unlocked_at).map((a) => a.code));
  const requested = settings.mascot?.accessories ?? [];
  const accessories = equippedAccessories(requested, level, unlockedCodes);
  const last = motivation.data?.lastCountedDate;
  const daysAway = last ? Math.max(0, daysBetween(parseDate(last), now)) : 0;
  const mood = capiMood({
    focusActive,
    goalMetToday: !!motivation.data && motivation.data.todayMinutes >= motivation.data.dailyGoal,
    daysAway,
    minuteOfDay: now.getHours() * 60 + now.getMinutes(),
  });
  return {
    visible: settings.mascot?.visible !== false,
    stage: capiStage(level),
    mood,
    accessories,
    level,
    requested,
    catalog: CAPI_ACCESSORIES.map((a) => ({ ...a, unlocked: isAccessoryUnlocked(a, level, unlockedCodes), equipped: accessories.some((x) => x.id === a.id) })),
  };
}
