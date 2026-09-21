/**
 * Server-side PDF text extraction with password support (pdfjs-dist).
 *
 * SECURITY: the password is passed straight to pdfjs and never logged, stored,
 * attached to an Error message, or returned. Errors are mapped to typed
 * StatementErrors with generic, password-free messages.
 */
import { StatementError } from "../domain/types";

export interface TextItem {
  str: string;
  x: number; // left edge
  y: number; // baseline, PDF coordinates (origin bottom-left)
  w: number;
  h: number;
}
export interface PdfPage {
  page: number;
  width: number;
  height: number;
  items: TextItem[];
}

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export function looksLikePdf(buf: Uint8Array): boolean {
  // %PDF- must appear within the first 1024 bytes
  const head = Buffer.from(buf.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

export async function readPdfPages(data: Uint8Array, password?: string): Promise<PdfPage[]> {
  if (data.byteLength > MAX_PDF_BYTES) throw new StatementError("FILE_TOO_LARGE", "The PDF is larger than the 15 MB limit.", 413);
  if (!looksLikePdf(data)) throw new StatementError("INVALID_PDF", "This file is not a valid PDF.");

  const pdfjs = await loadPdfJs();
  // pdfjs transfers/detaches the buffer, so hand it a copy.
  const copy = new Uint8Array(data);
  const task = pdfjs.getDocument({
    data: copy,
    password: password || undefined,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (err: any) {
    const name = String(err?.name ?? "");
    const code = err?.code;
    if (name === "PasswordException") {
      // pdfjs: 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD
      if (code === 2 || password) throw new StatementError("INCORRECT_PASSWORD", "The PDF password is incorrect.", 401);
      throw new StatementError("PASSWORD_REQUIRED", "This PDF is password protected. Enter its password.", 401);
    }
    if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException") {
      throw new StatementError("INVALID_PDF", "This file is not a readable PDF.");
    }
    throw new StatementError("PARSE_FAILED", "The PDF could not be read.");
  }

  try {
    const pages: PdfPage[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const it of content.items as any[]) {
        if (typeof it.str !== "string" || !it.str.trim()) continue;
        const t = it.transform as number[];
        items.push({ str: it.str, x: t[4], y: t[5], w: it.width ?? 0, h: it.height ?? 0 });
      }
      pages.push({ page: p, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    return pages;
  } catch {
    throw new StatementError("PARSE_FAILED", "The PDF text could not be extracted.");
  } finally {
    await Promise.resolve(task.destroy()).catch(() => undefined);
  }
}
