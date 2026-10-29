// The frame around every signed-in page: the rail on the reed-paper desk (a drawer on phones) and the sheet.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccount, useSession } from './lib/account.tsx';
import { firstName, initials } from './lib/format.ts';
import { Link, match } from './lib/router.tsx';
import { Button } from './ui/controls.tsx';
import { Icon, type IconName } from './ui/icons.tsx';
import { BrandMark, BrandText } from './ui/brand.tsx';

export interface NavGroup {
  title: string;
  items: Array<{ to: string; label: string; icon: IconName; also?: string }>;
}

export function Brand({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="brand" aria-label="Painel Studify, início">
      <BrandMark />
      <BrandText />
    </Link>
  );
}

export function Shell({ groups, path, children }: { groups: NavGroup[]; path: string; children: ReactNode }) {
  const { account } = useAccount();
  const { signOut } = useSession();
  const [drawer, setDrawer] = useState(false);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // A new page: close the drawer and move focus to the page, so screen readers start at its title.
  useEffect(() => {
    setDrawer(false);
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [path]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const isCurrent = (to: string, also?: string) => path === to || (also ? match(also, path) !== null : false);

  return (
    <div className="shell" data-drawer={drawer ? 'open' : 'closed'}>
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>
      <div className="topbar">
        <Brand />
        <Button variant="ghost" className="btn-icon" aria-label="Abrir menu" aria-expanded={drawer} aria-controls="menu" onClick={() => setDrawer(true)}>
          <Icon name="menu" size={22} />
        </Button>
      </div>
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />
      <aside className="rail" id="menu" aria-label="Menu do painel">
        <Brand />
        <nav className="nav" aria-label="Seções">
          {groups.map((group) => (
            <div key={group.title}>
              <div className="nav-group-title" id={`nav-${group.title}`}>
                {group.title}
              </div>
              <ul className="nav-list" aria-labelledby={`nav-${group.title}`}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <Link to={item.to} className="nav-link" aria-current={isCurrent(item.to, item.also) ? 'page' : undefined}>
                      <Icon name={item.icon} />
                      <span className="nav-label">{item.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="rail-foot">
          <div className="who">
            <span className="avatar" aria-hidden="true">
              {initials(account.profile.display_name)}
            </span>
            <span className="who-text">
              <span className="who-name" title={account.profile.display_name}>
                {firstName(account.profile.display_name)}
              </span>
              <span className="who-email" title={account.profile.email ?? undefined}>
                {account.profile.email}
              </span>
            </span>
          </div>
          <Button variant="ghost" size="sm" icon="logout" onClick={() => void signOut()} style={{ justifyContent: 'flex-start' }}>
            Sair
          </Button>
        </div>
      </aside>
      <main className="sheet" id="conteudo" ref={main} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
