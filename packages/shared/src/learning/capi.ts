// Mascote Capi (MOT-03, spec 13 §5.2). Stage follows the level, mood follows what the student is doing, and the
// accessories are cosmetic unlocks. Capi is never sad, sick, hungry or "dying" (MOT-03.3): there is no such mood.

export type CapiStage = 'filhote' | 'jovem' | 'adulta' | 'sabia';
export type CapiMood = 'celebrating' | 'focused' | 'curious' | 'resting' | 'sleepy';

/** MOT-03.1: filhote L1–4 (and level 0), jovem L5–14, adulta L15–29, sábia L30+. */
export function capiStage(level: number): CapiStage {
  if (level >= 30) return 'sabia';
  if (level >= 15) return 'adulta';
  if (level >= 5) return 'jovem';
  return 'filhote';
}

export interface CapiMoodInput {
  focusActive: boolean;
  goalMetToday: boolean;
  /** Days since the last counted study day; 0 when the student studied today. */
  daysAway: number;
  /** Local minutes since midnight. */
  minuteOfDay: number;
}

/** Days away after which Capi rests (MOT-03.3; spec 13 §11: "descansando" after 3+ days, never sad). */
export const CAPI_RESTING_DAYS = 3;

/**
 * MOT-03.3, in priority order: focada during a focus session, sonolenta late at night (23:00–05:00, a gentle sleep
 * cue), comemorando when today's goal is met, descansando after 3+ days away, curiosa otherwise.
 */
export function capiMood(input: CapiMoodInput): CapiMood {
  if (input.focusActive) return 'focused';
  if (input.minuteOfDay >= 23 * 60 || input.minuteOfDay < 5 * 60) return 'sleepy';
  if (input.goalMetToday) return 'celebrating';
  if (input.daysAway >= CAPI_RESTING_DAYS) return 'resting';
  return 'curious';
}

export type CapiSlot = 'hat' | 'glasses' | 'scarf';

export interface CapiAccessory {
  id: string;
  slot: CapiSlot;
  name: string;
  /** Unlocked by reaching a level or an achievement (MOT-03.2). Never purchasable. */
  unlock: { level: number } | { achievement: string };
  /** Scarves come in subject colors. */
  color?: string;
}

export const CAPI_ACCESSORIES: readonly CapiAccessory[] = [
  { id: 'bone', slot: 'hat', name: 'Boné', unlock: { level: 3 } },
  { id: 'chapeu_formatura', slot: 'hat', name: 'Chapéu de formatura', unlock: { level: 15 } },
  { id: 'coroa_folhas', slot: 'hat', name: 'Coroa de folhas', unlock: { level: 30 } },
  { id: 'gorro_chefao', slot: 'hat', name: 'Gorro de caçador(a) de chefões', unlock: { achievement: 'boss_first' } },
  { id: 'oculos', slot: 'glasses', name: 'Óculos de leitura', unlock: { achievement: 'first_review' } },
  { id: 'oculos_sol', slot: 'glasses', name: 'Óculos escuros', unlock: { achievement: 'streak_7' } },
  { id: 'oculos_redondos', slot: 'glasses', name: 'Óculos redondos', unlock: { achievement: 'calibrated' } },
  { id: 'cachecol_verde', slot: 'scarf', name: 'Cachecol verde', unlock: { level: 5 }, color: '#2E9E5B' },
  { id: 'cachecol_azul', slot: 'scarf', name: 'Cachecol azul', unlock: { achievement: 'first_mock' }, color: '#3A6FD8' },
  { id: 'cachecol_roxo', slot: 'scarf', name: 'Cachecol roxo', unlock: { achievement: 'consistent_week' }, color: '#7A4FD0' },
  { id: 'cachecol_laranja', slot: 'scarf', name: 'Cachecol laranja', unlock: { achievement: 'focus_10' }, color: '#E8833A' },
];

export function isAccessoryUnlocked(a: CapiAccessory, level: number, achievements: ReadonlySet<string>): boolean {
  return 'level' in a.unlock ? level >= a.unlock.level : achievements.has(a.unlock.achievement);
}

/**
 * What Capi actually wears: unknown or locked accessories are dropped and each slot keeps its first choice, so a
 * stale `profiles.settings.mascot.accessories` list never breaks the drawing.
 */
export function equippedAccessories(requested: readonly string[], level: number, achievements: ReadonlySet<string>): CapiAccessory[] {
  const out: CapiAccessory[] = [];
  const slots = new Set<CapiSlot>();
  for (const id of requested) {
    const a = CAPI_ACCESSORIES.find((x) => x.id === id);
    if (!a || slots.has(a.slot) || !isAccessoryUnlocked(a, level, achievements)) continue;
    slots.add(a.slot);
    out.push(a);
  }
  return out;
}
