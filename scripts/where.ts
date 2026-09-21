import { isCloudSyncedPath, resolveDataLocation } from "../src/lib/db/paths";

const loc = resolveDataLocation();
console.log("Project folder      :", process.cwd());
console.log("Project is synced   :", isCloudSyncedPath(process.cwd()) ? "YES (OneDrive/Dropbox/etc.)" : "no");
console.log("Database file       :", loc.dbFile);
console.log("Chosen because      :", loc.source);
console.log("DB inside sync dir  :", loc.insideSyncedFolder ? "YES - move it (set DATABASE_URL)" : "no");
