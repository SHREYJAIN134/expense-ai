/**
 * API route wrapper: authentication, CSRF origin check, rate limiting, zod
 * validation errors and safe error responses (no stack traces, no request
 * bodies - and therefore no PDF passwords - ever reach the logs).
 */
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { StatementError } from "../domain/types";
import { clientIp, rateLimit } from "./ratelimit";
import { getCurrentUser, type SessionUser } from "./session";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RouteContext<P = Record<string, string>> {
  req: NextRequest;
  user: SessionUser;
  params: P;
}

interface RouteOptions {
  /** Set false for public routes such as login. */
  auth?: boolean;
  rate?: { name: string; limit: number; windowMs: number };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth (on top of SameSite=Lax cookies): mutating requests must
 * originate from our own origin. Requests without Origin must at least declare
 * Sec-Fetch-Site same-origin/none (all modern browsers do).
 */
export function assertSameOrigin(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === host;
    } catch {
      ok = false;
    }
    if (!ok) throw new ApiError(403, "CSRF_ORIGIN", "Cross-origin request blocked.");
    return;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new ApiError(403, "CSRF_ORIGIN", "Cross-origin request blocked.");
  if (!site && process.env.NODE_ENV === "production") throw new ApiError(403, "CSRF_ORIGIN", "Missing origin information.");
}

type Handler<P> = (ctx: RouteContext<P>) => Promise<Response | object | null>;

export function route<P = Record<string, string>>(handler: Handler<P>, opts: RouteOptions = {}) {
  const requireAuth = opts.auth !== false;
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    try {
      assertSameOrigin(req);
      if (opts.rate) {
        const r = rateLimit(`${opts.rate.name}:${clientIp(req.headers)}`, opts.rate.limit, opts.rate.windowMs);
        if (!r.allowed) {
          throw new ApiError(429, "RATE_LIMITED", `Too many requests. Try again in ${r.retryAfterSec}s.`, { retryAfterSec: r.retryAfterSec });
        }
      }
      let user = null as SessionUser | null;
      if (requireAuth) {
        user = await getCurrentUser();
        if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
      }
      const params = (segment?.params ? await segment.params : {}) as P;
      const result = await handler({ req, user: user as SessionUser, params });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    const headers: Record<string, string> = {};
    if (err.status === 429 && typeof err.extra?.retryAfterSec === "number") headers["Retry-After"] = String(err.extra.retryAfterSec);
    return NextResponse.json({ error: { code: err.code, message: err.message, ...err.extra } }, { status: err.status, headers });
  }
  if (err instanceof StatementError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return NextResponse.json(
      { error: { code: "VALIDATION", message: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input." } },
      { status: 400 },
    );
  }
  // Log ONLY the error class and code. Messages are deliberately not logged: driver/parser errors can
  // embed fragments of the data being processed (narrations, amounts, SQL parameters, passwords).
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code).slice(0, 40) : "";
  console.error("[api] unexpected error:", err instanceof Error ? (err.stack || err.message) : err, "code:", code);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong on the server." } }, { status: 500 });
}

export async function readJson<T>(req: NextRequest, schema: { parse: (v: unknown) => T }): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, "BAD_JSON", "Request body must be valid JSON.");
  }
  return schema.parse(body);
}
