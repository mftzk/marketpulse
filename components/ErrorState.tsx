import { COPY } from "@/lib/copy";

export interface ErrorStateProps {
  title?: string;
  body?: string;
}

export function ErrorState({ title, body }: ErrorStateProps) {
  return (
    <div className="border border-hairline bg-panel-alt px-4 py-5">
      <p className="text-sm text-accent">{title ?? COPY.common.errorTitle}</p>
      <p className="mt-1 text-xs text-muted">{body ?? COPY.common.errorBody}</p>
    </div>
  );
}
