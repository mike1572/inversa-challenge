"use client";

import { useRef, useState } from "react";
import type { AnswerEnvelope } from "@/lib/agent/schema";
import type { EvidenceRecord } from "@/lib/agent/run";
import { useStore, type AgentMessage } from "@/lib/store";

const SUGGESTIONS = [
  "Why is the air bad in Bend, Oregon right now?",
  "Is any Canadian smoke reaching the US right now?",
  "Which fire is affecting Sacramento?",
  "Show me the worst air in North America this week",
  "How fresh is your data?",
];

const TOOL_LABELS: Record<string, string> = {
  find_stations: "finding stations",
  get_series: "reading the time series",
  get_fires: "searching fire detections",
  upwind_fires: "checking upwind fires",
  find_smoke_sources: "tracing smoke across the region",
  compare_to_normal: "comparing to normal",
  get_alerts: "checking weather alerts",
  find_conflicts: "checking sensor disagreement",
  data_freshness: "checking feed health",
};

export default function AgentPanel({
  onAnswer,
}: {
  onAnswer: (answer: AnswerEnvelope) => void;
}) {
  const [input, setInput] = useState("");
  const messages = useStore((s) => s.messages);
  const data = useStore((s) => s.data);
  const startMessage = useStore((s) => s.startMessage);
  const patchMessage = useStore((s) => s.patchMessage);
  const appendProse = useStore((s) => s.appendProse);
  const addEvidence = useStore((s) => s.addEvidence);
  const setActiveEvidence = useStore((s) => s.setActiveEvidence);
  const busy = messages.some((m) => m.streaming);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    const id = crypto.randomUUID();
    startMessage(id, question);
    setInput("");
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: 1e6, behavior: "smooth" }),
    );

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          context: data
            ? { bbox: data.meta.bbox, from: data.meta.from, to: data.meta.to }
            : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          switch (event.type) {
            case "status":
              patchMessage(id, {
                status: TOOL_LABELS[event.tool as string] ?? (event.tool as string),
              });
              break;
            case "evidence":
              // Footnote chips land before the prose exists — most of the
              // perceived speed comes from this.
              addEvidence(id, event.evidence as EvidenceRecord);
              patchMessage(id, { status: null });
              break;
            case "delta":
              appendProse(id, event.text as string);
              break;
            case "answer":
              patchMessage(id, {
                answer: event.answer as AnswerEnvelope,
                streaming: false,
                status: null,
              });
              onAnswer(event.answer as AnswerEnvelope);
              break;
            case "error":
              patchMessage(id, {
                error: event.message as string,
                streaming: false,
                status: null,
              });
              break;
          }
        }
      }
      patchMessage(id, { streaming: false, status: null });
    } catch (err) {
      patchMessage(id, {
        error: err instanceof Error ? err.message : String(err),
        streaming: false,
        status: null,
      });
    }
  };

  return (
    <div className="panel flex h-full flex-col">
      {/*
        The composer lives at the TOP, not pinned to the bottom of a long
        column. Below the fold and rendered in near-black it read as a disabled
        footer, and people clicked only the suggestions — which then look like
        the sole way in. Here it is the first thing in the panel, on a raised
        surface with a real submit control, and the suggestions sit underneath
        as alternatives.
      */}
      <div className="border-line-soft border-b px-3 pt-3 pb-3">
        <label htmlFor="ask" className="label">
          Ask
        </label>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
          className="mt-2 flex items-center gap-1.5"
        >
          <div className="focus-within:border-ember/70 focus-within:bg-hover bg-raised border-line flex flex-1 items-center rounded-md border transition-colors">
            <input
              id="ask"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={busy ? "Working…" : "Ask about smoke, fires or air quality"}
              disabled={busy}
              autoComplete="off"
              className="text-ink placeholder:text-ink-3 w-full bg-transparent px-2.5 py-2 text-[12.5px] focus:outline-none disabled:opacity-60"
            />
          </div>
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Ask"
            className="bg-ember hover:bg-ember/90 disabled:bg-raised disabled:text-ink-3 border-line grid h-[34px] w-[34px] shrink-0 place-items-center rounded-md border border-transparent text-[15px] leading-none font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:border-solid"
          >
            ↵
          </button>
        </form>

        <div className="text-ink-3 mt-1.5 text-[10px] leading-snug">
          Every figure is cited — click a citation to see the source data.
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <div className="label">Try</div>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  style={{ animationDelay: `${i * 45}ms` }}
                  className="border-line-soft text-ink-2 hover:border-line hover:bg-raised hover:text-ink rise block w-full rounded-md border px-2.5 py-2 text-left text-[11.5px] leading-snug transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <Message key={m.id} m={m} onEvidence={setActiveEvidence} />
        ))}
      </div>
    </div>
  );
}

