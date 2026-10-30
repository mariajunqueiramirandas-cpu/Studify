// The forgetting machinery of the landing page: sheets that notice being read, ink that erodes with the sheet's
// memory, cloze blanks that bring it back, and the Mapa da Memória of the page.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LEVEL_LABEL, formatClock, formatSpan, levelOf, retrievability } from './memory.ts';
import {
  SHEETS,
  dismissNotice,
  markRead,
  notify,
  onFrame,
  pageStore,
  review,
  setPaused,
  sheetErosion,
  startOver,
  usePage,
  type SheetId,
} from './page-store.ts';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface SheetInfo {
  id: SheetId | 'p6';
  page: number;
}

const SheetContext = createContext<SheetInfo>({ id: 'p6', page: 6 });

const forgets = (id: SheetInfo['id']): id is SheetId => id !== 'p6';

// ---------- erosion filters ----------

/** Toner loss: two noise layers (blotches and grain) cut away the ink below a threshold that rises with erosion. */
const STEEPNESS = 10;
const threshold = (e: number) => 0.14 + e * 0.62;
/** Running text keeps some ink so the page stays readable; headlines and key words can vanish. */
const BODY_CAP = 0.52;

function matrix(e: number): string {
  const b = 1 - STEEPNESS * threshold(e);
  return `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${STEEPNESS} 0 0 0 ${b.toFixed(3)}`;
}

/** One pair of filters per sheet (display type, body text), driven every frame from the page clock. */
export function ErosionFilters() {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const shown = new Map<SheetId, number>();
    let last = performance.now();
    return onFrame((s) => {
      const t = performance.now();
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      for (const id of SHEETS) {
        const target = sheetErosion(s, id);
        const prev = shown.get(id) ?? 0;
        // Re-inking floods back in about half a second; forgetting follows the clock.
        const next = reducedMotion() || target > prev ? target : prev + (target - prev) * Math.min(1, dt * 7);
        if (Math.abs(next - prev) < 0.003 && shown.has(id)) continue;
        shown.set(id, next);
        const svg = ref.current;
        svg?.querySelector(`#erode-${id}-d feColorMatrix`)?.setAttribute('values', matrix(next));
        svg?.querySelector(`#erode-${id}-b feColorMatrix`)?.setAttribute('values', matrix(Math.min(next, BODY_CAP)));
      }
    });
  }, []);

  return (
    <svg ref={ref} className="filters" aria-hidden="true" focusable="false">
      <defs>
        {SHEETS.flatMap((id, i) =>
          (['d', 'b'] as const).map((kind) => (
            <filter
              key={`${id}-${kind}`}
              id={`erode-${id}-${kind}`}
              x="-4%"
              y="-15%"
              width="108%"
              height="130%"
              colorInterpolationFilters="sRGB"
              primitiveUnits="userSpaceOnUse"
            >
              <feTurbulence type="fractalNoise" baseFrequency={kind === 'd' ? 0.018 : 0.03} numOctaves={2} seed={11 + i * 7} result="blot" />
              <feTurbulence type="fractalNoise" baseFrequency={0.8} numOctaves={1} seed={3 + i} result="grain" />
              <feComposite in="blot" in2="grain" operator="arithmetic" k2={0.7} k3={0.3} result="noise" />
              <feColorMatrix in="noise" type="matrix" values={matrix(0)} result="mask" />
              <feComposite in="SourceGraphic" in2="mask" operator="in" />
            </filter>
          )),
        )}
      </defs>
    </svg>
  );
}

// ---------- sheets and text ----------

