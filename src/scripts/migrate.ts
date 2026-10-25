// bun run src/scripts/migrate.ts [--dry-run] [--limit N] [--concurrency 32] [--compressors 4]
import {
  closeCodec,
  decodeReplay,
  detectFormat,
  encodeReplay,
  orderedDeepEqual,
  setCompressorPoolSize,
  TLR_MIME,
} from "#common/codec";
import { statements } from "#common/db";
import { upload } from "#common/s3";
import { arg, fetchObject, pool } from "./_r2";

const dryRun = arg("dry-run") === "true";
const limit = Number(arg("limit", "1000000000"));
const concurrency = Number(arg("concurrency", "32"));
// each compressor holds ~150MB, more than the number of performance cores does not help
setCompressorPoolSize(Number(arg("compressors", "4")));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let retries = 0;
const retry = async <T>(fn: () => Promise<T>, attempts = 6): Promise<T> => {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      retries++;
      await sleep(Math.min(30_000, 500 * 2 ** i) * (0.5 + Math.random()));
    }
  }
};

const ids = statements.pendingMigration.all(limit).map((r) => r.id);
console.log(`${ids.length} pending${dryRun ? " (dry run)" : ""}`);

let done = 0, failed = 0, fallback = 0, oldBytes = 0, newBytes = 0;
const started = Date.now();

await pool(ids, concurrency, async (id) => {
  try {
    const raw = await retry(() => fetchObject(id));
    const fmt = detectFormat(raw);
    if (fmt !== "legacy") {
      if (!dryRun) statements.setFormat.run(fmt, raw.length, id);
      return;
    }
    const replay = decodeReplay(raw);
    const { data, format, error } = await encodeReplay(replay, { normalized: true });
    if (error) {
      fallback++;
      console.warn(`${id}: v1 failed, using v0: ${error}`);
    }
    // encodeReplay already verifies v1, this also covers v0
    if (!orderedDeepEqual(decodeReplay(data), replay)) throw new Error("verification failed");
    oldBytes += raw.length;
    newBytes += data.length;
    if (!dryRun) {
      await retry(() => upload(id, data, TLR_MIME));
      statements.setFormat.run(format, data.length, id);
    }
  } catch (e) {
    failed++;
    console.error(`${id}: ${e}`);
  } finally {
    if (++done % 100 === 0 || done === ids.length) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(
        `${done}/${ids.length} failed=${failed} retries=${retries} fallback=${fallback} ` +
          `ratio=${((100 * newBytes) / (oldBytes || 1)).toFixed(2)}% ` +
          `${rate.toFixed(1)}/s eta=${Math.round((ids.length - done) / rate / 60)}m`,
      );
    }
  }
});

closeCodec();
console.log({ done, failed, retries, fallback, oldBytes, newBytes });
if (failed) console.log(`${failed} failed, run again to retry them`);
