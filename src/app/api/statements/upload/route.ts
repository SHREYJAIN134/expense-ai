import { ApiError, route } from "@/lib/auth/guard";
import { MAX_PDF_BYTES } from "@/lib/parsers/pdf-reader";
import { stageStatement } from "@/lib/pipeline/import";
import { StatementError } from "@/lib/domain/types";

export const maxDuration = 60;

/**
 * Step 1-5 of the import: receive PDF (+ password), decrypt, parse, validate, dedupe, classify.
 * Responds with newline-delimited JSON so the UI can show live progress:
 *   {"type":"progress","stage":"parse",...}  ...  {"type":"preview","preview":{...}}  | {"type":"error",...}
 * Nothing is written to the transactions table until POST /api/statements/process.
 * SECURITY: the password is read from the form, handed to the PDF reader, and dropped.
 */
export const POST = route(
  async ({ req, user }) => {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_PDF_BYTES + 512 * 1024) throw new ApiError(413, "FILE_TOO_LARGE", "The file is larger than the 15 MB limit.");
    if (!/^multipart\/form-data/i.test(req.headers.get("content-type") ?? "")) throw new ApiError(400, "BAD_REQUEST", "Expected a multipart form upload.");

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ApiError(400, "BAD_REQUEST", "Could not read the upload.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "INVALID_FILE", "Choose a PDF statement to upload.");
    if (file.size === 0) throw new ApiError(400, "INVALID_FILE", "The file is empty.");
    if (file.size > MAX_PDF_BYTES) throw new ApiError(413, "FILE_TOO_LARGE", "The file is larger than the 15 MB limit.");
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") throw new ApiError(415, "INVALID_FILE", "Only PDF files are supported.");
    let password = typeof form.get("password") === "string" ? (form.get("password") as string) : undefined;
    if (password && password.length > 256) throw new ApiError(400, "BAD_REQUEST", "Password is too long.");
    const data = new Uint8Array(await file.arrayBuffer());
    const name = file.name;

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        try {
          const pw = password;
          password = undefined; // do not keep a second reference around
          const preview = await stageStatement(user.id, { name, data }, pw || undefined, (stage, detail) => send({ type: "progress", stage, detail }));
          send({ type: "preview", preview });
        } catch (err) {
          if (err instanceof StatementError || err instanceof ApiError) {
            send({ type: "error", error: { code: err.name === "ApiError" ? (err as ApiError).code : (err as StatementError).code, message: err.message } });
          } else {
            console.error("[upload] unexpected error:", err instanceof Error ? err.name : "unknown"); // never log message: may echo content
            send({ type: "error", error: { code: "PARSE_FAILED", message: "The statement could not be processed." } });
          }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  },
  { rate: { name: "upload", limit: 30, windowMs: 60 * 60_000 } },
);
