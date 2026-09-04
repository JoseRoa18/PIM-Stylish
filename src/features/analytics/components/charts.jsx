import { useId, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

// Chart marks follow one spec: 2px lines, 8px markers with a surface ring,
// a 10% area wash, hairline grid, text in text tokens (never the series
// color), a crosshair + tooltip on hover. Colors come from the theme tokens
// so both themes read.

/** Signed change chip. `upIsGood` decides the color of the direction. */
export function DeltaChip({ value, suffix = '', upIsGood = true, vs = 'last week' }) {
  if (value == null) {
    return <span className="inline-flex items-center gap-1 text-label-md text-on-surface-variant">no earlier snapshot</span>;
  }
  const good = value === 0 ? null : (value > 0) === upIsGood;
  const cls = good == null ? 'text-on-surface-variant' : good ? 'text-success' : 'text-error';
  const Icon = value === 0 ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-1 text-label-md font-semibold ${cls}`} title={`vs ${vs}`}>
      <Icon className="w-3.5 h-3.5" />
      {value > 0 ? '+' : ''}{value}{suffix}
      <span className="font-normal text-on-surface-variant">vs {vs}</span>
    </span>
  );
}

/** Progress meter: fill carries state, the track is a lighter step. */
export function Meter({ pct, marker = null, tone = 'accent', className = '' }) {
  const fill = tone === 'good' ? 'bg-success' : tone === 'warn' ? 'bg-warning' : tone === 'bad' ? 'bg-error' : 'bg-primary';
  return (
    <div className={`relative h-2 rounded-full bg-surface-container-high overflow-visible ${className}`} role="img" aria-label={`${pct}%`}>
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      {marker != null && (
        <div className="absolute -top-1 h-4 w-0.5 bg-on-surface-variant" style={{ left: `calc(${Math.max(0, Math.min(100, marker))}% - 1px)` }} title={`Target ${marker}%`} />
      )}
    </div>
  );
}

/** 12-point sparkline; the current point in the accent, the rest quiet. */
export function Sparkline({ points, width = 120, height = 32, max = 100 }) {
  const id = useId();
  const valid = points.map((p, i) => ({ ...p, i })).filter((p) => typeof p.value === 'number');
  if (valid.length === 0) return <span className="text-label-md text-on-surface-variant">no history yet</span>;
  const n = points.length;
  const x = (i) => (n === 1 ? width / 2 : 4 + (i / (n - 1)) * (width - 8));
  const y = (v) => height - 4 - (v / max) * (height - 8);
  const d = valid.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const last = valid[valid.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="overflow-visible text-primary">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.14" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g>
        {valid.length > 1 && (
          <path d={`${d} L${x(last.i).toFixed(1)},${height - 4} L${x(valid[0].i).toFixed(1)},${height - 4} Z`} fill={`url(#${id})`} />
        )}
        <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="text-secondary" />
        <circle cx={x(last.i)} cy={y(last.value)} r="4" fill="currentColor" stroke="var(--color-surface-container-lowest)" strokeWidth="2" />
      </g>
    </svg>
  );
}

/**
 * Single-series line over weeks with crosshair + tooltip. `points` =
 * [{ label, value|null, date }]. Y is 0–100 (a share) unless `max` is set.
 */
export function LineTrend({ points, max = 100, unit = '%', height = 220, ariaLabel }) {
  const [hover, setHover] = useState(null);
  const width = 720;
  const pad = { l: 36, r: 16, t: 16, b: 28 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const n = points.length;
  const x = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const valid = useMemo(() => points.map((p, i) => ({ ...p, i })).filter((p) => typeof p.value === 'number'), [points]);
  const ticks = [0, 25, 50, 75, 100].map((t) => (t / 100) * max);
  const path = valid.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = valid.length > 1 ? `${path} L${x(valid[valid.length - 1].i).toFixed(1)},${y(0)} L${x(valid[0].i).toFixed(1)},${y(0)} Z` : null;
  const last = valid[valid.length - 1];

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = null;
    for (const p of points.map((q, i) => ({ ...q, i }))) {
      const dx = Math.abs(x(p.i) - px);
      if (!best || dx < best.dx) best = { ...p, dx };
    }
    setHover(best);
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto text-on-surface-variant"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-outline-variant)" strokeWidth="1" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="currentColor">{Math.round(t)}{unit}</text>
          </g>
        ))}
        {points.map((p, i) => (
          <text key={p.label + i} x={x(i)} y={height - 8} textAnchor="middle" fontSize="11" fill="currentColor" opacity={n > 8 && i % 2 === 1 ? 0 : 1}>{p.label}</text>
        ))}
        {area && <path d={area} fill="var(--color-primary)" opacity="0.1" />}
        {path && <path d={path} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {valid.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.value)} r={hover?.i === p.i ? 5 : 4} fill="var(--color-primary)" stroke="var(--color-surface-container-lowest)" strokeWidth="2" />
        ))}
        {last && (
          <text x={x(last.i) + 8} y={y(last.value) + 4} fontSize="12" fontWeight="600" fill="var(--color-on-surface)">{last.value}{unit}</text>
        )}
        {hover && (
          <line x1={x(hover.i)} x2={x(hover.i)} y1={pad.t} y2={pad.t + ih} stroke="var(--color-outline)" strokeWidth="1" />
        )}
      </svg>
      {hover && (
        <div
          className="absolute top-2 pointer-events-none rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body-sm shadow-sm"
          style={{ left: `calc(${(x(hover.i) / width) * 100}% + 8px)` }}
        >
          <div className="text-label-md text-on-surface-variant">{hover.label}{hover.date ? ` · ${hover.date}` : ''}</div>
          <div className="text-on-surface font-semibold">{typeof hover.value === 'number' ? `${hover.value}${unit}` : 'no snapshot'}</div>
        </div>
      )}
    </div>
  );
}
