import { create } from 'zustand';
import type { SchoolYear } from './session';

export type Intent = 'exam_week' | 'enem' | 'one_subject';

interface OnboardingDraft {
  inviteCode: string;
  birthMonth: number | null;
  birthYear: number | null;
  guardianEmail: string;
  displayName: string;
  schoolYear: SchoolYear | null;
  intent: Intent | null;
  set: (patch: Partial<Omit<OnboardingDraft, 'set' | 'reset'>>) => void;
  reset: () => void;
}

const initial = {
  inviteCode: '',
  birthMonth: null,
  birthYear: null,
  guardianEmail: '',
  displayName: '',
  schoolYear: null,
  intent: null,
};

/**
 * In-memory only: nothing about an under-12 user is ever persisted (SP-01), so the draft
 * lives in RAM until `signup-complete` succeeds.
 */
export const useOnboarding = create<OnboardingDraft>((set) => ({
  ...initial,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));

/** Invite codes: 8 chars, no 0/O/1/I/L — same CHECK as `invites.code` (security §9 alphabet). */
export function normalizeInviteCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

export function isValidInviteCode(code: string): boolean {
  return /^[A-HJ-KM-NP-Z2-9]{8}$/.test(code);
}

export function formatInviteCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
