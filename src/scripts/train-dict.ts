// bun run src/scripts/train-dict.ts --n 2000 --out src/common/codec-dict-v1.bin
// never retrain a shipped version, bump the format version instead
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeReplay, v1Body } from "#common/codec";
import { readFile } from "node:fs/promises";
import { arg, fetchObject, pool, randomIds } from "./_r2";

const n = Number(arg("n", "2000"));
const out = arg("out", "src/common/codec-dict-v1.bin")!;
const maxdict = arg("maxdict", "112640")!;

const dir = await mkdtemp(path.join(tmpdir(), "tlr-dict-"));
const exclude = arg("exclude");
const skip = new Set(exclude ? (await readFile(exclude, "utf8")).split("\n") : []);
const ids = randomIds(n + skip.size).filter((id) => !skip.has(id)).slice(0, n);
const idsOut = arg("ids-out");
if (idsOut) await writeFile(idsOut, ids.join("\n"));
let done = 0;
await pool(ids, 16, async (id) => {
  try {
    await writeFile(path.join(dir, id), v1Body(decodeReplay(await fetchObject(id))));
  } catch (e) {
    console.error(id, e);
  }
  if (++done % 100 === 0) console.log(`${done}/${ids.length}`);
});

const proc = Bun.spawnSync(["zstd", "--train", "-q", `--maxdict=${maxdict}`, "-r", dir, "-o", out]);
await rm(dir, { recursive: true, force: true });
if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
console.log(`wrote ${out}`);
