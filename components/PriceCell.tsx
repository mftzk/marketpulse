import { formatPercent, formatPrice } from "@/lib/format";

import { MOVEMENT_TEXT, movementTone } from "./movement";

export interface PriceCellProps {
  price: number | null;
  changePct: number | null;
  label?: string;
  align?: "left" | "right";
}

/** Price + signed change; colour encodes measured movement only. */
export function PriceCell({ price, changePct, label, align = "right" }: PriceCellProps) {
  const tone = movementTone(changePct);
  return (
    <span className={`inline-flex flex-col ${align === "right" ? "items-end" : "items-start"}`}>
      <span className="font-mono text-sm text-ink">{formatPrice(price)}</span>
      <span className={`font-mono text-[11px] ${MOVEMENT_TEXT[tone]}`}>
        {formatPercent(changePct)}
        {label ? <span className="ml-1 text-muted">{label}</span> : null}
      </span>
    </span>
  );
}
