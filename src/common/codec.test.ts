import { afterAll, describe, expect, test } from "bun:test";
import {
  decodeReplay,
  detectFormat,
  encodeReplay,
  encodeV0,
  legacyPackr,
  normalize,
  orderedDeepEqual,
  closeCodec,
} from "./codec";

afterAll(() => closeCodec());

const key = (frame: number, type: string, k: string, subframe: number, extra: object = {}) => ({
  frame,
  type,
  data: { key: k, subframe, ...extra },
});

const mk = (events: any[], extra: { results?: any; options?: any } = {}) => ({
  id: "abc",
  gamemode: "league",
  ts: new Date("2026-10-22T09:21:27.632Z"),
  users: [{ id: "u1", username: "a" }],
  replay: {
    leaderboard: [],
    rounds: [
      [
        {
          id: "u1",
          replay: {
            frames: 100,
            events,
            options: extra.options ?? { seed: 1, handling: { arr: 0, das: 6 } },
            results: extra.results ?? { stats: { lines: 3 }, aggregatestats: { apm: 1.5 }, gameoverreason: "winner" },
          },
        },
      ],
    ],
  },
  version: 1,
});

const roundTrip = async (r: any, expectedFormat: 0 | 1 = 1) => {
  const res = await encodeReplay(r);
  expect(res.error).toBeUndefined();
  expect(res.format).toBe(expectedFormat);
  expect(detectFormat(res.data)).toBe(expectedFormat);
  expect(orderedDeepEqual(decodeReplay(res.data), normalize(r))).toBe(true);
  return res;
};

const ige = (frame: number, id: number, type: string, data: any, igeFrame = frame) => ({
  frame,
  type: "ige",
  data: { id, frame: igeFrame, type, data },
});

