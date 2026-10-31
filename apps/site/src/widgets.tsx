// The landing page's demos: small working pieces of the app, run on this page's own content.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import capiCurious from './assets/capi-curious.webp';
import { Cite } from './components.tsx';
import { newCardRatings, planCurve, type RatingKey } from './memory.ts';
import { SUGGESTIONS, answer, type TutorAnswer } from './tutor.ts';

// ---------- one card made from the teacher's page ----------

const CARD_FRONT = 'Na osmose, a água passa pra qual meio?';

export function Flashcard() {
  const keys = useMemo(newCardRatings, []);
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [rated, setRated] = useState<RatingKey | null>(null);

  const reset = () => {
    setRated(null);
    setSide('front');
  };

  return (
    <div className="flashcard-area">
      <article className={`flashcard flashcard-${side}`} aria-live="polite">
        <header className="flashcard-head">
          <span className="ribbon" aria-hidden="true" />
          Biologia
        </header>
        {side === 'front' ? (
          <p className="card-face">{CARD_FRONT}</p>
        ) : (
          <>
            <p className="card-band">{CARD_FRONT}</p>
            <p className="card-face">Pro meio mais concentrado, o hipertônico.</p>
            <Cite target="fonte-osmose" label="Ver a página 12 do material">
              p. 12
            </Cite>
          </>
        )}
      </article>
      {side === 'front' && (
        <button type="button" className="key key-primary" onClick={() => setSide('back')}>
          Mostrar resposta
        </button>
      )}
      {side === 'back' && !rated && (
        <div className="ratings" role="group" aria-label="Como foi lembrar?">
          {keys.map((k) => (
            <button key={k.label} type="button" className={`key rating rating-${k.tone}`} onClick={() => setRated(k)}>
              {k.label}
              <span className="rating-when">{k.interval}</span>
            </button>
          ))}
        </div>
      )}
      {rated && (
        <div className="rated" role="status">
          <p>
            Combinado: esse cartão volta em <strong>{rated.interval}</strong>. Cada resposta muda quando ele volta, e é
            isso que segura a memória.
          </p>
          <button type="button" className="key" onClick={reset}>
            Ver de novo
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- the plan, as memory over the days until the exam ----------

const CHART_H = 250;
const MIN_DAYS = 3;
const MAX_DAYS = 30;
const PAD = { top: 18, right: 132, bottom: 44, left: 40 };

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function PlanChart() {
  const [days, setDays] = useState(12);
  const curve = useMemo(() => planCurve(days), [days]);
  const [box, width] = useWidth<HTMLDivElement>(560);
  const narrow = width < 420;
  const pad = narrow ? { ...PAD, right: 16, left: 34 } : PAD;
  const plotW = Math.max(120, width - pad.left - pad.right);
  const plotH = CHART_H - pad.top - pad.bottom;
  const x = (d: number) => pad.left + (d / days) * plotW;
  const y = (r: number) => pad.top + (1 - r) * plotH;
  const path = (pts: [number, number][]) => pts.map(([d, r], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)} ${y(r).toFixed(1)}`).join('');
  const sliderId = useId();
  const eve = days - 1;
  const midReviews = curve.reviews.filter((d) => d !== eve);

  return (
    <div className="plan">
      <div className="plan-controls">
        <div className="leaf" aria-hidden="true">
          <span className="leaf-top">prova</span>
          <span className="leaf-num">{days}</span>
          <span className="leaf-foot">{days === 1 ? 'dia' : 'dias'}</span>
        </div>
        <div className="plan-slider">
          <label htmlFor={sliderId}>
            Sua prova é daqui a <strong>{days} dias</strong>
          </label>
          <input
            id={sliderId}
            type="range"
            min={MIN_DAYS}
            max={MAX_DAYS}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ '--fill': `${((days - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)) * 100}%` } as CSSProperties}
          />
        </div>
      </div>

      <div ref={box} className="chart">
        <svg width={width} height={CHART_H} role="img" aria-labelledby={`${sliderId}-desc`}>
          <desc id={`${sliderId}-desc`}>
            Memória de um cartão de Osmose até a prova, daqui a {days} dias. Só lendo, chega à prova com{' '}
            {pct(curve.atExam.readOnly)}. Com as revisões do Studify, com {pct(curve.atExam.withReviews)}.
          </desc>
          {[0, 0.5, 1].map((r) => (
            <g key={r}>
              <line className="grid" x1={pad.left} x2={pad.left + plotW} y1={y(r)} y2={y(r)} />
              <text className="tick" x={pad.left - 6} y={y(r) + 4} textAnchor="end">
                {pct(r)}
              </text>
            </g>
          ))}
          <line className="exam-line" x1={x(days)} x2={x(days)} y1={pad.top - 6} y2={pad.top + plotH} />
          <path className="curve-read" d={path(curve.readOnly)} />
          <path className="curve-studify" d={path(curve.withReviews)} />
          {curve.reviews.map((d) => (
            <rect key={d} className="review-mark" x={x(d) - 5} y={y(1) - 5} width={10} height={10} transform={`rotate(45 ${x(d)} ${y(1)})`} />
          ))}
          <text className="tick" x={x(0)} y={CHART_H - 18} textAnchor="start">
            hoje
          </text>
          {midReviews
            .filter((d) => x(d) - x(0) > 48 && x(days) - x(d) > 56)
            .map((d) => (
              <text key={d} className="tick tick-review" x={x(d)} y={CHART_H - 18} textAnchor="middle">
                dia {d}
              </text>
            ))}
          <text className="tick tick-exam" x={x(days)} y={CHART_H - 18} textAnchor="end">
            prova
          </text>
          {!narrow && (
            <>
              <text className="end-label end-studify" x={x(days) + 10} y={y(curve.atExam.withReviews) + 4}>
                Com o Studify {pct(curve.atExam.withReviews)}
              </text>
              <text className="end-label end-read" x={x(days) + 10} y={y(curve.atExam.readOnly) + 4}>
                Só lendo {pct(curve.atExam.readOnly)}
              </text>
            </>
          )}
        </svg>
        {narrow && (
          <ul className="chart-legend">
            <li className="legend-studify">Com o Studify: {pct(curve.atExam.withReviews)} no dia da prova</li>
            <li className="legend-read">Só lendo: {pct(curve.atExam.readOnly)} no dia da prova</li>
          </ul>
        )}
      </div>
      <p className="chart-note">
        Memória estimada de um cartão de Osmose, pelo mesmo modelo que o app usa pra marcar revisões (FSRS). Cada
        losango é uma revisão, a última na véspera. É uma estimativa, não uma garantia.
      </p>

      <ul className="checklist" aria-label="Plano até a prova">
        <li>
          <label>
            <input type="checkbox" /> Hoje: estudar Osmose com cartões e um quiz rápido
          </label>
        </li>
        {midReviews.map((d) => (
          <li key={d}>
            <label>
              <input type="checkbox" /> Em {d} dias: revisar Osmose, uns 2 min
            </label>
          </li>
        ))}
        <li>
          <label>
            <input type="checkbox" /> Véspera: Modo Véspera, revisão leve e cama cedo
          </label>
        </li>
      </ul>
    </div>
  );
}

// ---------- a tutor that only knows this page ----------

type Message = { id: number; from: 'you'; text: string } | { id: number; from: 'tutor'; answer: TutorAnswer; general: boolean };

export function Tutor() {
  const [log, setLog] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const inputId = useId();

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, thinking]);

  const ask = (question: string) => {
    const text = question.trim();
    if (!text || thinking) return;
    setLog((l) => [...l, { id: nextId.current++, from: 'you', text }]);
    setThinking(true);
    setTimeout(() => {
      setLog((l) => [...l, { id: nextId.current++, from: 'tutor', answer: answer(text), general: false }]);
      setThinking(false);
    }, 700);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(draft);
    setDraft('');
  };

  const showGeneral = (id: number) =>
    setLog((l) => l.map((m) => (m.id === id && m.from === 'tutor' ? { ...m, general: true } : m)));

  return (
    <div className="tutor">
      <img className="tutor-capi" src={capiCurious} alt="" width={112} height={112} />
      <div ref={logRef} className="tutor-log" aria-live="polite">
        <p className="msg msg-tutor">Pergunte qualquer coisa sobre o Studify. Eu respondo só com o que está nesta página e mostro de onde tirei.</p>
        {log.map((m) =>
          m.from === 'you' ? (
            <p key={m.id} className="msg msg-you">
              {m.text}
            </p>
          ) : (
            <div key={m.id} className={`msg msg-tutor${m.answer.kind === 'missing' ? ' msg-missing' : ''}`}>
              <p>{m.answer.text}</p>
              {m.answer.kind === 'grounded' && (
                <Cite target={m.answer.cite.section} label={`Ver a seção ${m.answer.cite.label}`}>
                  {m.answer.cite.label}
                </Cite>
              )}
              {m.answer.kind === 'missing' && m.answer.general && !m.general && (
                <button type="button" className="key key-small" onClick={() => showGeneral(m.id)}>
                  Responder mesmo assim
                </button>
              )}
              {m.answer.kind === 'missing' && m.answer.general && m.general && (
                <p className="general">
                  <span className="badge">Conhecimento geral</span> {m.answer.general}
                </p>
              )}
            </div>
          ),
        )}
        {thinking && <p className="msg msg-tutor msg-thinking">Procurando na página…</p>}
      </div>
      <div className="suggestions" role="group" aria-label="Sugestões de pergunta">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="key key-small" onClick={() => ask(s)} disabled={thinking}>
            {s}
          </button>
        ))}
      </div>
      <form className="ask" onSubmit={submit}>
        <label htmlFor={inputId} className="sr-only">
          Sua pergunta
        </label>
        <input
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Pergunte sobre esta página"
          autoComplete="off"
          maxLength={200}
        />
        <button type="submit" className="key key-primary" disabled={!draft.trim() || thinking}>
          Perguntar
        </button>
      </form>
    </div>
  );
}
