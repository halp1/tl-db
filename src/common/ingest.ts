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
