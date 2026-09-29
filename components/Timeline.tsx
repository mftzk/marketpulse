import { formatClockEt, formatDate } from "@/lib/format";

export interface TimelineItem {
  ts: string;
  label: string;
  kind: string;
}

export interface TimelineProps {
  items: TimelineItem[];
}

export function Timeline({ items }: TimelineProps) {
  if (items.length === 0) {
    return <p className="text-xs text-muted">No timeline entries.</p>;
  }
  return (
    <ol className="relative space-y-3 border-l border-hairline pl-4">
      {items.map((item, index) => (
        <li key={`${item.ts}-${index}`} className="relative">
          <span
            className="absolute -left-[21px] top-1.5 inline-block h-2 w-2 bg-accent"
            aria-hidden="true"
          />
          <div className="font-mono text-[11px] text-muted">{formatDate(item.ts)} {formatClockEt(item.ts)}</div>
          <div className="text-xs text-ink">{item.label}</div>
          <div className="text-[10px] uppercase tracking-wide text-muted">{item.kind}</div>
        </li>
      ))}
    </ol>
  );
}
