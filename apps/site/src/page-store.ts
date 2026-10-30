// The page's clock and memory: a tiny external store read through useSyncExternalStore. The clock runs on page
// hours (memory.ts) and keeps running while the tab is hidden; the state survives a reload in localStorage, so
// coming back tomorrow finds a page that has had years to forget.
import { useSyncExternalStore } from 'react';
import { PAGE_HOURS_PER_SECOND, erosion, firstRead, formatSpan, recall, retrievability, type Trace } from './memory.ts';

/** The sheets of the apostila that can be forgotten. p. 6 (install) is the back cover and never fades. */
export const SHEETS = ['p1', 'p2', 'p3', 'p4', 'p5'] as const;
export type SheetId = (typeof SHEETS)[number];

export interface Notice {
  id: number;
  text: string;
  /** "away" notices offer to start over. */
  kind?: 'away';
}

export interface PageState {
  /** Page hours since the page was first opened. */
  now: number;
  paused: boolean;
  traces: Partial<Record<SheetId, Trace>>;
  notice: Notice | null;
}

const STORAGE_KEY = 'studify.pagina-que-esquece.v1';
/** A real absence shorter than this (one page day) is not worth a notice. */
const AWAY_NOTICE_HOURS = 24;

interface Saved {
  now: number;
  paused: boolean;
  traces: PageState['traces'];
  savedAt: number;
}

let state: PageState = { now: 0, paused: false, traces: {}, notice: null };
const listeners = new Set<() => void>();
let noticeId = 0;

function emit(next: PageState) {
  state = next;
  for (const l of listeners) l();
}

export const pageStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function usePage<T>(select: (s: PageState) => T): T {
  return useSyncExternalStore(pageStore.subscribe, () => select(state), () => select(state));
}

export function sheetErosion(s: PageState, id: SheetId): number {
  return erosion(retrievability(s.traces[id] ?? null, s.now));
}

export function notify(text: string, kind?: Notice['kind']) {
  emit({ ...state, notice: { id: ++noticeId, text, kind } });
}

export function dismissNotice() {
  if (state.notice) emit({ ...state, notice: null });
}

/** The visitor has read the sheet: its memory starts fading now. Reading it again does not reset it. */
export function markRead(id: SheetId) {
  if (state.traces[id]) return;
  emit({ ...state, traces: { ...state.traces, [id]: firstRead(state.now) } });
}

/** A recall attempt on a sheet (a cloze, a quiz question). Returns the new trace, or null for an unread sheet. */
export function review(id: SheetId, remembered: boolean): Trace | null {
  const trace = state.traces[id];
  if (!trace) return null;
  const next = recall(trace, state.now, remembered);
  emit({ ...state, traces: { ...state.traces, [id]: next } });
  return next;
}

export function setPaused(paused: boolean) {
  emit({ ...state, paused });
  save();
}

export function startOver() {
  emit({ now: 0, paused: false, traces: {}, notice: null });
  save();
}

// ---------- the clock ----------

/** Ten ticks a second: enough for the clock and the ink, and light on a cheap phone's battery. */
const TICK_MS = 100;
/** A gap this long between ticks is the phone sleeping or the tab frozen, not a slow tick. */
const GAP_MS = 20_000;

let last = 0;
let hiddenAt: number | null = null;
let running = false;
const ticks = new Set<(s: PageState) => void>();

/** Called on every tick after the clock moves (the erosion filters). */
export function onTick(cb: (s: PageState) => void): () => void {
  ticks.add(cb);
  return () => {
    ticks.delete(cb);
  };
}

/** `quiet`: the caller reports the absence itself (coming back to the tab). */
function tick(quiet = false) {
  const t = performance.now();
  const ms = t - last;
  last = t;
  if (!state.paused && ms > 0) {
    if (ms > GAP_MS && !quiet) away(ms);
    emit({ ...state, now: state.now + (ms / 1000) * PAGE_HOURS_PER_SECOND });
  }
  for (const cb of ticks) cb(state);
}

/** Real time away, as a notice in page time when it is worth one. The clock itself keeps counting. */
function away(ms: number) {
  const hours = (ms / 1000) * PAGE_HOURS_PER_SECOND;
  if (state.paused || hours < AWAY_NOTICE_HOURS) return;
  const seconds = Math.round(ms / 1000);
  const real = seconds < 120 ? `${seconds} segundos` : seconds < 7200 ? `${Math.round(seconds / 60)} minutos` : `${Math.round(seconds / 3600)} horas`;
  noticeAway(real, hours);
}

function noticeAway(real: string, hours: number) {
  notify(`Você ficou fora ${real}. No relógio desta página, isso dá ${formatSpan(hours)}. Toque nas lacunas pra lembrar o que sumiu.`, 'away');
}

// ---------- persistence ----------

function save() {
  try {
    const saved: Saved = { now: state.now, paused: state.paused, traces: state.traces, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Private mode or blocked storage: the page simply starts fresh next time.
  }
}

function load() {
  let saved: Saved | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    saved = raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    saved = null;
  }
  if (!saved || typeof saved.now !== 'number' || typeof saved.savedAt !== 'number') return;
  const realSeconds = Math.max(0, (Date.now() - saved.savedAt) / 1000);
  const hours = saved.paused ? 0 : realSeconds * PAGE_HOURS_PER_SECOND;
  state = { now: saved.now + hours, paused: Boolean(saved.paused), traces: saved.traces ?? {}, notice: null };
  if (hours >= AWAY_NOTICE_HOURS && Object.keys(state.traces).length > 0) {
    const days = realSeconds / 86_400;
    const real =
      days >= 2 ? `${Math.round(days)} dias` : realSeconds >= 7200 ? `${Math.round(realSeconds / 3600)} horas` : `${Math.max(1, Math.round(realSeconds / 60))} minutos`;
    noticeAway(real, hours);
  }
}

/** Starts the clock once, after restoring a saved visit. */
export function startClock() {
  if (running) return;
  running = true;
  load();
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = performance.now();
      save();
    } else if (hiddenAt !== null) {
      // Switching to WhatsApp and back: time went on, and the page says so.
      const ms = performance.now() - hiddenAt;
      hiddenAt = null;
      tick(true);
      away(ms);
    }
  });
  last = performance.now();
  setInterval(tick, TICK_MS);
}
