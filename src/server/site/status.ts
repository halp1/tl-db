/// <reference lib="dom" />

type Status = { replays: number } & (
  | { status: "never" }
  | {
      status: "running" | "ok" | "failed";
      started_at: number;
      finished_at: number | null;
      inserted: number;
      last_success_at: number | null;
    }
);

const el = document.getElementById("scrape-status")!;
const countEl = document.getElementById("replay-count")!;

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const render = (s: Status) => {
  if (s.status === "never") return "No scrapes yet";
  if (s.status === "running") return `Scrape in progress, started ${when(s.started_at)} (${s.inserted} new so far)`;
  if (s.status === "ok") return `Last scraped ${when(s.finished_at!)}`;
  const failed = `Last scrape failed at ${when(s.finished_at ?? s.started_at)}`;
  return s.last_success_at ? `${failed}. Last successful scrape ${when(s.last_success_at)}` : failed;
};

const refresh = async () => {
  try {
    const r = await fetch("/status");
    if (!r.ok) throw new Error(String(r.status));
    const s = (await r.json()) as Status;
    el.textContent = render(s);
    el.dataset.status = s.status;
    countEl.textContent = `tl-db is currently storing ${s.replays.toLocaleString()} replays.`;
    countEl.hidden = false;
  } catch {
    el.textContent = "Scrape status unavailable";
    el.dataset.status = "unknown";
    countEl.hidden = true;
  }
};

await refresh();
setInterval(refresh, 60_000);