describe("codec", () => {
  test("basic key events with hoisted and all known keys", async () => {
    await roundTrip(
      mk([
        { frame: 0, type: "start", data: {} },
        key(1, "keydown", "hold", 0.9),
        key(1, "keyup", "hold", 0.9, { hoisted: true }),
        key(5, "keydown", "exit", 0),
        key(5, "keyup", "undo", 0.3),
        key(400, "keydown", "rotate180", 0.5),
        key(90000, "keyup", "rotate180", 0.1),
      ]),
    );
  });

  test("unusual key events stay in the body", async () => {
    const r = mk([
      key(10, "keydown", "foo", 0),
      key(10, "keydown", "hardDrop", 0.25),
      key(9, "keyup", "hardDrop", 0),
      key(11, "keydown", "hold", 0, { hoisted: false }),
      key(12, "keydown", "hold", 0, { other: 1 }),
      { type: "keydown", frame: 13, data: { key: "hold", subframe: 0 } },
      { frame: 14, type: "keydown", data: { subframe: 0, key: "hold" } },
      key(15.5, "keydown", "hold", 0),
      key(16, "keydown", "hold", 1),
      key(17, "keydown", "hold", -0.1),
      { frame: 18, type: "keyup", data: null },
    ]);
    await roundTrip(r);
  });

  test("interaction_confirm dedupe and non matching confirms", async () => {
    const g = (amt: number) => ({ type: "garbage", amt, gameid: 1, frame: 3, cid: 1, iid: 1, ackiid: 0, x: 2, y: 39, size: 1 });
    await roundTrip(
      mk([
        ige(5, 0, "interaction", g(4), 3),
        ige(9, 1, "interaction_confirm", g(4), 3),
        ige(12, 2, "interaction_confirm", g(5), 3),
        ige(13, 3, "interaction_confirm", g(4), 4),
        ige(14, 4, "interaction_confirm", { ...g(4), iid: 99 }),
        { frame: 15, type: "ige", data: { frame: 3, id: 5, type: "interaction_confirm", data: g(4) } },
      ]),
    );
  });

  test("end and full events with partial matches and reordered keys", async () => {
    const opts = { seed: 1, version: 19, handling: { arr: 0, das: 6 } };
    const results = { stats: { lines: 3 }, aggregatestats: { apm: 1.5 }, gameoverreason: "winner" };
    await roundTrip(
      mk(
        [
          { frame: 0, type: "full", data: { game: { board: [[null]], handling: { arr: 0, das: 6 }, playing: true } } },
          {
            frame: 50,
            type: "end",
            data: {
              successful: false,
              options: { version: 19, seed: 2, extra: true, handling: { arr: 0, das: 6 } },
              game: { handling: { das: 6, arr: 0 } },
              diyusi: 0,
              stats: { lines: 3 },
              aggregatestats: { apm: 1.6 },
              gameoverreason: "winner",
            },
          },
          { frame: 51, type: "end", data: "weird" },
        ],
        { options: opts, results },
      ),
    );
  });

  test("missing results and options", async () => {
    const r: any = mk([{ frame: 1, type: "end", data: { stats: {} } }, key(2, "keydown", "hold", 0)]);
    delete r.replay.rounds[0][0].replay.results;
    delete r.replay.rounds[0][0].replay.options;
    await roundTrip(r);
  });

  test("empty and non key rounds", async () => {
    const r: any = mk([]);
    r.replay.rounds.push([{ id: "u2", replay: { events: [{ frame: 0, type: "start", data: {} }] } }]);
    r.replay.rounds.push([]);
    r.replay.rounds.push([{ id: "u3", replay: { events: "nope" } }, null]);
    await roundTrip(r);
  });

  test("structure without rounds", async () => {
    await roundTrip({ a: 1 });
    await roundTrip({ replay: { rounds: "x" } });
  });

  test("decodes legacy msgpackr bytes", async () => {
    const r = mk([key(1, "keydown", "hold", 0)]);
    const legacy = legacyPackr.pack(r);
    expect(detectFormat(legacy)).toBe("legacy");
    expect(orderedDeepEqual(decodeReplay(legacy), normalize(r))).toBe(true);
  });

  test("falls back to v0 when v1 fails or mismatches", async () => {
    const r = normalize(mk([key(1, "keydown", "hold", 0)]));
    for (const _v1 of [
      () => {
        throw new Error("boom");
      },
      async () => (await encodeReplay(mk([]), { normalized: true })).data,
    ]) {
      const res = await encodeReplay(r, { normalized: true, _v1 });
      expect(res.format).toBe(0);
      expect(res.error).toBeDefined();
      expect(detectFormat(res.data)).toBe(0);
      expect(orderedDeepEqual(decodeReplay(res.data), r)).toBe(true);
    }
  });

  test("v0 round trip", async () => {
    const r = normalize(mk([key(1, "keydown", "hold", 0)]));
    expect(orderedDeepEqual(decodeReplay(await encodeV0(r)), r)).toBe(true);
  });

  test("rejects truncated and unknown versions", async () => {
    const { data } = await encodeReplay(mk([key(1, "keydown", "hold", 0)]));
    expect(() => decodeReplay(data.subarray(0, data.length - 3))).toThrow();
    const bad = data.slice();
    bad[3] = 9;
    expect(() => decodeReplay(bad)).toThrow();
  });

  test("orderedDeepEqual", async () => {
    expect(orderedDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(orderedDeepEqual([1, { x: new Date(5) }], [1, { x: new Date(5) }])).toBe(true);
    expect(orderedDeepEqual(0, -0)).toBe(false);
    expect(orderedDeepEqual(NaN, NaN)).toBe(true);
    expect(orderedDeepEqual({ a: undefined }, {})).toBe(false);
  });
});

test("concurrent encodes share the compressor pool", async () => {
  const rs = Array.from({ length: 12 }, (_, i) =>
    mk([key(i, "keydown", "hold", 0), { frame: i + 1, type: "end", data: { n: "x".repeat(i * 500) } }]),
  );
  const out = await Promise.all(rs.map((r) => encodeReplay(r)));
  out.forEach((o, i) => {
    expect(o.format).toBe(1);
    expect(orderedDeepEqual(decodeReplay(o.data), normalize(rs[i]))).toBe(true);
  });
});
