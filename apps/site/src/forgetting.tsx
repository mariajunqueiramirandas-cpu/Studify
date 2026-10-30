// The forgetting machinery of the landing page: sheets that notice being read, ink that erodes with the sheet's
// memory, cloze blanks that bring it back, and the Mapa da Memória of the page.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LEVEL_LABEL, formatClock, formatSpan, levelOf, retrievability } from './memory.ts';
import {
  SHEETS,
  dismissNotice,
  markRead,
  notify,
  onTick,
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

/** Forgetting moves the ink in steps this big: each step repaints the sheet, which costs on a cheap phone. */
const FORGET_STEP = 0.015;
const REINK_MS = 550;

/** One pair of filters per sheet (display type, body text), driven by the page clock. */
export function ErosionFilters() {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const shown = new Map<SheetId, number>();
    const reinking = new Map<SheetId, { from: number; start: number }>();
    let frame = 0;

    const paint = (id: SheetId, e: number) => {
      shown.set(id, e);
      const svg = ref.current;
      svg?.querySelector(`#erode-${id}-d feColorMatrix`)?.setAttribute('values', matrix(e));
      svg?.querySelector(`#erode-${id}-b feColorMatrix`)?.setAttribute('values', matrix(Math.min(e, BODY_CAP)));
    };

    // Re-inking floods back in about half a second, on animation frames only while it runs.
    const animate = (t: number) => {
      frame = 0;
      for (const [id, { from, start }] of reinking) {
        const k = Math.min(1, (t - start) / REINK_MS);
        const target = sheetErosion(pageStore.get(), id);
        paint(id, target + (from - target) * (1 - k) ** 3);
        if (k === 1) reinking.delete(id);
      }
      if (reinking.size) frame = requestAnimationFrame(animate);
    };

    const stop = onTick((s) => {
      for (const id of SHEETS) {
        if (reinking.has(id)) continue;
        const target = sheetErosion(s, id);
        const prev = shown.get(id);
        if (prev === undefined) paint(id, target);
        else if (target < prev - FORGET_STEP && !reducedMotion()) {
          reinking.set(id, { from: prev, start: performance.now() });
          if (!frame) frame = requestAnimationFrame(animate);
        } else if (Math.abs(target - prev) >= FORGET_STEP || (target === 0 && prev !== 0)) paint(id, target);
      }
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
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

function Diamond({ trace, r }: { trace: unknown; r: number }) {
  return (
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
  );
}

/**
 * The page's memory, sheet by sheet, with the clock and the pause button. On a phone it is a bar under the thumb
 * (the sheets' diamonds, the page's memory and the clock) that opens into the full map; on a wide screen, a rail.
 */
export function MemoryMap() {
  const s = usePage((state) => state);
  const notice = s.notice;
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLButtonElement>(null);

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

  const sheets = SHEETS.map((id) => {
    const trace = s.traces[id] ?? null;
    return { id, trace, r: retrievability(trace, s.now), level: levelOf(trace, s.now) };
  });
  const read = sheets.filter((x) => x.trace);
  const average = read.length ? `${Math.round((read.reduce((sum, x) => sum + x.r, 0) / read.length) * 100)}%` : '—';
  const clock = formatClock(s.now);

  return (
    <aside
      className={`hud${open ? ' is-open' : ''}`}
      aria-label="Mapa da memória desta página"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          setOpen(false);
          summaryRef.current?.focus();
        }
      }}
    >
      <div id="hud-panel" className="hud-panel">
        <p className="hud-title">Mapa da memória</p>
        <ol className="hud-sheets">
          {sheets.map(({ id, trace, r, level }, i) => (
            <li key={id}>
              <a href={`#${id}`} className={`hud-sheet level-${level}`} onClick={() => setOpen(false)}>
                <Diamond trace={trace} r={r} />
                <span className="hud-page">p. {i + 1}</span>
                <span className="hud-pct">{trace ? `${Math.round(r * 100)}%` : ''}</span>
                <span className="hud-level">{LEVEL_LABEL[level]}</span>
              </a>
            </li>
          ))}
        </ol>
        <div className="hud-clock">
          <span className="hud-time">{clock}</span>
          <span className="hud-rate">1 segundo aqui vale 1 hora</span>
        </div>
      </div>
      <button
        ref={summaryRef}
        type="button"
        className="hud-summary"
        aria-expanded={open}
        aria-controls="hud-panel"
        onClick={() => setOpen(!open)}
      >
        <span className="hud-dots" aria-hidden="true">
          {sheets.map(({ id, trace, r, level }) => (
            <span key={id} className={`level-${level}`}>
              <Diamond trace={trace} r={r} />
            </span>
          ))}
        </span>
        <span className="hud-summary-text">
          <span className="hud-average">Memória {average}</span>
          <span className="hud-summary-time">{clock}</span>
        </span>
        <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M3.5 10l4.5-4.5 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sr-only">{open ? 'Fechar o mapa da memória' : 'Abrir o mapa da memória'}</span>
      </button>
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
