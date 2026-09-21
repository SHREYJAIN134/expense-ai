/**
 * Writes synthetic sample statements into ./samples so you can try the upload flow
 * before using a real statement:
 *   npm run sample:pdf
 * Password for the protected sample is printed to the console.
 */
import fs from "node:fs";
import path from "node:path";
import { generateSyntheticTransactions } from "../src/lib/demo/synthetic";
import { generateSamplePdf } from "./sample-pdf";
import { generateRealHdfcPdf } from "./real-pdf";
import { buildRealStatement } from "../tests/real-fixture";

async function main() {
  const dir = path.resolve(process.cwd(), "samples");
  fs.mkdirSync(dir, { recursive: true });
  const opening = 60000;
  const txns = generateSyntheticTransactions({ start: "2026-05-01", end: "2026-05-31", seed: 7, openingBalance: opening });
  const plain = await generateSamplePdf({
    transactions: txns,
    openingBalance: opening,
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
  });
  fs.writeFileSync(path.join(dir, "synthetic-hdfc-may-2026.pdf"), plain);

  const password = "demo1234";
  const june = generateSyntheticTransactions({ start: "2026-06-01", end: "2026-06-30", seed: 8, openingBalance: txns.at(-1)!.balance });
  const protectedPdf = await generateSamplePdf({
    transactions: june,
    openingBalance: txns.at(-1)!.balance,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    password,
  });
  fs.writeFileSync(path.join(dir, "synthetic-hdfc-june-2026-protected.pdf"), protectedPdf);
  // Real-STRUCTURE sample: 8+ pages, repeated headers/footers, wrapped UPI narrations, value dates, summary.
  const real = buildRealStatement();
  fs.writeFileSync(path.join(dir, "synthetic-hdfc-real-structure-aug-2026.pdf"), await generateRealHdfcPdf(real));
  fs.writeFileSync(path.join(dir, "synthetic-hdfc-real-structure-aug-2026-protected.pdf"), await generateRealHdfcPdf({ ...real, password }));
  console.log("Wrote samples/synthetic-hdfc-real-structure-aug-2026.pdf and ...-protected.pdf (84 transactions; opening 29,004.97 -> closing 22,493.21)");
  console.log(`Wrote samples/synthetic-hdfc-may-2026.pdf (no password)`);
  console.log(`Wrote samples/synthetic-hdfc-june-2026-protected.pdf (password: ${password})`);
}

main();
