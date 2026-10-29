// Painel Studify: sign-in, then "Minha conta" for every student and "Administração" for the owner (app_admin).
// The API enforces every rule; the pages only decide what to show.
import { Suspense, lazy, useEffect, useMemo, type ReactNode } from 'react';
import { ApiError } from './lib/api.ts';
import { readConfig } from './lib/config.ts';
import { AccountProvider, SessionProvider, useAccount, useAccountLoader, useSession } from './lib/account.tsx';
import { match, navigate, usePath } from './lib/router.tsx';
import { initSupabase } from './lib/supabase.ts';
import { Shell, type NavGroup } from './Shell.tsx';
import { Banner, LoadError, Loading, ToastProvider } from './ui/feedback.tsx';
import { Button } from './ui/controls.tsx';
import { SignIn, AuthFrame } from './pages/SignIn.tsx';
import { Home } from './pages/account/Home.tsx';
import { Profile } from './pages/account/Profile.tsx';
import { Notifications } from './pages/account/Notifications.tsx';
import { ClassGroups } from './pages/account/ClassGroups.tsx';
import { Devices } from './pages/account/Devices.tsx';
import { Privacy } from './pages/account/Privacy.tsx';

// The Administração pages load only for admins, in their own bundle.
const Overview = lazy(() => import('./pages/admin/Overview.tsx').then((m) => ({ default: m.Overview })));
const AiUsage = lazy(() => import('./pages/admin/AiUsage.tsx').then((m) => ({ default: m.AiUsage })));
const Users = lazy(() => import('./pages/admin/Users.tsx').then((m) => ({ default: m.Users })));
const UserDetail = lazy(() => import('./pages/admin/UserDetail.tsx').then((m) => ({ default: m.UserDetail })));
const AdminClassGroups = lazy(() => import('./pages/admin/ClassGroups.tsx').then((m) => ({ default: m.AdminClassGroups })));
const Moderation = lazy(() => import('./pages/admin/Moderation.tsx').then((m) => ({ default: m.Moderation })));
const Invites = lazy(() => import('./pages/admin/Invites.tsx').then((m) => ({ default: m.Invites })));
const Settings = lazy(() => import('./pages/admin/Settings.tsx').then((m) => ({ default: m.Settings })));
const Audit = lazy(() => import('./pages/admin/Audit.tsx').then((m) => ({ default: m.Audit })));

interface Route {
  path: string;
  title: string;
  render: (params: Record<string, string>) => ReactNode;
  admin?: boolean;
}

const ROUTES: Route[] = [
  { path: '/', title: 'Início', render: () => <Home /> },
  { path: '/perfil', title: 'Perfil', render: () => <Profile /> },
  { path: '/notificacoes', title: 'Notificações', render: () => <Notifications /> },
  { path: '/turmas', title: 'Turmas', render: () => <ClassGroups /> },
  { path: '/dispositivos', title: 'Dispositivos', render: () => <Devices /> },
  { path: '/privacidade', title: 'Privacidade e dados', render: () => <Privacy /> },
  { path: '/admin', title: 'Visão geral', admin: true, render: () => <Overview /> },
  { path: '/admin/ia', title: 'Uso de IA', admin: true, render: () => <AiUsage /> },
  { path: '/admin/usuarios', title: 'Usuários', admin: true, render: () => <Users /> },
  { path: '/admin/usuarios/:id', title: 'Usuário', admin: true, render: (p) => <UserDetail userId={p.id!} /> },
  { path: '/admin/turmas', title: 'Turmas', admin: true, render: () => <AdminClassGroups /> },
  { path: '/admin/moderacao', title: 'Moderação', admin: true, render: () => <Moderation /> },
  { path: '/admin/convites', title: 'Convites', admin: true, render: () => <Invites /> },
  { path: '/admin/configuracoes', title: 'Configurações', admin: true, render: () => <Settings /> },
  { path: '/admin/registro', title: 'Registro', admin: true, render: () => <Audit /> },
];

const ACCOUNT_NAV: NavGroup = {
  title: 'Minha conta',
  items: [
    { to: '/', label: 'Início', icon: 'home' },
    { to: '/perfil', label: 'Perfil', icon: 'user' },
    { to: '/notificacoes', label: 'Notificações', icon: 'bell' },
    { to: '/turmas', label: 'Turmas', icon: 'people' },
    { to: '/dispositivos', label: 'Dispositivos', icon: 'phone' },
    { to: '/privacidade', label: 'Privacidade e dados', icon: 'shield' },
  ],
};

