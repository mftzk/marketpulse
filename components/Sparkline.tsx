import { MOVEMENT_LABEL, movementTone } from "./movement";

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}

/** Minimal inline-SVG sparkline. No dependency, no canvas. */
export function Sparkline({ values, width = 120, height = 28, className }: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden="true">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="#1b2434"
          strokeWidth={1}
        />
      </svg>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const stepX = width / (clean.length - 1);
  const points = clean
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / span) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const tone = movementTone(clean[clean.length - 1] - clean[0]);
  const stroke = tone === "up" ? "#3ddc84" : tone === "down" ? "#ff5c5c" : "#8fa1bb";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`sparkline, ${MOVEMENT_LABEL[tone]}`}
    >
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.25} />
    </svg>
  );
}
