import { timingSafeEqual } from "node:crypto";
import { db, statements } from "#common/db";
import { env, optionalEnv } from "#common/env";
import { parseRows } from "#common/ingest";
import { decodeReplay } from "#common/codec";
import { fetchObject } from "#common/s3";
import root from "./site/index.html";

// lets a scraper on another machine add rows. disabled unless INGEST_TOKEN is set
const INGEST_TOKEN = optionalEnv.INGEST_TOKEN;

const authorized = (req: Request) => {
  if (!INGEST_TOKEN) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${INGEST_TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
};

const allIds = db.prepare<{ id: string }, []>(`SELECT id FROM "replays"`);
const insertMany = db.transaction((rows: NonNullable<ReturnType<typeof parseRows>>) => {
  for (const r of rows) statements.insertReplay.run(r.id, r.p1_uid, r.p2_uid, r.timestamp, r.format, r.size);
});

const server = Bun.serve({
  routes: {
    "/": root,
    "/users/:user": (ctx) => {
      const user = ctx.params.user;
      const replays = statements.fromUser.all(user);
      return Response.json(replays);
    },
    "/replay/:id": async (ctx) => {
      const id = ctx.params.id;
      if (!statements.getReplay.get(id)) return new Response("not found", { status: 404 });
      return Response.json(decodeReplay(await fetchObject(id)));
    },
    "/codec/dict-v1.bin": new Response(Bun.file(new URL("../common/codec-dict-v1.bin", import.meta.url))),
    "/ingest/ids": {
      GET: (req) => {
        if (!authorized(req)) return new Response("unauthorized", { status: 401 });
        return Response.json(allIds.all().map((r) => r.id));
      },
    },
    "/ingest": {
      POST: async (req) => {
        if (!authorized(req)) return new Response("unauthorized", { status: 401 });
        const rows = parseRows(await req.json().catch(() => null));
        if (!rows) return new Response("bad rows", { status: 400 });
        insertMany(rows);
        return Response.json({ inserted: rows.length });
      },
    },
    "/replays": () => {
      const replays = statements.allReplays.all();
      return Response.json(replays);
    },
  },

  port: env.PORT,
});

console.log(`live at http://localhost:${env.PORT}`);
