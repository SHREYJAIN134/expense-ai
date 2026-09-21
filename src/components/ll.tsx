"use client";
/** Ledger Line primitives shared by the lenses: trace tape, glyphs, safe-to-spend tape, page titles. */
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SafeToSpend } from "@/lib/analytics/projection";
import { catColor, inr } from "@/lib/client/format";
import { useApi } from "@/lib/client/api";
import { ErrorState } from "./ui";

export function PageTitle({ lab, title, children, sub }: { lab?: string; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {lab && <span className="lab">{lab}</span>}
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

/**
 * A number with receipts: dotted underline, click to see the formula and the rows behind it.
 * `lines` are plain strings built from values the server already computed.
 */
export function Trace({ children, title, lines, href, hrefLabel = "See the rows", className = "" }: { children: ReactNode; title: string; lines: ReactNode[]; href?: string; hrefLabel?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative", display: "inline" }}>
      <button type="button" className={`trace ${className}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`${title}: show how this number was calculated`}>
        {children}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={title}
          className="sheet"
          style={{ position: "absolute", left: 0, top: "calc(100% + 8px)", zIndex: 30, width: "min(340px, 80vw)", padding: "14px 16px", boxShadow: "var(--shadow)", borderColor: "var(--ink)", display: "block", fontFamily: "var(--font)", fontWeight: 400, fontSize: 13.5, lineHeight: 1.4, letterSpacing: 0, textAlign: "left" }}
        >
          <span className="lab" style={{ display: "block" }}>Trace · {title}</span>
          <span style={{ display: "block", marginTop: 8 }}>
            {lines.map((l, i) => (
              <span key={i} className="mono" style={{ display: "block", fontSize: 12.5, padding: "3px 0", borderTop: i ? "1px solid var(--hair2)" : undefined }}>{l}</span>
            ))}
          </span>
          {href && (
            <Link href={href} className="row" style={{ gap: 4, marginTop: 10, fontWeight: 600, fontSize: 13 }}>
              {hrefLabel} <ChevronRight size={14} />
            </Link>
          )}
        </span>
      )}
    </span>
  );
}

/** Two-letter merchant mark in the category colour. */
export function Glyph({ name, category, size = 34 }: { name: string; category: string; size?: number }) {
  const c = catColor(category);
  const letters = (name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  return (
    <span className="glyph" style={{ width: size, height: size, background: `color-mix(in srgb, ${c} 20%, var(--sheet))`, color: "var(--ink)", border: `1.5px solid color-mix(in srgb, ${c} 70%, var(--ink))`, fontSize: size * 0.34 }} aria-hidden>
      {letters}
    </span>
  );
}

/** One event seen by more than one source: two linked threads. */
export function Twin({ title }: { title?: string }) {
  return (
    <span className="twin" title={title ?? "One payment, seen in two statements — counted once"} aria-label={title ?? "Seen in two statements, counted once"}>
      <i />
      <i />
    </span>
  );
}

export function EstTag({ children = "est" }: { children?: ReactNode }) {
  return <span className="estt">{children}</span>;
}

/** Hatched, dashed figure: an estimate the user must never mistake for an actual. */
export function EstFigure({ children, size = 44 }: { children: ReactNode; size?: number }) {
  return (
    <span className="serif est" style={{ fontSize: size, lineHeight: 1.05, letterSpacing: "-.02em", padding: "0 8px", display: "inline-block" }}>
      {children}
    </span>
  );
}

const HATCH = "repeating-linear-gradient(135deg, var(--ink3) 0 1.3px, transparent 1.3px 5px)";

/** Safe to spend, built from the server's own components: balance − bills − budgets − buffer. */
export function SafeToSpendBlock({ size = 44, compact }: { size?: number; compact?: boolean }) {
  const q = useApi<SafeToSpend>("/api/intelligence/safe-to-spend");
  const s = q.data;
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!s) return <div className="skeleton" style={{ height: 96 }} />;
  if (s.amount === null)
    return (
      <div>
        <div className="row" style={{ gap: 8 }}><span className="lab">Safe to spend</span><EstTag /></div>
        <p className="dim" style={{ marginTop: 8 }}>Your statements don’t include a running balance, so this can’t be estimated.</p>
      </div>
    );
  const bal = s.components.find((c) => c.key === "balance");
  const parts = s.components.filter((c) => c.key !== "balance" && c.amount > 0);
  const total = (bal?.amount ?? 0) || 1;
  const formula = [bal ? inr(bal.amount) : "", ...parts.map((c) => `− ${inr(c.amount)} ${c.key === "recurring" ? "bills" : c.key}`)].filter(Boolean).join(" ");
  return (
    <div>
      <div className="row" style={{ gap: 8 }}><span className="lab">Safe to spend</span><EstTag /></div>
      <div style={{ marginTop: 8 }}><EstFigure size={size}>≈ {inr(Math.round(s.amount / 100) * 100)}</EstFigure></div>
      <div className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>through {new Date(s.to + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })} · an estimate, not a guarantee</div>
      {!compact && (
        <>
          <div className="tape" style={{ marginTop: 12 }} aria-hidden>
            {parts.map((c) => <i key={c.key} className="hatch" style={{ flex: Math.max(0.5, (c.amount / total) * 100) }} />)}
            <i className="result" style={{ flex: Math.max(4, ((s.amount ?? 0) / total) * 100) }} />
          </div>
          <div className="mono" style={{ fontSize: 11.5, marginTop: 8, color: "var(--ink2)", lineHeight: 1.5 }}>
            <Trace title="Safe to spend" lines={[...s.components.map((c) => `${c.sign === -1 ? "−" : "+"} ${inr(c.amount)}  ${c.label}`), `= ${inr(s.amount)}`, s.disclaimer]} href="/ahead">
              {formula}
            </Trace>
          </div>
        </>
      )}
      {compact && <div className="tape" style={{ marginTop: 8 }} aria-hidden>{parts.map((c) => <i key={c.key} className="hatch" style={{ flex: Math.max(0.5, (c.amount / total) * 100), backgroundImage: HATCH }} />)}<i className="result" style={{ flex: Math.max(4, ((s.amount ?? 0) / total) * 100) }} /></div>}
    </div>
  );
}

/** Budget bar: solid = spent so far (actual), hatched = where the current pace is heading (estimate), tick = how far through the period we are. */
export function BudgetBar({ actualPct, projectedPct, over, markPct }: { actualPct: number; projectedPct: number; over?: boolean; markPct?: number }) {
  const a = Math.min(100, Math.max(0, actualPct));
  const p = Math.min(100, Math.max(a, projectedPct));
  return (
    <div style={{ position: "relative", height: 10, borderRadius: 5, background: "var(--soft)" }} role="progressbar" aria-valuenow={Math.round(actualPct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${Math.round(actualPct)}% of budget spent, heading for ${Math.round(projectedPct)}% (estimate)`}>
      {p > a && <i style={{ position: "absolute", left: `${a}%`, width: `${p - a}%`, top: 0, bottom: 0, borderRadius: "0 5px 5px 0", border: "1px dashed var(--est)", backgroundImage: "repeating-linear-gradient(135deg, var(--est) 0 1.3px, transparent 1.3px 5px)" }} />}
      <i style={{ position: "absolute", left: 0, width: `${a}%`, top: 0, bottom: 0, borderRadius: 5, background: over ? "var(--out)" : "var(--ink)" }} />
      {markPct !== undefined && <i style={{ position: "absolute", left: `${Math.min(100, markPct)}%`, top: -3, bottom: -3, width: 2, background: "var(--ink)", opacity: 0.55 }} />}
    </div>
  );
}