const ADMIN_NAV: NavGroup = {
  title: 'Administração',
  items: [
    { to: '/admin', label: 'Visão geral', icon: 'chart' },
    { to: '/admin/ia', label: 'Uso de IA', icon: 'sparkles' },
    { to: '/admin/usuarios', label: 'Usuários', icon: 'users', also: '/admin/usuarios/:id' },
    { to: '/admin/turmas', label: 'Turmas', icon: 'school' },
    { to: '/admin/moderacao', label: 'Moderação', icon: 'flag' },
    { to: '/admin/convites', label: 'Convites', icon: 'ticket' },
    { to: '/admin/configuracoes', label: 'Configurações', icon: 'sliders' },
    { to: '/admin/registro', label: 'Registro', icon: 'scroll' },
  ],
};

export function App() {
  const config = useMemo(() => readConfig(), []);
  if (!config) {
    return (
      <AuthFrame title="O painel não está configurado">
        <p className="auth-text">Abra o painel pelo endereço do servidor do Studify (por exemplo, studify.vendua.com.br/painel). Ele precisa da API para funcionar.</p>
      </AuthFrame>
    );
  }
  initSupabase(config);
  return (
    <ToastProvider>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ToastProvider>
  );
}

function Gate() {
  const { session, ready, notice } = useSession();
  const path = usePath();
  useEffect(() => {
    if (ready && !session && path !== '/entrar') navigate('/entrar', { replace: true });
    if (ready && session && path === '/entrar') navigate('/', { replace: true });
  }, [ready, session, path]);
  if (!ready) return <AuthFrame title="Abrindo o painel…"><Loading label="Conferindo sua sessão…" /></AuthFrame>;
  if (!session) return <SignIn notice={notice} />;
  return <Signed userId={session.user.id} />;
}

function Signed({ userId }: { userId: string }) {
  const { signOut } = useSession();
  const [load, setAccount, reload] = useAccountLoader(userId);
  if (load.state === 'loading') return <AuthFrame title="Abrindo o painel…"><Loading label="Carregando sua conta…" /></AuthFrame>;
  if (load.state === 'error') {
    const noProfile = load.error instanceof ApiError && load.error.code === 'not_found';
    return (
      <AuthFrame title={noProfile ? 'Termine o cadastro no app' : 'Não consegui abrir sua conta'}>
        {noProfile ? (
          <p className="auth-text">Você entrou, mas a conta ainda não tem perfil. Abra o app do Studify, use seu convite e complete o cadastro. Depois volte aqui.</p>
        ) : (
          <LoadError error={load.error} onRetry={() => void reload().catch(() => undefined)} />
        )}
        <div className="auth-form">
          <Button variant="secondary" icon="logout" onClick={() => void signOut()}>
            Sair
          </Button>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AccountProvider account={load.account} setAccount={setAccount} reload={reload}>
      <Routed />
    </AccountProvider>
  );
}

function Routed() {
  const path = usePath();
  const { isAdmin } = useAccount();
  const found = ROUTES.map((route) => ({ route, params: match(route.path, path) })).find((r) => r.params !== null);
  const title = found?.route.title ?? 'Página não encontrada';
  useEffect(() => {
    document.title = `${title} | Painel Studify`;
  }, [title]);

  let content: ReactNode;
  if (!found) {
    content = (
      <div className="page page--narrow">
        <h1 className="page-title">Essa página não existe</h1>
        <p className="page-desc">O endereço pode ter mudado. Volte para o início do painel.</p>
        <div className="auth-form">
          <Button variant="primary" onClick={() => navigate('/')}>
            Ir para o início
          </Button>
        </div>
      </div>
    );
  } else if (found.route.admin && !isAdmin) {
    content = (
      <div className="page page--narrow">
        <h1 className="page-title">Área da administração</h1>
        <div className="section">
          <Banner kind="neutral" title="Essa parte é só para quem administra o Studify.">
            Sua conta continua toda aqui em Minha conta.
          </Banner>
        </div>
      </div>
    );
  } else {
    content = <Suspense fallback={<Loading />}>{found.route.render(found.params!)}</Suspense>;
  }

  return (
    <Shell groups={isAdmin ? [ACCOUNT_NAV, ADMIN_NAV] : [ACCOUNT_NAV]} path={path}>
      {content}
    </Shell>
  );
}
