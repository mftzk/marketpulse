import type { ReactNode } from "react";

export interface PanelProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** One-panel surface: 1px hairline border, flat panel fill, no shadow. */
export function Panel({ title, action, children, className, bodyClassName }: PanelProps) {
  return (
    <section className={`min-w-0 border border-hairline bg-panel ${className ?? ""}`}>
      {title ? (
        <header className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            {title}
          </h2>
          {action ? <div className="flex items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={bodyClassName ?? "p-3"}>{children}</div>
    </section>
  );
}
