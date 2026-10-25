
import { Packr } from "msgpackr";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

export const MAGIC = [0x54, 0x4c, 0x52] as const;
export const TLR_MIME = "application/x-tlr";

export const legacyPackr = new Packr({
  bundleStrings: true,
  useRecords: true,
  structuredClone: true,
  useFloat32: 3,
  moreTypes: false,
});

const bodyPackr = new Packr({
  useRecords: false,
  structuredClone: true,
  useFloat32: 3,
  moreTypes: false,
});

// append only
export const KEYS = [
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "hold",
  "retry",
  "exit",
  "undo",
] as const;
const KEY_INDEX = new Map<string, number>(KEYS.map((k, i) => [k, i]));

let dictCache: Buffer | null | undefined;
const loadDict = (): Buffer | null => {
  if (dictCache !== undefined) return dictCache;
  try {
    dictCache = readFileSync(new URL("./codec-dict-v1.bin", import.meta.url));
  } catch {
    dictCache = null;
  }
  return dictCache;
};
export const _setDict = (d: Buffer | null) => {
  dictCache = d;
  resetPool();
};

class Writer {
  buf = new Uint8Array(1024);
  len = 0;
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(n: number) {
    this.grow(1);
    this.buf[this.len++] = n;
  }
  varint(n: number) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad varint ${n}`);
    this.grow(8);
    while (n >= 128) {
      this.buf[this.len++] = (n % 128) | 128;
      n = Math.floor(n / 128);
    }
    this.buf[this.len++] = n;
  }
  bytes(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  done() {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  i = 0;
  constructor(public b: Uint8Array) {}
  u8() {
    if (this.i >= this.b.length) throw new Error("unexpected end of data");
    return this.b[this.i++]!;
  }
  varint() {
    let n = 0;
    let m = 1;
    let x: number;
    do {
      x = this.u8();
      n += (x & 127) * m;
      m *= 128;
    } while (x & 128);
    return n;
  }
  bytes(n: number) {
    if (this.i + n > this.b.length) throw new Error("unexpected end of data");
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
}

const enum Method {
  Raw = 0,
  Brotli = 1,
  Zstd = 2,
  ZstdDict = 3,
}

const brotliAsync = promisify(zlib.brotliCompress);
const zstdAsync = promisify(zlib.zstdCompress);

const brotli = (b: Uint8Array) =>
  brotliAsync(b, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length,
    },
  });

const zstd = (b: Uint8Array) =>
  zstdAsync(b, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 22 },
  } as zlib.ZstdOptions);

// loading the dict costs ~500ms, so keep long lived streams and emit one frame per call
interface Compressor {
  s: zlib.ZstdCompress;
  out: Buffer[];
  gen: number;
}
let poolSize = 4;
let gen = 0;
let created = 0;
const idle: Compressor[] = [];
const waiters: ((c: Compressor) => void)[] = [];

export const setCompressorPoolSize = (n: number) => {
  poolSize = Math.max(1, n);
};

const makeCompressor = (dict: Buffer): Compressor => {
  const s = zlib.createZstdCompress({
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 22 },
    dictionary: dict,
  } as zlib.ZstdOptions);
  const c: Compressor = { s, out: [], gen };
  s.on("data", (chunk: Buffer) => c.out.push(chunk));
  s.on("error", () => {});
  return c;
};

const acquire = async (dict: Buffer): Promise<Compressor> => {
  const c = idle.pop();
  if (c) return c;
  if (created < poolSize) {
    created++;
    return makeCompressor(dict);
  }
  return await new Promise((resolve) => waiters.push(resolve));
};

const release = (c: Compressor) => {
  if (c.gen !== gen) {
    c.s.close();
    return;
  }
  const w = waiters.shift();
  if (w) w(c);
  else idle.push(c);
};

const discard = (c: Compressor, dict: Buffer) => {
  c.s.destroy();
  if (c.gen !== gen) return;
  created--;
  const w = waiters.shift();
  if (w) {
    created++;
    w(makeCompressor(dict));
  }
};

function resetPool() {
  gen++;
  created = 0;
  for (const c of idle.splice(0)) c.s.close();
}

// lets the process exit once encoding is done
export const closeCodec = () => resetPool();

const zstdDict = async (b: Uint8Array, dict: Buffer): Promise<Uint8Array> => {
  const c = await acquire(dict);
  try {
    const out = await new Promise<Buffer>((resolve, reject) => {
      c.s.once("error", reject);
      c.s.write(b);
      c.s.flush(zlib.constants.ZSTD_e_end, () => {
        c.s.off("error", reject);
        const o = Buffer.concat(c.out);
        c.out.length = 0;
        resolve(o);
      });
    });
    release(c);
    return out;
  } catch (e) {
    discard(c, dict);
    throw e;
  }
};

const compressBest = async (b: Uint8Array, methods: Method[]): Promise<[Method, Uint8Array]> => {
  const dict = loadDict();
  const outs = await Promise.all(
    methods.map(async (m): Promise<[Method, Uint8Array] | null> => {
      if (m === Method.Brotli) return [m, await brotli(b)];
      if (m === Method.Zstd) return [m, await zstd(b)];
      if (m === Method.ZstdDict && dict) return [m, await zstdDict(b, dict)];
      return null;
    }),
  );
  let best: [Method, Uint8Array] = [Method.Raw, b];
  for (const o of outs) if (o && o[1].length < best[1].length) best = o;
  return best;
};

const decompress = (m: number, b: Uint8Array): Uint8Array => {
  switch (m) {
    case Method.Raw:
      return b;
    case Method.Brotli:
      return zlib.brotliDecompressSync(b);
    case Method.Zstd:
      return zlib.zstdDecompressSync(b);
    case Method.ZstdDict: {
      const d = loadDict();
      if (!d) throw new Error("codec-dict-v1.bin is required to decode this replay");
      return zlib.zstdDecompressSync(b, { dictionary: d } as zlib.ZstdOptions);
    }
    default:
      throw new Error(`unknown section method ${m}`);
  }
};

const sameKeys = (a: object, b: object) => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  return true;
};

// deep equal that also checks key order
export const orderedDeepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return Object.is(a.getTime(), (b as Date).getTime());
  if (ArrayBuffer.isView(a)) {
    const bv = b as ArrayBufferView;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(bv.buffer, bv.byteOffset, bv.byteLength);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (a instanceof Map || a instanceof Set)
    return orderedDeepEqual([...(a as Map<unknown, unknown>)], [...(b as Map<unknown, unknown>)]);
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (i in a !== i in bb) return false;
      if (!orderedDeepEqual(a[i], bb[i])) return false;
    }
    return sameKeys(a, bb);
  }
  if (!sameKeys(a, b)) return false;
  for (const k of Object.keys(a))
    if (!orderedDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  return true;
};

type Obj = Record<string, any>;
const isObj = (x: unknown): x is Obj =>
  typeof x === "object" &&
  x !== null &&
  !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const eachRoundPlayer = (r: any, fn: (u: Obj) => void) => {
  const rounds = r?.replay?.rounds;
  if (!Array.isArray(rounds)) return;
  for (const rd of rounds) {
    if (!Array.isArray(rd)) continue;
    for (const u of rd) if (isObj(u) && isObj(u.replay) && Array.isArray(u.replay.events)) fn(u);
  }
};

const refsFor = (u: Obj): Record<string, Obj | undefined> => {
  const rp = u.replay;
  const res = isObj(rp.results) ? rp.results : undefined;
  const opts = isObj(rp.options) ? rp.options : undefined;
  const end: Obj = {};
  if (res)
    for (const k of ["gameoverreason", "stats", "aggregatestats"]) if (has(res, k)) end[k] = res[k];
  return {
    end,
    opts,
    hand: opts && has(opts, "handling") ? { handling: opts.handling } : undefined,
  };
};

// [path, ref], applied in order on encode and in reverse on decode
const STRIP_PLANS: Record<string, [string[], string][]> = {
  end: [
    [["data"], "end"],
    [["data", "options"], "opts"],
    [["data", "game"], "hand"],
  ],
  full: [[["data", "game"], "hand"]],
};

// [plan index, original key order, dropped key indices]
type Patch = [number, string[], number[]];

const getPath = (o: any, path: string[]) => {
  for (const k of path) {
    if (!isObj(o)) return undefined;
    o = o[k];
  }
  return o;
};
const setPath = (o: any, path: string[], v: unknown) => {
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]!];
  o[path[path.length - 1]!] = v;
};

const cloneAlong = (ev: Obj, paths: string[][]): Obj => {
  const root: Obj = { ...ev };
  for (const path of paths) {
    let cur = root;
    for (const k of path) {
      if (!isObj(cur[k])) break;
      cur[k] = { ...cur[k] };
      cur = cur[k];
    }
  }
  return root;
};

const stripEvent = (ev: Obj, refs: Record<string, Obj | undefined>): [Obj, Patch[]] | null => {
  const plan = STRIP_PLANS[ev.type];
  if (!plan) return null;
  const out = cloneAlong(
    ev,
    plan.map((p) => p[0]),
  );
  const patches: Patch[] = [];
  plan.forEach(([path, refName], pi) => {
    const target = getPath(out, path);
    const ref = refs[refName];
    if (!isObj(target) || !ref) return;
    const order = Object.keys(target);
    const dropped: number[] = [];
    const kept: Obj = {};
    order.forEach((k, i) => {
      if (has(ref, k) && orderedDeepEqual(target[k], ref[k])) dropped.push(i);
      else kept[k] = target[k];
    });
    if (dropped.length === 0) return;
    setPath(out, path, kept);
    patches.push([pi, order, dropped]);
  });
  return patches.length ? [out, patches] : null;
};

const unstripEvent = (ev: Obj, patches: Patch[], refs: Record<string, Obj | undefined>): Obj => {
  const plan = STRIP_PLANS[ev.type];
  if (!plan) throw new Error(`no strip plan for ${ev.type}`);
  for (let i = patches.length - 1; i >= 0; i--) {
    const [pi, order, dropped] = patches[i]!;
    const [path, refName] = plan[pi]!;
    const target = getPath(ev, path);
    const ref = refs[refName];
    if (!isObj(target) || !ref) throw new Error("corrupt patch");
    const drop = new Set(dropped);
    const rebuilt: Obj = {};
    order.forEach((k, idx) => {
      rebuilt[k] = drop.has(idx) ? structuredClone(ref[k]) : target[k];
    });
    setPath(ev, path, rebuilt);
  }
  return ev;
};

const isKeyEvent = (e: unknown, lastFrame: number): e is Obj => {
  if (!isObj(e)) return false;
  if (e.type !== "keydown" && e.type !== "keyup") return false;
  const k = Object.keys(e);
  if (k.length !== 3 || k[0] !== "frame" || k[1] !== "type" || k[2] !== "data") return false;
  const f = e.frame;
  if (!Number.isSafeInteger(f) || Object.is(f, -0) || f < lastFrame) return false;
  const d = e.data;
  if (!isObj(d)) return false;
  const dk = Object.keys(d);
  if (dk[0] !== "key" || dk[1] !== "subframe") return false;
  if (dk.length === 3) {
    if (dk[2] !== "hoisted" || d.hoisted !== true) return false;
  } else if (dk.length !== 2) return false;
  if (typeof d.key !== "string" || !KEY_INDEX.has(d.key)) return false;
  if (typeof d.subframe !== "number") return false;
  const s = Math.round(d.subframe * 10);
  return s >= 0 && s <= 9 && Object.is(s / 10, d.subframe);
};

// [keysBefore, event] | [keysBefore, event, 1, patches] | [keysBefore, [frame, id], 2, iid]
type Entry = [number, any] | [number, any, 1, Patch[]] | [number, [number, any], 2, unknown];

const confirmRef = (e: Obj, interactions: Map<unknown, Obj>): unknown => {
  if (e.type !== "ige" || !sameKeys(e, { frame: 0, type: 0, data: 0 })) return undefined;
  const d = e.data;
  if (!isObj(d) || d.type !== "interaction_confirm") return undefined;
  if (!sameKeys(d, { id: 0, frame: 0, type: 0, data: 0 }) || !isObj(d.data) || !has(d.data, "iid"))
    return undefined;
  const o = interactions.get(d.data.iid);
  if (!o || !Object.is(o.frame, d.frame) || !orderedDeepEqual(o.data, d.data)) return undefined;
  return d.data.iid;
};

const trackInteraction = (e: Obj, interactions: Map<unknown, Obj>) => {
  if (e.type !== "ige") return;
  const d = e.data;
  if (isObj(d) && d.type === "interaction" && isObj(d.data) && has(d.data, "iid"))
    interactions.set(d.data.iid, d);
};

const splitReplay = (r: any) => {
  const cols = {
    codes: new Writer(),
    deltas: new Writer(),
    subs: new Writer(),
    counts: new Writer(),
  };
  if (!isObj(r) || !isObj(r.replay) || !Array.isArray(r.replay.rounds)) return { cols, body: r };
  const body = { ...r, replay: { ...r.replay } };
  body.replay.rounds = body.replay.rounds.map((rd: unknown) =>
      Array.isArray(rd)
        ? rd.map((u) => (isObj(u) && isObj(u.replay) ? { ...u, replay: { ...u.replay } } : u))
        : rd,
    );

  eachRoundPlayer(body, (u) => {
    const refs = refsFor(u);
    const interactions = new Map<unknown, Obj>();
    const entries: Entry[] = [];
    let last = 0;
    let n = 0;
    for (const e of u.replay.events as unknown[]) {
      if (isKeyEvent(e, last)) {
        cols.codes.u8(KEY_INDEX.get(e.data.key)! * 2 + (e.type === "keyup" ? 1 : 0));
        cols.deltas.varint(e.frame - last);
        cols.subs.u8(Math.round(e.data.subframe * 10) | (e.data.hoisted ? 16 : 0));
        last = e.frame;
        n++;
        continue;
      }
      if (isObj(e)) {
        const iid = confirmRef(e, interactions);
        trackInteraction(e, interactions);
        if (iid !== undefined) {
          entries.push([n, [e.frame, e.data.id], 2, iid]);
          continue;
        }
        const stripped = stripEvent(e, refs);
        if (stripped) {
          entries.push([n, stripped[0], 1, stripped[1]]);
          continue;
        }
      }
      entries.push([n, e]);
    }
    cols.counts.varint(n);
    u.replay.events = entries;
  });
  return { cols, body };
};

const joinReplay = (
  codes: Uint8Array,
  deltas: Uint8Array,
  subs: Uint8Array,
  counts: Uint8Array,
  body: any,
) => {
  const dr = new Reader(deltas);
  const cr = new Reader(counts);
  let ki = 0;
  eachRoundPlayer(body, (u) => {
    const refs = refsFor(u);
    const interactions = new Map<unknown, Obj>();
    const entries = u.replay.events as Entry[];
    const n = cr.varint();
    const out: unknown[] = [];
    let ei = 0;
    let last = 0;
    const flush = (upto: number) => {
      while (ei < entries.length && entries[ei]![0] === upto) {
        const en = entries[ei++]!;
        let ev: any;
        if (en.length === 2) ev = en[1];
        else if (en[2] === 1) ev = unstripEvent(en[1], en[3] as Patch[], refs);
        else if (en[2] === 2) {
          const o = interactions.get(en[3]);
          if (!o) throw new Error("dangling interaction_confirm reference");
          const [frame, id] = en[1] as [number, unknown];
          ev = {
            frame,
            type: "ige",
            data: { id, frame: o.frame, type: "interaction_confirm", data: structuredClone(o.data) },
          };
        } else throw new Error("corrupt entry");
        if (isObj(ev)) trackInteraction(ev, interactions);
        out.push(ev);
      }
    };
    for (let i = 0; i < n; i++) {
      flush(i);
      if (ki >= codes.length || ki >= subs.length) throw new Error("key stream too short");
      const c = codes[ki]!;
      const s = subs[ki]!;
      ki++;
      last += dr.varint();
      const key = KEYS[c >> 1];
      if (!key) throw new Error(`unknown key code ${c}`);
      const data: Obj = { key, subframe: (s & 15) / 10 };
      if (s & 16) data.hoisted = true;
      out.push({ frame: last, type: c & 1 ? "keyup" : "keydown", data });
    }
    flush(n);
    if (ei !== entries.length) throw new Error("unconsumed body entries");
    u.replay.events = out;
  });
  if (ki !== codes.length) throw new Error("key stream too long");
  return body;
};

// uncompressed v1 body, for dictionary training
export const v1Body = (r: any) => bodyPackr.pack(splitReplay(normalize(r)).body);

const encodeV1 = async (r: any): Promise<Uint8Array> => {
  const { cols, body } = splitReplay(r);
  const col = [Method.Brotli, Method.Zstd];
  // the dict always beats brotli/zstd on the body, only try them without it
  const bodyMethods = loadDict() ? [Method.ZstdDict] : [Method.Brotli, Method.Zstd];
  const sections = await Promise.all([
    compressBest(cols.codes.done(), col),
    compressBest(cols.deltas.done(), col),
    compressBest(cols.subs.done(), col),
    compressBest(cols.counts.done(), col),
    compressBest(bodyPackr.pack(body), bodyMethods),
  ]);
  return frame(1, sections);
};

export const encodeV0 = async (r: any): Promise<Uint8Array> =>
  frame(0, [await compressBest(legacyPackr.pack(r), [Method.Brotli, Method.Zstd])]);

const frame = (version: number, sections: [Method, Uint8Array][]) => {
  const w = new Writer();
  for (const b of MAGIC) w.u8(b);
  w.u8(version);
  for (const [m, b] of sections) {
    w.u8(m);
    w.varint(b.length);
    w.bytes(b);
  }
  return w.done().slice();
};

export type Format = "legacy" | 0 | 1;

export const detectFormat = (buf: Uint8Array): Format => {
  if (buf.length >= 4 && buf[0] === MAGIC[0] && buf[1] === MAGIC[1] && buf[2] === MAGIC[2]) {
    const v = buf[3]!;
    if (v === 0 || v === 1) return v;
    throw new Error(`unsupported TLR version ${v}`);
  }
  return "legacy";
};

// matches what the legacy pipeline stored (float32 rounding etc)
export const normalize = (r: any) => legacyPackr.unpack(legacyPackr.pack(r));

export interface EncodeResult {
  data: Uint8Array;
  format: 0 | 1;
  error?: unknown;
}

// decodeReplay(result.data) is always orderedDeepEqual to normalize(r)
export const encodeReplay = async (
  r: any,
  opts: { normalized?: boolean; _v1?: (r: any) => Promise<Uint8Array> | Uint8Array } = {},
): Promise<EncodeResult> => {
  const norm = opts.normalized ? r : normalize(r);
  try {
    const data = await (opts._v1 ?? encodeV1)(norm);
    if (!orderedDeepEqual(decodeReplay(data), norm)) throw new Error("v1 round trip mismatch");
    return { data, format: 1 };
  } catch (error) {
    return { data: await encodeV0(norm), format: 0, error };
  }
};

export const decodeReplay = (buf: Uint8Array): any => {
  const fmt = detectFormat(buf);
  if (fmt === "legacy") return legacyPackr.unpack(buf);
  const rd = new Reader(buf);
  rd.i = 4;
  const section = () => {
    const m = rd.u8();
    return decompress(m, rd.bytes(rd.varint()));
  };
  if (fmt === 0) {
    const out = legacyPackr.unpack(section());
    if (rd.i !== buf.length) throw new Error("trailing data");
    return out;
  }
  const codes = section();
  const deltas = section();
  const subs = section();
  const counts = section();
  const body = bodyPackr.unpack(section());
  if (rd.i !== buf.length) throw new Error("trailing data");
  return joinReplay(codes, deltas, subs, counts, body);
};
