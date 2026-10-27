import { db } from "./db";
import { upload } from "./s3";

const KEY = "app.db";

let chain: Promise<void> = Promise.resolve();

// serialize() takes a consistent snapshot including anything still in the WAL.
// backups are chained so an older snapshot can never land after a newer one
export const backupDb = () => {
  const run = chain.then(async () => {
    const data = db.serialize();
    await upload(KEY, data, "application/vnd.sqlite3");
    console.log(`backed up db to r2 as ${KEY} (${data.length} bytes)`);
  });
  chain = run.catch(() => {});
  return run;
};
