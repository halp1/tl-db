import { db, statements } from "#common/db";
import { env } from "#common/env";
import { decodeReplay } from "#common/codec";
import { fetchObject } from "#common/s3";
import root from "./site/index.html";

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
    "/replays": () => {
      const replays = statements.allReplays.all();
      return Response.json(replays);
    },
  },

  port: env.PORT,
});

console.log(`live at http://localhost:${env.PORT}`);
