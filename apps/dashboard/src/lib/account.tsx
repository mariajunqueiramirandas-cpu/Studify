// The signed-in account: the session (Supabase Auth) and the Minha conta read model (account-overview), shared by
// every page. A session the API refuses (expired, revoked, suspended) signs out here with the reason.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/auth-js';
import type { AccountOverview } from '@studify/shared';
import { ApiError, callApi, setUnauthorizedHandler } from './api.ts';
import { clearResources } from './resource.ts';
import { supabase } from './supabase.ts';
import { applyTheme } from './theme.ts';

interface SessionState {
  session: Session | null;
  ready: boolean;
  /** Why the last session ended, shown on the sign-in page. */
  notice: string | null;
  signOut: (scope?: 'local' | 'global', notice?: string | null) => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const signOut = useCallback(async (scope: 'local' | 'global' = 'local', why: string | null = null) => {
    try {
      await supabase().auth.signOut({ scope });
    } catch {
      // Offline or already revoked: the local session is cleared below either way.
      await supabase().auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
    clearResources();
    setNotice(why);
    setSession(null);
  }, []);

  useEffect(() => {
    const auth = supabase().auth;
    void auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (next) setNotice(null);
    });
    setUnauthorizedHandler((error: ApiError) => {
      void signOut('local', error.code === 'banned' ? error.message : 'Sua sessão terminou. Entre de novo para continuar.');
    });
    return () => data.subscription.unsubscribe();
  }, [signOut]);

  return <SessionContext.Provider value={{ session, ready, notice, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

interface AccountState {
  account: AccountOverview;
  setAccount: (next: AccountOverview) => void;
  reload: () => Promise<void>;
  isAdmin: boolean;
}

const AccountContext = createContext<AccountState | null>(null);

type Load = { state: 'loading' } | { state: 'ready'; account: AccountOverview } | { state: 'error'; error: unknown };

export function useAccountLoader(userId: string): [Load, (next: AccountOverview) => void, () => Promise<void>] {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const reload = useCallback(async () => {
    try {
      const account = await callApi<AccountOverview>('account-overview');
      setLoad({ state: 'ready', account });
    } catch (error) {
      setLoad((current) => (current.state === 'ready' ? current : { state: 'error', error }));
      throw error;
    }
  }, []);
  useEffect(() => {
    setLoad({ state: 'loading' });
    reload().catch(() => undefined);
  }, [userId, reload]);
  const set = useCallback((account: AccountOverview) => setLoad({ state: 'ready', account }), []);
  return [load, set, reload];
}

export function AccountProvider({ account, setAccount, reload, children }: Omit<AccountState, 'isAdmin'> & { children: ReactNode }) {
  useEffect(() => applyTheme(account.settings.theme), [account.settings.theme]);
  return <AccountContext.Provider value={{ account, setAccount, reload, isAdmin: account.profile.app_role === 'app_admin' }}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount outside AccountProvider');
  return value;
}
