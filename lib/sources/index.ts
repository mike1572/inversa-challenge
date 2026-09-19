import { firms } from "./firms";
import { nws } from "./nws";
import { openaq } from "./openaq";
import { openMeteo } from "./openmeteo";
import type { SourceAdapter } from "./types";

/** Adding a fifth feed is one file plus one line here. */
const ADAPTERS: Record<string, SourceAdapter> = {
  firms,
  openaq,
  open_meteo: openMeteo,
  nws,
};

export const SOURCE_IDS = Object.keys(ADAPTERS);

export function getAdapter(id: string): SourceAdapter {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`Unknown source "${id}". Known: ${SOURCE_IDS.join(", ")}`);
  return a;
}

export { firms, openaq, openMeteo, nws };
export type { SourceAdapter };