/** A sheet of the apostila. It counts as read after it has filled a good part of the screen for 1.5 s. */
export function Sheet({
  id,
  page,
  labelledBy,
  className = '',
  children,
}: {
  id: SheetInfo['id'];
  page: number;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  const read = usePage((s) => forgets(id) && Boolean(s.traces[id]));

  useEffect(() => {
    const el = ref.current;
    if (!el || !forgets(id)) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry) setSeen(entry.intersectionRatio >= 0.4 || entry.intersectionRect.height >= innerHeight * 0.55);
      },
      { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [id]);

  // Re-armed after "Começar do zero" too, while the sheet is still on screen.
  useEffect(() => {
    if (!seen || read || !forgets(id)) return;
    const t = setTimeout(() => markRead(id), 1500);
    return () => clearTimeout(t);
  }, [seen, read, id]);

  return (
    <section ref={ref} id={id} className={`sheet ${className}`} aria-labelledby={labelledBy}>
      <SheetContext.Provider value={{ id, page }}>{children}</SheetContext.Provider>
      <p className="folio" aria-hidden="true">
        p. {page}
      </p>
    </section>
  );
}

/** Text that fades with its sheet. `display` text erodes all the way; body text keeps a floor of ink. */
export function Ink({ display = false, children }: { display?: boolean; children: ReactNode }) {
  const { id } = useContext(SheetContext);
  if (!forgets(id)) return <>{children}</>;
  return (
    <span className="ink" style={{ filter: `url(#erode-${id}-${display ? 'd' : 'b'})` }}>
      {children}
    </span>
  );
}

const TOKEN = /(\[[^\]]+\]|\*\*[^*]+\*\*)/;

/**
 * Sheet copy with markup: `[palavra|distrator|distrator]` is a key word that turns into a cloze blank as the sheet
 * fades (the first option is the right one), `**termo**` is highlighted. Key words go blank one after another,
 * from `at` up.
 */
export function Txt({ children, display = false, at = 0.42 }: { children: string; display?: boolean; at?: number }) {
  const parts = children.split(TOKEN);
  let cloze = 0;
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        if (part.startsWith('[')) {
          const options = part.slice(1, -1).split('|');
          // Punctuation right after a key word stays on its line.
          const tail = /^[.,;:!?…)]+/.exec(parts[i + 1] ?? '')?.[0];
          if (tail) parts[i + 1] = parts[i + 1]!.slice(tail.length);
          const blank = <Cloze word={options[0]!} options={options} at={at + cloze++ * 0.14} display={display} />;
          return tail ? (
            <span key={i} className="nowrap">
              {blank}
              <Ink display={display}>{tail}</Ink>
            </span>
          ) : (
            <span key={i}>{blank}</span>
          );
        }
        if (part.startsWith('**')) {
          return (
            <Ink key={i} display={display}>
              <strong className="hl">{part.slice(2, -2)}</strong>
            </Ink>
          );
        }
        return (
          <Ink key={i} display={display}>
            {part}
          </Ink>
        );
      })}
    </>
  );
}

/** Same order for every visit, but the right word is not always first. */
function arrange(word: string, options: string[]): string[] {
  const shift = [...word].reduce((n, c) => n + c.charCodeAt(0), 0) % options.length;
  return [...options.slice(shift), ...options.slice(0, shift)];
}

function Cloze({ word, options, at, display }: { word: string; options: string[]; at: number; display: boolean }) {
  const { id, page } = useContext(SheetContext);
  const blank = usePage((s) => forgets(id) && sheetErosion(s, id) >= at);
  const [open, setOpen] = useState(false);
  const [stamp, setStamp] = useState<'right' | 'wrong' | null>(null);
  const blankRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (open) firstRef.current?.focus();
  }, [open]);

  // The sheet came back some other way (a quiz answer): the choices close with the blank.
  useEffect(() => {
    if (!blank) setOpen(false);
  }, [blank]);

  useEffect(() => {
    if (!stamp) return;
    wordRef.current?.focus();
    const t = setTimeout(() => setStamp(null), 1400);
    return () => clearTimeout(t);
  }, [stamp]);

  if (!forgets(id)) return <>{word}</>;

  if (!blank) {
    return (
      <span ref={wordRef} tabIndex={stamp ? -1 : undefined} className={`cloze-word${stamp ? ` stamp-${stamp}` : ''}`}>
        <Ink display={display}>{word}</Ink>
      </span>
    );
  }

  const choose = (option: string) => {
    const right = option === word;
    const next = review(id, right);
    setOpen(false);
    setStamp(right ? 'right' : 'wrong');
    notify(
      right
        ? `Lembrou! A p. ${page} fica nítida por mais ${next ? formatSpan(next.stability * 24) : 'um tempo'}.`
        : `Não foi dessa vez: era “${word}”. Logo eu pergunto de novo.`,
    );
  };

  if (open) {
    return (
      <span
        className="cloze-choices"
        role="group"
        aria-label="Qual era a palavra?"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            requestAnimationFrame(() => blankRef.current?.focus());
          }
        }}
      >
        {arrange(word, options).map((option, i) => (
          <button key={option} ref={i === 0 ? firstRef : undefined} type="button" className="key cloze-option" onClick={() => choose(option)}>
            {option}
          </button>
        ))}
      </span>
    );
  }

  return (
    <button ref={blankRef} type="button" className="cloze-blank" aria-label="Palavra apagada. Tentar lembrar" onClick={() => setOpen(true)}>
      <span aria-hidden="true">{word}</span>
    </button>
  );
}

