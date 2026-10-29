// Charts (dataviz method): thin columns with a 4px rounded data end and a square baseline, hairline grid, text in
// ink tokens, a tooltip on hover and on keyboard focus, and a table view so no value hides behind the hover.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './controls.tsx';

export interface Datum {
  key: string;
  /** Short label under the axis (e.g. "27 out."). */
  label: string;
  /** Longer label in the tooltip and the table (e.g. "ter., 27 de out."). */
  title?: string;
  value: number;
}

/** A clean step for `count` ticks over [0, max]: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(max: number, count = 4, integer = false): number {
  if (max <= 0) return 1;
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  // Counts (people, minutes) never get a fractional step: 0, 0.25, 0.5 would read as 0, 0, 1.
  return integer ? Math.max(1, Math.ceil(nice * power)) : nice * power;
}

export function ticksFor(max: number, count = 4, integer = false): number[] {
  const step = niceStep(max, count, integer);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Column path: square at the baseline, rounded data end (radius shrinks for short bars). */
export function columnPath(x: number, y: number, width: number, height: number, radius = 4): string {
  const r = Math.min(radius, width / 2, height);
  const base = y + height;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${base}Z`;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || 640);
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface ColumnChartProps {
  data: Datum[];
  /** Formats values in ticks, tooltip and table. */
  format: (value: number) => string;
  /** What one value is, for the tooltip and table header (e.g. "Gasto"). */
  valueLabel: string;
  /** Describes the chart for screen readers (e.g. "Gasto de IA por dia nos últimos 30 dias"). */
  description: string;
  height?: number;
  /** A labeled horizontal reference (e.g. the daily pace that reaches the cap). */
  reference?: { value: number; label: string };
  /** Keys drawn in a quieter step (e.g. days still to come). */
  muted?: Set<string>;
  /** Whole-number values (people, minutes): ticks step by at least 1. */
  integer?: boolean;
  /** Axis labels, given the tick step (money needs more decimals for small steps). Default: `format`. */
  tickFormat?: (value: number, step: number) => string;
}

export function ColumnChart({ data, format, valueLabel, description, height = 200, reference, muted, integer, tickFormat }: ColumnChartProps) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [table, setTable] = useState(false);
  const descId = useId();

  const max = Math.max(0, ...data.map((d) => d.value), reference?.value ?? 0);
  const ticks = ticksFor(max, 4, integer);
  const top = ticks[ticks.length - 1] ?? 1;
  const step = ticks[1] ?? 1;
  const tickLabels = ticks.map((t) => (tickFormat ? tickFormat(t, step) : format(t)));
  const left = Math.min(96, Math.max(28, ...tickLabels.map((t) => t.length * 7 + 10)));
  const margin = { top: 14, right: 4, bottom: 26, left };
  const plotW = Math.max(40, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => margin.top + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 72))));
  const current = active ?? (focused ? data.length - 1 : null);
  const datum = current !== null ? data[current] : undefined;

  const onKey = (event: KeyboardEvent) => {
    if (!data.length) return;
    const at = current ?? data.length - 1;
    if (event.key === 'ArrowLeft') setActive(Math.max(0, at - 1));
    else if (event.key === 'ArrowRight') setActive(Math.min(data.length - 1, at + 1));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(data.length - 1);
    else return;
    event.preventDefault();
  };

  const tipX = datum ? Math.min(Math.max(margin.left + (current! + 0.5) * band, 70), width - 70) : 0;
  const tipY = datum ? y(datum.value) : 0;

  return (
    <div>
      <div
        ref={wrap}
        className="chart"
        tabIndex={0}
        role="group"
        aria-roledescription="gráfico de colunas"
        aria-label={description}
        aria-describedby={descId}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setActive(null);
        }}
        onPointerLeave={() => setActive(null)}
      >
        <svg width={width} height={height} aria-hidden="true">
          {ticks.map((t, i) => (
            <g key={t}>
              <line className={i === 0 ? 'chart-baseline' : 'chart-grid'} x1={margin.left} x2={width - margin.right} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
              <text className="chart-tick" x={margin.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {tickLabels[i]}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const h = Math.max(0, y(0) - y(d.value));
            const x = margin.left + i * band + (band - barW) / 2;
            return (
              <g key={d.key}>
                {h > 0 ? (
                  <path
                    className="chart-bar"
                    data-active={current === i || undefined}
                    data-muted={muted?.has(d.key) || undefined}
                    d={columnPath(x, y(d.value), barW, h)}
                  />
                ) : null}
                <rect className="chart-hit" x={margin.left + i * band} y={margin.top} width={band} height={plotH + margin.bottom} onPointerEnter={() => setActive(i)} />
                {i % every === (data.length - 1) % every ? (
                  <text className="chart-tick" x={margin.left + (i + 0.5) * band} y={height - 6} textAnchor="middle">
                    {d.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          {reference && reference.value > 0 ? (
            <line className="chart-ref" x1={margin.left} x2={width - margin.right} y1={Math.round(y(reference.value)) + 0.5} y2={Math.round(y(reference.value)) + 0.5} />
          ) : null}
        </svg>
        {datum ? (
          <div className="tooltip" style={{ left: tipX, top: tipY }}>
            <strong>{format(datum.value)}</strong>
            <span>{datum.title ?? datum.label}</span>
          </div>
        ) : null}
        <p id={descId} className="visually-hidden" aria-live="polite">
          {datum ? `${datum.title ?? datum.label}: ${format(datum.value)}` : 'Use as setas para percorrer as colunas.'}
        </p>
      </div>
      <div className="chart-foot">
        {/* The reference line is named here, not on the plot, where it would collide with the bars. */}
        {reference && reference.value > 0 ? (
          <span className="chart-legend">
            <span className="chart-legend-line" aria-hidden="true" />
            {reference.label}
          </span>
        ) : (
          <span />
        )}
        <Button variant="ghost" size="sm" onClick={() => setTable((t) => !t)} aria-expanded={table}>
          {table ? 'Esconder tabela' : 'Ver como tabela'}
        </Button>
      </div>
      {table ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">{description}</caption>
            <thead>
              <tr>
                <th scope="col">Dia</th>
                <th scope="col" className="num">
                  {valueLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key}>
                  <td>{d.title ?? d.label}</td>
                  <td className="num">{format(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  display: string;
}

/** A ranked list with a bar under each row; the value sits at the bar's end of the row. */
export function BarList({ items, label, empty }: { items: BarItem[]; label: string; empty?: ReactNode }) {
  if (items.length === 0) return <p className="muted">{empty ?? 'Nada por aqui ainda.'}</p>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="barlist" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className="barlist-row">
          <span className="barlist-label">{item.label}</span>
          <span className="barlist-value">{item.display}</span>
          <span className="barlist-bar" aria-hidden="true">
            <span className="barlist-fill" style={{ width: `${Math.max(0.5, (item.value / max) * 100)}%`, display: 'block' }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function meterLevel(ratio: number): 'normal' | 'warning' | 'critical' {
  return ratio >= 1 ? 'critical' : ratio >= 0.8 ? 'warning' : 'normal';
}

/** A share of a limit. The fill turns to warning at 80% and critical at 100%; the caption says it in words. */
export function Meter({ ratio, label, small, caption }: { ratio: number; label: string; small?: boolean; caption?: ReactNode }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div>
      <div
        className={`meter${small ? ' meter-sm' : ''}`}
        data-level={meterLevel(ratio)}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`${Math.round(ratio * 100)}%`}
      >
        <div className="meter-fill" style={{ width: `${clamped * 100}%` }} />
      </div>
      {caption ? <div className="meter-caption">{caption}</div> : null}
    </div>
  );
}
