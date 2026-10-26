import { optionalEnv } from "#common/env";
import type { IngestRow } from "#common/ingest";

export interface Store {
  mode: string;
  has(id: string): boolean;
  insert(row: IngestRow): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// sends rows to the server that owns the db, used when the scraper runs on another machine
const remoteStore = async (url: string, token: string): Promise<Store> => {
  const base = url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const res = await fetch(`${base}/ingest/ids`, { headers });
  if (!res.ok) throw new Error(`GET /ingest/ids failed: ${res.status} ${await res.text()}`);
  const known = new Set((await res.json()) as string[]);

  return {
    mode: `remote (${base}, ${known.size} known)`,
    has: (id) => known.has(id),
    async insert(row) {
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await fetch(`${base}/ingest`, {
            method: "POST",
            headers,
            body: JSON.stringify([row]),
          });
          if (r.ok) break;
          // a bad token or bad row will not fix itself
          if (r.status >= 400 && r.status < 500) throw new Error(`POST /ingest ${r.status} ${await r.text()}`);
          throw new Error(`POST /ingest ${r.status}`);
        } catch (e) {
          if (attempt >= 6 || (e instanceof Error && / 4\d\d /.test(e.message))) throw e;
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        }
      }
      known.add(row.id);
    },
  };
};

const localStore = async (): Promise<Store> => {
  const { statements } = await import("#common/db");
  return {
    mode: "local db",
    has: (id) => !!statements.getReplay.get(id),
    async insert(r) {
      statements.insertReplay.run(r.id, r.p1_uid, r.p2_uid, r.timestamp, r.format, r.size);
    },
  };
};

export const openStore = async (): Promise<Store> => {
  const url = optionalEnv.INGEST_URL;
  if (!url) return await localStore();
  const token = optionalEnv.INGEST_TOKEN;
  if (!token) throw new Error("INGEST_URL is set but INGEST_TOKEN is missing");
  return await remoteStore(url, token);
};
