import type { SourceDTO } from "@/lib/core/detail";
import { COPY } from "@/lib/copy";
import { formatClockEt, formatDate } from "@/lib/format";

export interface SourceListProps {
  sources: SourceDTO[];
}

export function SourceList({ sources }: SourceListProps) {
  if (sources.length === 0) {
    return <p className="text-xs text-muted">{COPY.detail.noSources}</p>;
  }
  return (
    <ul className="divide-y divide-hairline">
      {sources.map((source, index) => (
        <li key={`${source.title}-${index}`} className="py-2 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate text-xs text-ink hover:text-accent"
                >
                  {source.title}
                </a>
              ) : (
                <span className="block truncate text-xs text-ink">{source.title}</span>
              )}
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                <span>{source.source_name ?? "Publisher unavailable"}</span>
                {source.tier !== null ? <span className="font-mono">T{source.tier}</span> : null}
                <span className="font-mono">quality {source.quality_score === null ? "unavailable" : source.quality_score.toFixed(2)}</span>
                {source.ingest_provider ? <span>via {source.ingest_provider}</span> : null}
                <span className="font-mono">
                  {source.published_at
                    ? `Published ${formatDate(source.published_at)} ${formatClockEt(source.published_at)}`
                    : `Publication time unavailable · received ${formatDate(source.received_at)} ${formatClockEt(source.received_at)}`}
                </span>
                {source.is_primary ? (
                  <span className="border border-hairline px-1 text-[10px] uppercase text-accent">
                    primary
                  </span>
                ) : null}
                {source.is_new_information ? (
                  <span className="border border-accent px-1 text-[10px] uppercase text-accent">new article</span>
                ) : null}
              </div>
              {source.excerpt ? (
                <blockquote className="mt-1 border-l-2 border-hairline pl-2 text-[11px] leading-relaxed text-muted">
                  <span className="mr-1 uppercase tracking-wide">Verbatim excerpt</span>“{source.excerpt}”
                </blockquote>
              ) : (
                <div className="mt-1 text-[11px] text-muted">Article text unavailable; this source cannot verify the claim.</div>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
