/**
 * Lightweight SVG donut — no chart library. Segments are drawn with
 * stroke-dasharray on concentric circles (same technique as the ScoreRing).
 * Colors come from Tailwind `stroke-*` utilities mapped to the @theme tokens,
 * so the chart stays on-brand and theme-aware.
 *
 * data: [{ key, label, value, stroke }]  — `stroke` is a Tailwind class.
 */
export default function DonutChart({
  data,
  size = 132,
  thickness = 14,
  centerValue,
  centerLabel,
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;

  let acc = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      {/* Track */}
      <circle
        cx={cx}
        cy={cx}
        r={radius}
        fill="none"
        strokeWidth={thickness}
        className="stroke-surface-container"
      />
      {total > 0 &&
        data
          .filter((d) => d.value > 0)
          .map((d) => {
            const fraction = d.value / total;
            const len = fraction * circumference;
            const dasharray = `${len} ${circumference - len}`;
            const dashoffset = -acc;
            acc += len;
            return (
              <circle
                key={d.key}
                cx={cx}
                cy={cx}
                r={radius}
                fill="none"
                strokeWidth={thickness}
                strokeDasharray={dasharray}
                strokeDashoffset={dashoffset}
                strokeLinecap="butt"
                className={`${d.stroke} transition-[stroke-dasharray] duration-500`}
              />
            );
          })}
      {(centerValue != null || centerLabel) && (
        <g className="rotate-90" style={{ transformOrigin: 'center' }}>
          {centerValue != null && (
            <text
              x="50%"
              y="50%"
              dy={centerLabel ? '-0.1em' : '0.35em'}
              textAnchor="middle"
              className="fill-on-surface font-semibold"
              style={{ fontSize: size * 0.22 }}
            >
              {centerValue}
            </text>
          )}
          {centerLabel && (
            <text
              x="50%"
              y="50%"
              dy="1.2em"
              textAnchor="middle"
              className="fill-on-surface-variant"
              style={{ fontSize: size * 0.085 }}
            >
              {centerLabel}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}
