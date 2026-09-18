/**
 * Pull the answer text out of a half-finished JSON envelope.
 *
 * The model streams the structured output, so `delta` events are raw JSON
 * tokens rather than prose — which is why this panel used to show a static "…"
 * for the entire time the answer was being written. `prose` is the first
 * property in the schema, so it arrives first and can be shown as it lands.
 *
 * Deliberately hand-rolled rather than attempting JSON.parse: the buffer is
 * invalid JSON until the final character, and an escape sequence can be split
 * across two chunks. Anything unreadable simply stops the scan and gets picked
 * up on the next delta.
 */
export function partialProse(raw: string): string {
  const key = raw.indexOf('"prose"');
  if (key === -1) return "";

  let i = raw.indexOf(":", key + 7);
  if (i === -1) return "";
  i = raw.indexOf('"', i);
  if (i === -1) return "";
  i++;

  let out = "";
  while (i < raw.length) {
    const c = raw[i];

    if (c === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break; // escape split across chunks
      if (next === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out +=
        next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "" : next;
      i += 2;
      continue;
    }

    if (c === '"') break; // closing quote — prose is complete
    out += c;
    i++;
  }
  return out;
}
