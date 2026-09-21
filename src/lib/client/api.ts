"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function parseError(res: Response): Promise<ApiClientError> {
  let code = "ERROR";
  let message = `Request failed (${res.status})`;
  try {
    const j = await res.json();
    if (j?.error) {
      code = j.error.code ?? code;
      message = j.error.message ?? message;
    }
  } catch {
    /* non-JSON error */
  }
  return new ApiClientError(res.status, code, message);
}

/** JSON fetch helper. Redirects to /login when the session has expired. */
export async function api<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      credentials: "same-origin",
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiClientError(0, "NETWORK", "Network error. Check your connection and try again.");
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
      window.location.replace("/login");
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface UseApi<T> {
  data: T | null;
  error: ApiClientError | null;
  loading: boolean;
  reload: () => void;
}

/** Tiny data-fetching hook: refetches when `url` changes, ignores stale responses. */
export function useApi<T>(url: string | null): UseApi<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    api<T>(url)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setError(e instanceof ApiClientError ? e : new ApiClientError(0, "ERROR", "Something went wrong."));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [url, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "" && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
