export interface LoadingRowsProps {
  rows?: number;
  className?: string;
}

/** Skeleton rows shown on first paint while data is in flight. */
export function LoadingRows({ rows = 5, className }: LoadingRowsProps) {
  return (
    <div className={`space-y-2 ${className ?? ""}`} aria-busy="true" aria-label="Loading rows">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="border border-hairline bg-panel p-3">
          <div className="h-3 w-24 bg-hairline" />
          <div className="mt-2 h-3 w-3/4 bg-hairline" />
          <div className="mt-2 h-3 w-1/2 bg-hairline" />
        </div>
      ))}
    </div>
  );
}
