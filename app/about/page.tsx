import { Panel } from "@/components/Panel";
import { COPY } from "@/lib/copy";
import { formatScore } from "@/lib/format";
import {
  COMPONENT_LABELS,
  COMPONENT_ORDER,
  COMPONENT_WEIGHTS,
} from "@/lib/scoring/components";

export const metadata = {
  title: `About — ${COPY.appName}`,
};

export default function AboutPage() {
  const totalWeight = COMPONENT_ORDER.reduce(
    (sum, key) => sum + COMPONENT_WEIGHTS[key],
    0,
  );

  return (
    <div className="space-y-3">
      <Panel bodyClassName="p-4">
        <h1 className="text-base text-ink">{COPY.about.title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
          {COPY.disclaimer}
        </p>
      </Panel>

      <Panel title={COPY.about.principleTitle}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
          {COPY.about.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Panel>

      <Panel title={COPY.about.pipelineTitle}>
        <div className="min-w-0 overflow-x-auto">
          <ol className="flex min-w-[900px] items-stretch gap-1">
            {COPY.about.pipelineSteps.map((step, index) => (
              <li key={step} className="flex items-center gap-1">
                <div className="flex h-full min-w-[120px] flex-col justify-center border border-hairline bg-panel-alt px-3 py-2">
                  <span className="font-mono text-[10px] text-muted">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="font-mono text-xs text-ink">{step}</span>
                </div>
                {index < COPY.about.pipelineSteps.length - 1 ? (
                  <span className="px-1 text-muted" aria-hidden="true">
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          The pipeline runs on a scheduler inside the server process; reads never trigger
          ingestion or analysis.
        </p>
      </Panel>

      <Panel title={COPY.about.weightsTitle}>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-hairline text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-3 font-medium">Component</th>
                <th className="py-1.5 pr-3 font-medium">Key</th>
                <th className="py-1.5 text-right font-medium">Weight</th>
              </tr>
            </thead>
            <tbody>
              {COMPONENT_ORDER.map((key) => (
                <tr key={key} className="border-b border-hairline last:border-0">
                  <td className="py-1.5 pr-3 text-ink">{COMPONENT_LABELS[key]}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted">{key}</td>
                  <td className="py-1.5 text-right font-mono text-ink">
                    {formatScore(COMPONENT_WEIGHTS[key], 0)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-3 text-muted" colSpan={2}>
                  Total
                </td>
                <td className="py-1.5 text-right font-mono text-accent">
                  {formatScore(totalWeight, 0)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Scores are computed by deterministic code. Missing inputs normalize to zero and
          are labelled “{COPY.common.notAvailable}”, so the score is always produced.
        </p>
      </Panel>
    </div>
  );
}
