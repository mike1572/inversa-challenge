"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

interface EvidenceDetail {
  id: number;
  label: string;
  tool: string;
  question: string;
  args: Record<string, unknown>;
  result: { rows?: unknown; note?: string } & Record<string, unknown>;
  createdAt: string;
  sources: {
    id: string;
    name: string;
    homepage: string;
    license: string | null;
    coverageNote: string | null;
    lastRequest: { url: string; status: number; fetchedAt: string } | null;
  }[];
}

/**
 * Follow evidence to its source — the tool called, its arguments, the rows it
 * returned, and the exact provider URL with the timestamp we fetched it.
 * One click from any number in any answer.
 */
export default function EvidenceDrawer() {
  const activeEvidenceId = useStore((s) => s.activeEvidenceId);
  const setActiveEvidence = useStore((s) => s.setActiveEvidence);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setActiveEvidence(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveEvidence]);

  if (activeEvidenceId === null) return null;
  // Keyed so switching evidence remounts with empty state, instead of clearing
  // the previous row's data from inside an effect.
  return <EvidenceContents key={activeEvidenceId} evidenceId={activeEvidenceId} />;
}

function EvidenceContents({ evidenceId }: { evidenceId: number }) {
  const setActiveEvidence = useStore((s) => s.setActiveEvidence);
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/evidence/${evidenceId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  const rows = detail?.result?.rows;
  const rowArray = Array.isArray(rows) ? rows : rows ? [rows] : [];

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface">
      <div className="flex items-start justify-between border-line-soft border-b px-3 py-2">
        <div>
          <div className="tnum text-ember text-[11px] font-medium">
            {detail?.label ?? "…"} · {detail?.tool ?? ""}
          </div>
          <div className="text-ink-3 text-[10px]">
            {detail ? new Date(detail.createdAt).toISOString().replace("T", " ").slice(0, 19) + " UTC" : ""}
          </div>
        </div>
        <button
          onClick={() => setActiveEvidence(null)}
          className="border-line bg-raised text-ink-2 hover:bg-hover rounded-md border px-1.5 py-0.5 text-[10px] transition-colors"
        >
          esc
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {error && (
          <div className="rounded border border-red-300 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
            {error}
          </div>
        )}
        {!detail && !error && <div className="text-[11px] text-ink-3">Loading…</div>}

        {detail && (
          <>
            <Section title="Arguments">
              <pre className="overflow-x-auto border-line-soft bg-raised text-ink-2 tnum rounded border p-2 text-[10px] leading-relaxed">
                {JSON.stringify(detail.args, null, 2)}
              </pre>
            </Section>

            {detail.result?.note && (
              <Section title="Note">
                <div className="rounded border-line-soft border bg-raised px-2 py-1.5 text-[11px] leading-snug text-ink-2">
                  {String(detail.result.note)}
                </div>
              </Section>
            )}

            <Section title={`Rows returned (${rowArray.length})`}>
              {rowArray.length === 0 ? (
                <div className="text-[11px] text-ink-3">
                  Empty result — the tool ran and found nothing.
                </div>
              ) : (
                <pre className="max-h-[38vh] overflow-auto border-line-soft bg-raised text-ink-2 tnum rounded border p-2 text-[10px] leading-relaxed">
                  {JSON.stringify(rowArray.slice(0, 40), null, 2)}
                </pre>
              )}
            </Section>

            <Section title="Sources">
              <div className="space-y-2">
                {detail.sources.length === 0 && (
                  <div className="text-[11px] text-ink-3">No upstream source.</div>
                )}
                {detail.sources.map((s) => (
                  <div key={s.id} className="rounded border-line-soft border px-2 py-1.5">
                    <a
                      href={s.homepage}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-medium text-ink underline decoration-ink-3 hover:decoration-ink"
                    >
                      {s.name}
                    </a>
                    {s.license && (
                      <div className="text-ink-3 text-[10px]">{s.license}</div>
                    )}
                    {s.lastRequest && (
                      <div className="mt-1 space-y-0.5">
                        <div className="break-all font-mono text-[9.5px] text-ink-3">
                          {/* already redacted server-side — the key never reaches the client */}
                          {s.lastRequest.url}
                        </div>
                        <div className="text-ink-3 text-[10px]">
                          HTTP {s.lastRequest.status} · fetched{" "}
                          {new Date(s.lastRequest.fetchedAt).toISOString().replace("T", " ").slice(0, 19)} UTC
                        </div>
                      </div>
                    )}
                    {s.coverageNote && (
                      <div className="text-ember mt-1 text-[10px] leading-snug">
                        {s.coverageNote}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}
