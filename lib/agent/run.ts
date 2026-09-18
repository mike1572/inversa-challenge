import OpenAI from "openai";
import { config, type BBox } from "../config";
import { sql } from "../db";
import { systemPrompt } from "./prompt";
import { ANSWER_SCHEMA, type AnswerEnvelope } from "./schema";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools";

export interface AskContext {
  bbox: BBox;
  from: Date;
  to: Date;
}

export interface EvidenceRecord {
  id: number;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  sourceIds: string[];
  rowCount: number;
  note?: string;
}

export type AgentEvent =
  | { type: "status"; tool: string; args: Record<string, unknown> }
  | { type: "evidence"; evidence: EvidenceRecord }
  | { type: "delta"; text: string }
  | { type: "answer"; answer: AnswerEnvelope; queryId: string }
  | { type: "error"; message: string };

const MAX_TURNS = 8;

/**
 * One event from the Responses streaming API. The SDK's union is large and
 * version-sensitive; we switch on `type` and read a few fields, so a narrow
 * structural type here would be churn without safety.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamEvent = any;

function countRows(result: unknown): number {
  const rows = (result as { rows?: unknown })?.rows;
  if (Array.isArray(rows)) return rows.length;
  return rows === null || rows === undefined ? 0 : 1;
}

/**
 * The tool loop.
 *
 * Every tool call becomes a persisted evidence row BEFORE the model sees the
 * result, and the evidence label is handed back to the model inside the result
 * payload. That is what makes [E1] in the prose resolve to a real row —
 * without it the model invents citation numbers that point at nothing, which
 * looks fine right up until someone clicks one.
 */
export async function* runAgent(
  question: string,
  ctx: AskContext,
): AsyncGenerator<AgentEvent> {
  if (!config.openaiApiKey) {
    yield { type: "error", message: "OPENAI_API_KEY is not configured." };
    return;
  }

  const now = new Date();
  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  const queryRows = await sql<{ id: string }>(
    `insert into queries (question, context) values ($1, $2::jsonb) returning id`,
    [
      question,
      JSON.stringify({
        bbox: ctx.bbox,
        from: ctx.from.toISOString(),
        to: ctx.to.toISOString(),
      }),
    ],
  );
  const queryId = queryRows[0].id;

  const base = {
    model: config.openaiModel,
    instructions: systemPrompt(now),
    tools: TOOL_DEFINITIONS,
    parallel_tool_calls: true,
    store: false,
    text: {
      format: {
        type: "json_schema" as const,
        name: "answer",
        strict: true,
        schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  };

  // Conversation state: user turn, then the model's own output items and our
  // function_call_output items appended each turn.
  let input: StreamEvent[] = [
    {
      role: "user",
      content: JSON.stringify({
        question,
        viewport: {
          bbox: ctx.bbox,
          from: ctx.from.toISOString(),
          to: ctx.to.toISOString(),
        },
      }),
    },
  ];

  let evidenceCount = 0;
  let finalText = "";

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = (await openai.responses.create({
        ...base,
        input,
        stream: true,
      } as StreamEvent)) as unknown as AsyncIterable<StreamEvent>;

      const calls: { callId: string; name: string; args: string }[] = [];
      let sawOutput = false;

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          finalText += event.delta ?? "";
          yield { type: "delta", text: event.delta ?? "" };
        } else if (event.type === "response.output_item.done") {
          const item = event.item;
          if (item?.type === "function_call") {
            calls.push({
              callId: item.call_id,
              name: item.name,
              args: item.arguments ?? "{}",
            });
          }
        } else if (event.type === "response.completed") {
          sawOutput = true;
          input = input.concat(event.response?.output ?? []);
        } else if (event.type === "error" || event.type === "response.failed") {
          throw new Error(event.error?.message ?? "OpenAI stream failed");
        }
      }

      if (!sawOutput && calls.length === 0) {
        throw new Error("Model returned no output.");
      }

      if (calls.length === 0) break;

      // Run tools in parallel: "why is the air bad in Bend" needs wind, fires
      // and the series, and sequential round-trips would feel sluggish.
      const outputs = await Promise.all(
        calls.map(async (call) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.args || "{}");
          } catch {
            /* fall through with empty args */
          }

          const handler = TOOL_HANDLERS[call.name];
          let result: Record<string, unknown>;
          if (!handler) {
            result = { rows: null, note: `Unknown tool ${call.name}`, sourceIds: [] };
          } else {
            try {
              result = (await handler(args, { now })) as Record<string, unknown>;
            } catch (err) {
              result = {
                rows: null,
                note: `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
                sourceIds: [],
              };
            }
          }

          const label = `E${++evidenceCount}`;
          const sourceIds = (result.sourceIds as string[]) ?? [];

          const saved = await sql<{ id: string }>(
            `insert into evidence (query_id, label, tool, args, result, source_ids)
             values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[]) returning id`,
            [
              queryId,
              label,
              call.name,
              JSON.stringify(args),
              JSON.stringify(result).slice(0, 400_000),
              sourceIds,
            ],
          );

          const record: EvidenceRecord = {
            id: Number(saved[0].id),
            label,
            tool: call.name,
            args,
            sourceIds,
            rowCount: countRows(result),
            note: result.note as string | undefined,
          };

          return {
            record,
            output: {
              type: "function_call_output",
              call_id: call.callId,
              // The label goes back to the model so its citations resolve.
              output: JSON.stringify({ evidence_id: label, ...result }).slice(0, 100_000),
            },
          };
        }),
      );

      for (const { record } of outputs) {
        yield { type: "evidence", evidence: record };
      }
      input = input.concat(outputs.map((o) => o.output));
    }

    let answer: AnswerEnvelope;
    try {
      answer = JSON.parse(finalText) as AnswerEnvelope;
    } catch {
      throw new Error("Model did not return a parseable answer envelope.");
    }

    await sql(`update queries set answer = $2::jsonb where id = $1`, [
      queryId,
      JSON.stringify(answer),
    ]);

    yield { type: "answer", answer, queryId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", message };
  }
}
