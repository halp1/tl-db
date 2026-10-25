import {Database} from 'bun:sqlite';
import path from 'node:path';
import fs from 'node:fs/promises';

await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
export const db = new Database(path.join(process.cwd(), "data", 'app.db'));
db.run("PRAGMA journal_mode = WAL;");

db.run(`
CREATE TABLE IF NOT EXISTS "replays" (
	id TEXT PRIMARY KEY,
	p1_uid TEXT NOT NULL,
	p2_uid TEXT NOT NULL,
	timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_p1 ON "replays" (p1_uid);
CREATE INDEX IF NOT EXISTS idx_p2 ON "replays" (p2_uid);
`);

// format: -1 legacy msgpackr, 0/1 TLR version
const cols = db.query<{ name: string }, []>(`PRAGMA table_info("replays")`).all().map((c) => c.name);
if (!cols.includes("format")) db.run(`ALTER TABLE "replays" ADD COLUMN format INTEGER NOT NULL DEFAULT -1`);
if (!cols.includes("size")) db.run(`ALTER TABLE "replays" ADD COLUMN size INTEGER`);
db.run(`CREATE INDEX IF NOT EXISTS idx_format ON "replays" (format)`);

export interface ReplayRecord {
	id: string;
	p1_uid: string;
	p2_uid: string;
	timestamp: number;
}

export interface ReplayStorage {
	id: string;
	format: number;
	size: number | null;
}

const PUBLIC = `id, p1_uid, p2_uid, timestamp`;

export const statements = {
	insertReplay: db.prepare<unknown, [id: string, p1_uid: string, p2_uid: string, timestamp: number, format: number, size: number]>(`
		INSERT OR IGNORE INTO "replays" (id, p1_uid, p2_uid, timestamp, format, size)
		VALUES (?, ?, ?, ?, ?, ?)
	`),
	getReplay: db.prepare<ReplayRecord, [string]>(`
		SELECT ${PUBLIC} FROM "replays" WHERE id = ?
	`),
	allReplays: db.prepare<ReplayRecord, []>(`
		SELECT ${PUBLIC} FROM "replays"
	`),
	fromUser: db.prepare<ReplayRecord, [string]>(`
		SELECT ${PUBLIC} FROM "replays" WHERE p1_uid = ?1 UNION SELECT ${PUBLIC} FROM "replays" WHERE p2_uid = ?1
	`),
	setFormat: db.prepare<unknown, [format: number, size: number, id: string]>(`
		UPDATE "replays" SET format = ?, size = ? WHERE id = ?
	`),
	pendingMigration: db.prepare<{ id: string }, [limit: number]>(`
		SELECT id FROM "replays" WHERE format = -1 LIMIT ?
	`),
	storageStats: db.prepare<{ format: number; n: number; bytes: number | null }, []>(`
		SELECT format, COUNT(*) AS n, SUM(size) AS bytes FROM "replays" GROUP BY format
	`),
}		