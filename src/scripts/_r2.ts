import { db } from "#common/db";
export { fetchObject } from "#common/s3";

export const randomIds = (n: number) =>
  db
    .query<{ id: string }, [number]>(`SELECT id FROM "replays" ORDER BY random() LIMIT ?`)
    .all(n)
    .map((r) => r.id);

export const pool = async <T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) => {
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
};

export const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
};
