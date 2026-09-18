import Explorer from "@/components/Explorer";
import { config } from "@/lib/config";
import { getWindow, type WindowPayload } from "@/lib/query/window";

export const dynamic = "force-dynamic";

/**
 * Server component: the first window is fetched here so the map paints with
 * data rather than a spinner. If the database isn't reachable yet we still
 * render — Explorer retries client-side and shows the real error.
 */
export default async function Home() {
  let initial: WindowPayload | null = null;
  try {
    const to = new Date();
    const from = new Date(to.getTime() - config.historyDays * 86_400_000);
    initial = await getWindow(from, to);
  } catch {
    initial = null;
  }

  return <Explorer initial={initial} />;
}
