import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Content-Security-Policy. Next.js injects small inline bootstrap scripts, so
// 'unsafe-inline' is required for script-src unless nonces are wired through
// the proxy. Everything else is locked to same-origin. No third-party origins.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Native / server-only packages must not be bundled.
  serverExternalPackages: ["better-sqlite3", "pdfjs-dist", "pdfkit", "bcryptjs"],
  // pdfjs loads its worker with a runtime import that file tracing cannot see. Without this the
  // worker is missing from the serverless bundle and every upload fails with "The PDF could not be read".
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  // Old page URLs keep working after the move to the Ledger Line lenses (query strings are preserved).
  async redirects() {
    const r = (source: string, destination: string) => ({ source, destination, permanent: false });
    return [
      r("/dashboard", "/now"),
      r("/analytics", "/time"),
      r("/transactions", "/ledger"),
      r("/assistant", "/ask"),
      r("/upload", "/bring-in"),
      r("/insights", "/signals"),
      r("/recurring", "/ahead"),
      r("/budgets", "/ahead"),
      r("/statements", "/vault"),
      r("/settings", "/vault"),
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        // Financial API responses must never be cached by browsers or proxies.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