function Message({
  m,
  onEvidence,
}: {
  m: AgentMessage;
  onEvidence: (id: number) => void;
}) {
  const byLabel = new Map(m.evidence.map((e) => [e.label, e]));

  return (
    <div className="border-line-soft space-y-2.5 border-l-2 pl-3">
      <div className="text-ink text-[12.5px] leading-snug font-medium">{m.question}</div>

      {m.evidence.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {m.evidence.map((e) => (
            <button
              key={e.id}
              onClick={() => onEvidence(e.id)}
              title={`${e.tool} → ${e.rowCount} row${e.rowCount === 1 ? "" : "s"}`}
              className="border-ember-dim text-ember tnum rise rounded border bg-[#fff4e6] px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[#ffe9d1]"
            >
              {e.label} <span className="opacity-70">{e.tool}</span>
            </button>
          ))}
        </div>
      )}

      {m.status && (
        <div className="text-ink-3 flex items-center gap-1.5 text-[11px]">
          <span className="bg-ember inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
          {m.status}…
        </div>
      )}

      {m.answer ? (
        <Prose text={m.answer.prose} byLabel={byLabel} onEvidence={onEvidence} />
      ) : (
        m.prose && <div className="text-ink-3 text-[12px] leading-relaxed">…</div>
      )}

      {m.answer && m.answer.caveats.length > 0 && (
        <ul className="border-ember-dim space-y-1 rounded-md border bg-[#fff7ec] px-2 py-1.5">
          {m.answer.caveats.map((c, i) => (
            <li key={i} className="text-ember text-[10.5px] leading-snug">
              {c}
            </li>
          ))}
        </ul>
      )}

      {m.answer && (
        <div className="text-ink-3 label">{m.answer.confidence} confidence</div>
      )}

      {m.error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
          {m.error}
        </div>
      )}
    </div>
  );
}

/** Renders [E1] citations as clickable footnotes. */
function Prose({
  text,
  byLabel,
  onEvidence,
}: {
  text: string;
  byLabel: Map<string, EvidenceRecord>;
  onEvidence: (id: number) => void;
}) {
  const parts = text.split(/(\[E\d+\])/g);
  return (
    <div className="text-ink-2 text-[12.5px] leading-[1.65]">
      {parts.map((part, i) => {
        const match = /^\[(E\d+)\]$/.exec(part);
        if (!match) return <span key={i}>{part}</span>;
        const ev = byLabel.get(match[1]);
        if (!ev) {
          // A citation that resolves to nothing is a bug worth seeing, not hiding.
          return (
            <span key={i} className="tnum text-ink-3 text-[10px]">
              {part}
            </span>
          );
        }
        return (
          <button
            key={i}
            onClick={() => onEvidence(ev.id)}
            className="text-ember tnum mx-0.5 rounded bg-[#fff0dd] px-1 align-super text-[9.5px] transition-colors hover:bg-[#ffe0bd]"
          >
            {match[1]}
          </button>
        );
      })}
    </div>
  );
}
