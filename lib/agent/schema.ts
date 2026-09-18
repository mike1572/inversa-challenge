/**
 * The answer envelope.
 *
 * `view` is the reason this is an interface rather than a chatbot: the agent
 * returns where the map should look and what time range matters, so asking a
 * question moves the map and sets the timeline.
 *
 * Strict mode requires additionalProperties:false and EVERY property listed in
 * required — optional fields are expressed as nullable unions, not by omission.
 */

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prose", "claims", "view", "confidence", "caveats"],
  properties: {
    prose: {
      type: "string",
      description:
        "The answer in plain language, 2-5 sentences. Every numeric claim must " +
        "carry an inline citation like [E1] matching an evidence_id you were given.",
    },
    claims: {
      type: "array",
      description: "Each factual statement paired with the evidence backing it.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence_ids"],
        properties: {
          text: { type: "string" },
          evidence_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    view: {
      type: "object",
      additionalProperties: false,
      required: ["bbox", "t_from", "t_to", "focus_station_id", "layers"],
      properties: {
        bbox: {
          type: ["array", "null"],
          description:
            "[west, south, east, north] the map should move to. Use null when the " +
            "question is not about a place — the map should stay where the user " +
            "left it rather than jumping somewhere arbitrary.",
          items: { type: "number" },
        },
        t_from: { type: "string", description: "ISO 8601 UTC start of the relevant window." },
        t_to: { type: "string", description: "ISO 8601 UTC end of the relevant window." },
        focus_station_id: {
          type: ["integer", "null"],
          description: "Station the answer centres on, or null.",
        },
        layers: {
          type: "array",
          items: { type: "string", enum: ["fires", "pm25", "wind", "alerts"] },
        },
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    caveats: {
      type: "array",
      description:
        "Stale, missing, out-of-coverage or conflicting data you encountered. " +
        "Empty array if none. Never leave a known data problem unstated.",
      items: { type: "string" },
    },
  },
} as const;

export interface AnswerEnvelope {
  prose: string;
  claims: { text: string; evidence_ids: string[] }[];
  view: {
    bbox: [number, number, number, number] | null;
    t_from: string;
    t_to: string;
    focus_station_id: number | null;
    layers: ("fires" | "pm25" | "wind" | "alerts")[];
  };
  confidence: "high" | "medium" | "low";
  caveats: string[];
}
