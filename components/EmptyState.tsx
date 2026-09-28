import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-1 border border-dashed border-hairline px-4 py-6">
      <p className="text-sm text-ink">{title}</p>
      {body ? <p className="text-xs text-muted">{body}</p> : null}
      {action}
    </div>
  );
}
