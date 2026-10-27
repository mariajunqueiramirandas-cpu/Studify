import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../../api/supabase';

export const PRIVACY_NOTICE_VERSION = '2026-10-v1';

export const SCHOOL_YEARS = ['ef9', 'em1', 'em2', 'em3', 'cursinho', 'outro'] as const;
export type SchoolYear = (typeof SCHOOL_YEARS)[number];

export interface Profile {
  id: string;
  display_name: string;
  display_name_status: 'pending' | 'approved' | 'rejected';
  avatar_preset: string | null;
  birth_year: number;
  birth_month: number;
  school_year: SchoolYear | null;
  timezone: string;
  app_role: 'user' | 'app_admin';
  settings: Record<string, unknown>;
  onboarding_completed_at: string | null;
  created_at: string;
}

interface SessionState {
  session: Session | null;
  userId: string | null;
  email: string | null;
  profile: Profile | null;
  /** Session restored from storage and profile fetched (or known missing). */
  ready: boolean;
  refreshProfile: () => Promise<void>;
  signOut: (scope?: 'local' | 'global') => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .finally(() => setRestored(true));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;
  const profileQuery = useQuery({
    queryKey: ['profile', userId],
    enabled: !!userId,
    // Profile is needed before anything renders; a cached copy keeps cold start offline-friendly.
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', userId!).maybeSingle();
      if (error) throw error;
      return (data as Profile | null) ?? null;
    },
  });

  const value: SessionState = {
    session,
    userId,
    email: session?.user.email ?? null,
    profile: profileQuery.data ?? null,
    ready: restored && (!userId || profileQuery.isFetched || profileQuery.isError),
    refreshProfile: async () => {
      await qc.invalidateQueries({ queryKey: ['profile', userId] });
    },
    signOut: async (scope = 'local') => {
      await supabase.auth.signOut({ scope });
      qc.clear();
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** Convenience for screens that only render when signed in. */
export function useUserId(): string {
  const { userId } = useSession();
  return userId ?? '';
}

export function ageFrom(birthYear: number, birthMonth: number, now = new Date()): number {
  let age = now.getFullYear() - birthYear;
  if (now.getMonth() + 1 < birthMonth) age -= 1;
  return age;
}

export function isMinor(profile: Pick<Profile, 'birth_year' | 'birth_month'> | null | undefined): boolean {
  return !profile || ageFrom(profile.birth_year, profile.birth_month) < 18;
}
