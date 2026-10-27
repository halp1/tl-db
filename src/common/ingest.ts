export interface IngestRow {
  id: string;
  p1_uid: string;
  p2_uid: string;
  timestamp: number;
  format: number;
  size: number;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 128;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

export type RunUpdate =
  | { status: "running"; inserted: number }
  | { status: "ok"; inserted: number }
  | { status: "failed"; inserted: number; error: string };

export const parseRunUpdate = (body: unknown): RunUpdate | null => {
  if (typeof body !== "object" || body === null) return null;
  const { status, inserted, error } = body as Record<string, unknown>;
  if (!isInt(inserted) || inserted < 0) return null;
  if (status === "running" || status === "ok") return { status, inserted };
  if (status === "failed" && typeof error === "string") return { status, inserted, error: error.slice(0, 500) };
  return null;
};

type RunStatements = typeof import("./db").statements;

export const applyRunUpdate = (statements: RunStatements, id: number, u: RunUpdate) => {
  const now = Date.now();
  if (u.status === "running") statements.heartbeatRun.run(now, u.inserted, id);
  else statements.finishRun.run(now, u.status, u.inserted, u.status === "failed" ? u.error : null, id);
};

export const parseRows = (body: unknown): IngestRow[] | null => {
  if (!Array.isArray(body) || body.length > 1000) return null;
  const rows: IngestRow[] = [];
  for (const r of body) {
    if (typeof r !== "object" || r === null) return null;
    const { id, p1_uid, p2_uid, timestamp, format, size } = r as Record<string, unknown>;
    if (!isStr(id) || !isStr(p1_uid) || !isStr(p2_uid)) return null;
    if (!isInt(timestamp) || !isInt(format) || !isInt(size)) return null;
    rows.push({ id, p1_uid, p2_uid, timestamp, format, size });
  }
  return rows;
};
