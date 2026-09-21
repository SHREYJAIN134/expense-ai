/**
 * Automated security / privacy audit: logging hygiene, AI payload privacy, data location, tenant isolation.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db/client";
import { createUser } from "../src/lib/services/users";
import { confirmImport, stageStatement } from "../src/lib/pipeline/import";
import { exportTransactions, getTransaction, queryTransactions, updateTransaction } from "../src/lib/services/transactions";
import { loadAllTxns } from "../src/lib/services/data";
import { linkRefunds } from "../src/lib/services/refunds";
import { refineWithAi } from "../src/lib/classification/ai-classifier";
import { classifyTransaction } from "../src/lib/classification/classifier";
import { normalizeTransactions } from "../src/lib/parsers/hdfc/normalizer";
import { isCloudSyncedPath, resolveDataLocation } from "../src/lib/db/paths";
import { generateRealHdfcPdf } from "../scripts/real-pdf";
import type { AiProvider } from "../src/lib/ai/provider";
import type { ClassifiedTransaction, ParsedTransaction } from "../src/lib/domain/types";
import { buildRealStatement } from "./real-fixture";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("logging audit (source scan)", () => {
  const files = walk(path.resolve(__dirname, "../src"));
  const hits: { file: string; line: number; text: string }[] = [];
  for (const f of files) {
    fs.readFileSync(f, "utf8").split("\n").forEach((text, i) => {
      if (/\bconsole\.(log|info|debug|warn|error|trace|dir)\s*\(/.test(text)) hits.push({ file: path.relative(path.resolve(__dirname, ".."), f).replace(/\\/g, "/"), line: i + 1, text: text.trim() });
    });
  }

  it("has no console.log/info/debug anywhere in application code", () => {
    expect(hits.filter((h) => /console\.(log|info|debug|trace|dir)\(/.test(h.text))).toEqual([]);
  });

  it("only these fixed, reviewed console calls exist (error class/code and a DB PATH warning)", () => {
    expect(hits.map((h) => h.file).sort()).toEqual(["src/app/api/statements/upload/route.ts", "src/lib/auth/guard.ts", "src/lib/db/client.ts"]);
  });

  it("no logging call mentions passwords, tokens, secrets, keys, narrations, amounts, balances or accounts", () => {
    for (const h of hits) {
      // strip string literals' static text (the message) and check only interpolated/argument identifiers
      const args = h.text.replace(/"[^"]*"|`[^`$]*`/g, "");
      expect(args, `${h.file}:${h.line}`).not.toMatch(/password|token|secret|apiKey|api_key|narration|description|amount|balance|account|transaction|\.message/i);
    }
  });

  it("the API error logger never prints error MESSAGES (they can embed data fragments)", () => {
    const guard = fs.readFileSync(path.resolve(__dirname, "../src/lib/auth/guard.ts"), "utf8");
    expect(guard).not.toMatch(/console\.error\([^)]*err\.message/);
    expect(guard).toMatch(/err\.name/);
  });

  it("no route returns stack traces or raw errors to the client", () => {
    const guard = fs.readFileSync(path.resolve(__dirname, "../src/lib/auth/guard.ts"), "utf8");
    expect(guard).not.toMatch(/\.stack/);
  });

  it("the auth secret and AI key are never referenced from client code", () => {
    const client = files.filter((f) => /components|lib[\\/]client|app[\\/]\(app\)|app[\\/]login/.test(f) && !/api[\\/]/.test(f));
    for (const f of client) {
      const src = fs.readFileSync(f, "utf8");
      // Help text may NAME the variable; what must never appear is code that READS secrets.
      expect(src, f).not.toMatch(/process\.env|getAuthSecret|getAiProvider|from "@\/lib\/(auth\/secret|ai\/provider)"/);
    }
  });
});

describe("AI privacy", () => {
  const norm = (desc: string, over: Partial<ParsedTransaction> = {}) =>
    normalizeTransactions([{ date: "2026-08-14", rawDescription: desc, debit: 4321.5, credit: 0, balance: 98765.43, reference: "0000621331236828", rowIndex: 0, warnings: [], ...over }]).transactions[0];
  const classified = (desc: string, over: Partial<ParsedTransaction> = {}): ClassifiedTransaction => {
    const n = norm(desc, over);
    return { ...n, ...classifyTransaction(n) };
  };

  it("sends only a cleaned merchant snippet + direction - never amounts, dates, balances, references, VPAs, bank codes, account/customer ids or emails", async () => {
    const rows = [classified("UPI-QWXZ1 KLPT-QWXZ.PAY@OKHDFCBANK-HDFC0ABCDEF-621331236828-INVOICE 4471 mail me@example.com A/C 50100123456789 CUST 987654321")];
    expect(rows[0].category).toBe("OTHER"); // ambiguous -> eligible for AI
    let sent = "";
    const provider: AiProvider = { name: "mock", complete: async (req) => ((sent = req.system + "\n" + req.user), "[]") };
    await refineWithAi(rows, provider);
    expect(sent).toContain("Qwxz1 Klpt");
    for (const forbidden of ["4321", "98765", "2026-08-14", "0000621331236828", "621331236828", "@", "OKHDFCBANK", "HDFC0ABCDEF", "50100123456789", "987654321", "example.com", "me@", "%PDF"]) {
      expect(sent, forbidden).not.toContain(forbidden);
    }
  });

  it("never sends people (transfers) or gateway-only rows: they are resolved deterministically", async () => {
    const rows = [
      classified("UPI-RAHUL NEGI-RAKHINEGI634@OKHDFCBANK-PUNB0123456-621331236828-UPI"),
      classified("UPI-RAZORPAY-RAZORPAY@ICICI-ICIC0000001-623533333333-PAYMENT"),
    ];
    expect(rows.map((r) => r.category)).toEqual(["TRANSFERS", "NEEDS_REVIEW"]);
    let called = false;
    const provider: AiProvider = { name: "mock", complete: async () => ((called = true), "[]") };
    const res = await refineWithAi(rows, provider);
    expect(called).toBe(false);
    expect(res.attempted).toBe(false);
  });

  it("the deterministic parser and database remain the source of truth: AI cannot override a user correction or a known merchant", async () => {
    const rows = [classified("UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY")];
    const provider: AiProvider = { name: "mock", complete: async () => '[{"k":0,"category":"SHOPPING","subcategory":"Online Shopping","confidence":0.99}]' };
    await refineWithAi(rows, provider);
    expect(rows[0]).toMatchObject({ category: "GROCERIES", method: "merchant" });
  });
});

describe("data location (OneDrive / cloud-sync safety)", () => {
  const env = (o: Record<string, string> = {}) => ({ ...o }) as NodeJS.ProcessEnv;

  it("recognises cloud-synced folders", () => {
    for (const p of ["C:\\Users\\A\\OneDrive\\Desktop\\proj", "C:\\Users\\A\\OneDrive - Contoso\\proj", "/home/a/Dropbox/proj", "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/x", "/Users/a/Google Drive/x", "D:\\iCloud Drive\\x"]) {
      expect(isCloudSyncedPath(p), p).toBe(true);
    }
    for (const p of ["C:\\dev\\expense-ai", "/home/a/projects/expense-ai", "C:\\Users\\A\\Documents\\dev"]) expect(isCloudSyncedPath(p), p).toBe(false);
  });

  it("when the PROJECT is inside a synced folder the default database goes to a local app-data dir instead", () => {
    const loc = resolveDataLocation("C:\\Users\\A\\OneDrive\\Desktop\\Web Development\\expense ai", env());
    expect(loc.source).toMatch(/local-app-data/);
    expect(isCloudSyncedPath(loc.dbFile)).toBe(false);
    expect(loc.dbFile).toMatch(/expense-?ai/i);
    expect(loc.insideSyncedFolder).toBe(false);
  });

  it("a non-synced project keeps ./data; DATABASE_URL and EXPENSE_AI_DATA_DIR win; :memory: is respected", () => {
    expect(resolveDataLocation("/home/a/dev/expense-ai", env()).dbFile.replace(/\\/g, "/")).toMatch(/\/home\/a\/dev\/expense-ai\/data\/expense-ai\.db$|expense-ai[\\/]data[\\/]expense-ai\.db$/);
    expect(resolveDataLocation("/x", env({ DATABASE_URL: ":memory:" })).dbFile).toBe(":memory:");
    expect(resolveDataLocation("/x", env({ EXPENSE_AI_DATA_DIR: "/srv/eai" })).source).toBe("EXPENSE_AI_DATA_DIR");
    const explicit = resolveDataLocation("C:\\Users\\A\\OneDrive\\proj", env({ DATABASE_URL: "C:\\Users\\A\\OneDrive\\bad\\x.db" }));
    expect(explicit.source).toBe("DATABASE_URL");
    expect(explicit.insideSyncedFolder).toBe(true); // explicitly chosen but unsafe -> caller warns
  });

  it("the running test DB is in memory and no database file exists inside the project tree", () => {
    const stray = walkAll(path.resolve(__dirname, "..")).filter((f) => /\.(db|db-wal|db-shm|sqlite)$/i.test(f));
    expect(stray).toEqual([]);
  });
});

function walkAll(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

describe("tenant isolation with the new fields", () => {
  it("another user can read, edit, export or re-link nothing", async () => {
    const a = (await createUser({ email: "a@example.com", name: "A", password: "a long test password 1" })).id;
    const b = (await createUser({ email: "b@example.com", name: "B", password: "a long test password 2" })).id;
    const { rows, official } = buildRealStatement();
    const p = await stageStatement(a, { name: "a.pdf", data: await generateRealHdfcPdf({ rows, official }) }, undefined);
    confirmImport(a, p.statementId);
    const id = loadAllTxns(a)[0].id;

    expect(queryTransactions(b, {}).total).toBe(0);
    expect(getTransaction(b, id)).toBeNull();
    expect(exportTransactions(b, {})).toEqual([]);
    expect(() => updateTransaction(b, id, { category: "FOOD" })).toThrow();
    expect(linkRefunds(b)).toEqual({ refunds: 0, linked: 0 });
    expect(loadAllTxns(b, "value")).toEqual([]);
    // and B's imports cannot see A's reference numbers as duplicates
    const pb = await stageStatement(b, { name: "b.pdf", data: await generateRealHdfcPdf({ rows, official }) }, undefined);
    expect(pb.counts.duplicates).toBe(0);
    expect((getDb().prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = ?").get(a) as any).n).toBe(84);
  }, 60_000);
});
