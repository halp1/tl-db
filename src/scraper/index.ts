import { ch } from "@haelp/teto/ch";
import type { Replay } from "@haelp/teto/types";
import { API, Logger } from "@haelp/teto/utils";
import { env, optionalEnv } from "#common/env";
import { upload } from "#common/s3";
import { encodeReplay, setCompressorPoolSize, TLR_MIME } from "#common/codec";
import type { RunUpdate } from "#common/ingest";
import { openStore, type Store } from "./store";

// each level-22 dict compressor keeps ~340MB resident, 4 of them got the scraper OOM-killed on the vps
setCompressorPoolSize(Number(optionalEnv.SCRAPE_COMPRESSORS ?? "1"));

const DRY_RUN = false;

const logger = new Logger("");

export const matches = async (uid: string) => {
  const records = await ch.users.personalRecords(uid, "league", "recent");
  return records.filter((record) => !record.stub).map((record) => record.replayid);
};

export const download = async (client: API, id: string) => {
  const replay = await client.channel.replay(id);
  if (replay.replay.gamemode !== "league") throw new Error("Replay is not a TL Replay");
  return replay.replay as Replay;
};

const load = async (store: Store, cache: Set<string>, userid: string) => {
  if (!userid) throw new Error("User not found");

  const m = await matches(userid);
  const toDownload = m.filter((id) => !cache.has(id) && !store.has(id));

  return toDownload;

  // for (const id of toDownload) {
  //   download(client, id)
  //     .then((replay) => {
  //       queue.push({ id, replay });
  //     })
  //     .catch((e) => {
  //       console.error(`Failed to download replay (${id})`, e);
  //     })
  //     .finally(() => {
  //       active--;
  //       notify?.();
  //     });
  // }

  // while (active > 0 || queue.length > 0) {
  //   if (queue.length === 0) {
  //     await new Promise<void>((resolve) => {
  //       notify = resolve;
  //     });
  //     notify = null;
  //   }
  //   while (queue.length > 0) {
  //     yield queue.shift()!;
  //   }
  // }
};

async function* scrape(store: Store, cache: Set<string>, minTR: number) {
  let last: ch.Types.LeaderboardEntry | undefined;

  let downloaded = 0;

  while (true) {
    const after: string | undefined = last
      ? `${last.p.pri}:${last.p.sec}:${last.p.ter}`
      : undefined;
    const raw = await ch.users.leaderboard(
      "league",
      after ? { after, limit: 100 } : { limit: 100 },
    );

    const set: ch.Types.LeaderboardEntry[] = raw.filter(
      (entry) => entry.league?.tr && entry.league.tr >= minTR,
    );

    logger.progress(`${0} / ${downloaded + 1} - ${downloaded + 1 + set.length}`, 0);

    let i = 0;
    for (const user of set) {
      for (const replay of await load(store, cache, user._id)) {
        yield replay;
      }
      i++;

      logger.progress(`${i} / ${downloaded + 1} - ${downloaded + 1 + set.length}`, i / set.length);
    }

    logger.success(`Downloaded ${downloaded + 1} - ${downloaded + 1 + set.length}`);
    downloaded += set.length;

    if (set.length === 0 || set.length !== raw.length) break;

    last = set.at(-1);
  }
}

let inserted = 0;

const uploadIndividual = async (
  store: Store,
  cache: Set<string>,
  { id, replay }: { id: string; replay: Replay },
) => {
  const { data, format, error } = await encodeReplay(replay);
  if (error) logger.warn(`v1 encode failed for ${id}, stored as v0: ${error}`);
  if (DRY_RUN) return;
  await upload(id, data, TLR_MIME);

  await store.insert({
    id,
    p1_uid: replay.users[0]?.id!,
    p2_uid: replay.users[1]?.id!,
    timestamp: new Date(replay.ts).getTime(),
    format,
    size: data.length,
  });

  cache.add(id);
  inserted++;
};

const uploadAll = async (store: Store, minTR: number, concurrency = 1) => {
  const client = new API({
    token: env.TETRIO_TOKEN,
    userAgent:
      "Mozilla/5.0 (Linux; Android 9; AFTGAZL Build/PS7607.3166N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/102.0.5005.125 Mobile Safari/537.36 FE v1.79.1",
  });

  const cache = new Set<string>();
  const iterator = scrape(store, cache, minTR)[Symbol.asyncIterator]();

  const worker = async () => {
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;

      let backoffUntil = 0;

      try {
        let replay: Replay | undefined;
        do {
          try {
            if (Date.now() < backoffUntil)
              await new Promise((resolve) =>
                setTimeout(resolve, backoffUntil - Date.now() + Math.random() * 1000),
              );
            replay = await download(client, value);
          } catch (e) {
            if (e instanceof Error && e.message.includes("429")) {
              logger.warn(`429 on ${value}`);
              backoffUntil = Date.now() + 10000;
            } else {
              throw e;
            }
          }
        } while (!replay);

        await uploadIndividual(store, cache, { id: value, replay });
      } catch (e) {
        console.error(e);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
};

const store = await openStore();
logger.info(`storing rows in ${store.mode}`);

const runId = await store.startRun();
const report = (update: RunUpdate) =>
  store.updateRun(runId, update).catch((e) => logger.warn(`could not report run status: ${e}`));

const heartbeat = setInterval(() => report({ status: "running", inserted }), 60_000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    clearInterval(heartbeat);
    await report({ status: "failed", inserted, error: `stopped by ${signal}` });
    process.exit(1);
  });
}

try {
  await uploadAll(store, 18_000, 5);
  clearInterval(heartbeat);
  await report({ status: "ok", inserted });
  logger.success(`scrape finished, ${inserted} new replays`);
} catch (e) {
  clearInterval(heartbeat);
  await report({ status: "failed", inserted, error: String(e) });
  throw e;
}
