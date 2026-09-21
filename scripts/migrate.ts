import { getDb, runMigrations } from "../src/lib/db/client";

const db = getDb();
const n = runMigrations(db);
console.log(`Database ready. Applied ${n} new migration(s) (idempotent).`);