// ---------- citations ----------

/** Scrolls to a passage and runs the highlighter over it, like a page chip in the app's PDF viewer (ING-08). */
export function jumpTo(passage: string) {
  const el = document.getElementById(passage);
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('lit');
  void el.offsetWidth;
  el.classList.add('lit');
  setTimeout(() => el.classList.remove('lit'), 3200);
}

export function DocIcon() {
  return (
    <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.5 1.5V5H13M6 8h5M6 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function PageChip({ page, passage, label }: { page: number; passage: string; label?: string }) {
  return (
    <button type="button" className="page-chip" onClick={() => jumpTo(passage)} aria-label={`Abrir a página ${page}`}>
      <DocIcon />
      {label ?? `p. ${page}`}
    </button>
  );
}

// ---------- Mapa da Memória ----------

const NOTICE_MS = 6000;

export function MemoryMap() {
  const s = usePage((state) => state);
  const notice = s.notice;

  useEffect(() => {
    if (!notice || notice.kind === 'away') return;
    const t = setTimeout(dismissNotice, NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // The first blank on the page gets explained once.
  const anyBlank = SHEETS.some((id) => sheetErosion(s, id) >= 0.42);
  const told = useRef(false);
  useEffect(() => {
    if (anyBlank && !told.current) {
      told.current = true;
      // A visitor coming back is already told what happened.
      if (pageStore.get().notice?.kind !== 'away') {
        notify('Uma palavra sumiu. Toque na lacuna e tente lembrar: é assim que a memória volta.');
      }
    }
  }, [anyBlank]);

  return (
    <aside className="hud" aria-label="Mapa da memória desta página">
      <p className="hud-title">Mapa da memória</p>
      <ol className="hud-sheets">
        {SHEETS.map((id, i) => {
          const trace = s.traces[id] ?? null;
          const level = levelOf(trace, s.now);
          const r = retrievability(trace, s.now);
          const pct = trace ? `${Math.round(r * 100)}%` : '';
          return (
            <li key={id}>
              <a href={`#${id}`} className={`hud-sheet level-${level}`}>
                <svg className="diamond" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <rect x="3.5" y="3.5" width="9" height="9" transform="rotate(45 8 8)" className="diamond-rim" />
                  <rect
                    x="3.5"
                    y="3.5"
                    width="9"
                    height="9"
                    transform="rotate(45 8 8)"
                    className="diamond-fill"
                    style={{ opacity: trace ? Math.max(0.12, (r - 0.45) / 0.55) : 0 }}
                  />
                </svg>
                <span className="hud-page">p. {i + 1}</span>
                <span className="hud-pct">{pct}</span>
                <span className="hud-level">{LEVEL_LABEL[level]}</span>
              </a>
            </li>
          );
        })}
      </ol>
      <div className="hud-clock">
        <span className="hud-time">{formatClock(s.now)}</span>
        <span className="hud-rate">1 segundo aqui vale 1 hora</span>
      </div>
      <button type="button" className="key hud-pause" aria-pressed={s.paused} onClick={() => setPaused(!s.paused)}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          {s.paused ? <path d="M5 3.5v9l7-4.5z" fill="currentColor" /> : <path d="M5 3.5h2v9H5zM9 3.5h2v9H9z" fill="currentColor" />}
        </svg>
        <span className="hud-pause-label">{s.paused ? 'Voltar a esquecer' : 'Pausar o esquecimento'}</span>
      </button>
      <div className="hud-notice" role="status" aria-live="polite">
        {notice && (
          <p key={notice.id}>
            {notice.text}
            {notice.kind === 'away' && (
              <span className="hud-notice-actions">
                <button type="button" className="key" onClick={dismissNotice}>
                  Ok
                </button>
                <button type="button" className="key" onClick={startOver}>
                  Começar do zero
                </button>
              </span>
            )}
          </p>
        )}
      </div>
    </aside>
  );
}
