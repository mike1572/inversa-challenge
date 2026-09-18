import { config, type BBox } from "@/lib/config";
import { runAgent } from "@/lib/agent/run";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The agent, streamed as SSE.
 *
 * Every step emits an event, so the panel is never a bare spinner: footnote
 * chips appear as tools complete, before the model has written a word, which is
 * most of the perceived speed. There is always a terminal event — a dead stream
 * is the worst possible demo failure.
 */
export async function POST(req: Request) {
  let body: {
    question?: string;
    context?: { bbox?: number[]; from?: string; to?: string };
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }

  const question = (body.question ?? "").trim();
  if (!question) {
    return new Response(JSON.stringify({ error: "question is required" }), { status: 400 });
  }

  const now = new Date();
  const bboxRaw = body.context?.bbox;
  const bbox: BBox =
    Array.isArray(bboxRaw) && bboxRaw.length === 4 && bboxRaw.every(Number.isFinite)
      ? (bboxRaw as BBox)
      : config.regionBBox;

  const to = body.context?.to ? new Date(body.context.to) : now;
  const from = body.context?.from
    ? new Date(body.context.from)
    : new Date(to.getTime() - config.historyDays * 86_400_000);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of runAgent(question, { bbox, from, to })) {
          send(event);
        }
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        send({ type: "done" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
