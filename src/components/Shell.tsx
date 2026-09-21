"use client";
import {
  Bell, CalendarDays, CornerDownLeft, FileText, Home, LogOut, MessageCircle, Moon, Plus, Search, ShieldCheck, Sun, Waves, List,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UnusualActivity } from "@/lib/analytics/anomalies";
import { api, useApi } from "@/lib/client/api";
import { initials, longDate } from "@/lib/client/format";

/** The five lenses. Everything else (Bring in, Signals, Vault, ⌘K) hangs off the spine. */
export const LENSES = [
  { href: "/now", label: "Now", icon: Home },
  { href: "/time", label: "Time", icon: Waves },
  { href: "/ledger", label: "Ledger", icon: List },
  { href: "/ahead", label: "Ahead", icon: CalendarDays },
  { href: "/ask", label: "Ask", icon: MessageCircle },
] as const;

const PAGE_TITLES: Record<string, string> = {
  "/now": "Now", "/time": "Time", "/ledger": "Ledger", "/ahead": "Ahead", "/ask": "Ask", "/bring-in": "Bring in", "/signals": "Signals", "/vault": "Vault",
};

export function BrandMark({ size = 26 }: { size?: number }) {
  const bars = [10, 18, 8, 22, 14];
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      {bars.map((h, i) => <rect key={i} x={2 + i * 5} y={26 - h} width={3} height={h} rx={1.5} fill="currentColor" />)}
      <rect x={0} y={26} width={28} height={1.5} fill="currentColor" opacity={0.35} />
    </svg>
  );
}

interface StatementLite { bank: string; status: string; periodEnd: string | null; isDemo: boolean }
const BANK_NAME: Record<string, string> = { HDFC: "HDFC", GOOGLE_PAY: "GPay" };

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export default function Shell({ user, children }: { user: { name: string; email: string }; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const menuRef = useRef<HTMLDivElement>(null);
  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const stm = useApi<{ statements: StatementLite[] }>("/api/statements");
  const unusual = useApi<{ anomalies: UnusualActivity[] }>("/api/intelligence/anomalies?days=30");
  const pip = (unusual.data?.anomalies ?? []).some((a) => a.severity !== "low");

  // freshness: newest imported period per source
  const sources = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of stm.data?.statements ?? []) {
      if (s.status !== "imported" || !s.periodEnd) continue;
      if (!m.has(s.bank) || s.periodEnd > m.get(s.bank)!) m.set(s.bank, s.periodEnd);
    }
    return [...m.entries()].map(([bank, end]) => ({ bank, end, stale: daysBetween(end, today) > 3 }));
  }, [stm.data, today]);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);
  useEffect(() => {
    const h = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  useEffect(() => {
    setMenu(false);
    setCmdOpen(false);
  }, [pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("eai-theme", next);
    } catch {
      /* private mode */
    }
  }, [theme]);
  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const title = Object.entries(PAGE_TITLES).find(([h]) => active(h))?.[1] ?? "Expense AI";

  const account = (
    <div style={{ position: "relative" }} ref={menuRef}>
      <button className="avatar" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu">
        {initials(user.name) || "U"}
      </button>
      {menu && (
        <div className="menu" role="menu">
          <div className="who">
            <b>{user.name}</b>
            <span>{user.email}</span>
          </div>
          <Link href="/vault" role="menuitem"><ShieldCheck /> Vault · sources, privacy, data</Link>
          <button role="menuitem" onClick={toggleTheme}>{theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Paper theme" : "Night theme"}</button>
          <button role="menuitem" onClick={logout}><LogOut /> Sign out</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      <header className="spine">
        <Link href="/now" className="brand" aria-label="Expense AI · Now">
          <BrandMark size={28} />
          <span className="name">Expense AI</span>
        </Link>
        <nav aria-label="Lenses">
          {LENSES.map((l) => (
            <Link key={l.href} href={l.href} className={`tab ${active(l.href) ? "on" : ""}`} aria-current={active(l.href) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <button className="cmd" onClick={() => setCmdOpen(true)} aria-label="Ask, search or jump to…">
          <Search size={16} />
          <span>Ask, search or jump to…</span>
          <span className="kbd">⌘K</span>
        </button>
        <Link href="/vault" className="row hide-md" style={{ gap: 8 }} title="Statement sources and freshness">
          {sources.map((s) => (
            <span key={s.bank} className={`fresh hide-lg ${s.stale ? "stale" : ""}`}>
              <span className="dot" />
              {BANK_NAME[s.bank] ?? s.bank} · {longDate(s.end).replace(/ \d{4}$/, "")}
            </span>
          ))}
        </Link>
        <Link href="/bring-in" className="btn solid sm"><Plus size={16} strokeWidth={2} /> Bring in</Link>
        <Link href="/signals" className="icon-btn" aria-label="Signals" title="Signals">
          <Bell />
          {pip && <i className="pip" />}
        </Link>
        {account}
      </header>

      <header className="mtop">
        <Link href="/now" className="brand" aria-label="Expense AI · Now">
          <BrandMark size={24} />
          <span className="name">{title === "Now" ? "Expense AI" : title}</span>
        </Link>
        <div className="row" style={{ gap: 6 }}>
          <button className="icon-btn" onClick={() => setCmdOpen(true)} aria-label="Search"><Search /></button>
          <Link href="/signals" className="icon-btn" aria-label="Signals">
            <Bell />
            {pip && <i className="pip" />}
          </Link>
          <Link href="/bring-in" className="icon-btn" aria-label="Bring in a statement" style={{ background: "var(--ink)", color: "var(--onink)", borderColor: "var(--ink)" }}><Plus strokeWidth={2} /></Link>
          {account}
        </div>
      </header>

      <div className="main">
        <main className="content">{children}</main>
      </div>

      <nav className="dock" aria-label="Lenses">
        {[LENSES[0], LENSES[2], LENSES[4], LENSES[3], LENSES[1]].map((l) =>
          l.label === "Ask" ? (
            <Link key={l.href} href={l.href} className={`ask ${active(l.href) ? "on" : ""}`} aria-label="Ask">
              <span className="fab"><l.icon size={24} /></span>
              <span>Ask</span>
            </Link>
          ) : (
            <Link key={l.href} href={l.href} className={active(l.href) ? "on" : ""} aria-current={active(l.href) ? "page" : undefined}>
              <l.icon strokeWidth={active(l.href) ? 2 : 1.7} />
              {l.label}
            </Link>
          ),
        )}
      </nav>

      {cmdOpen && <CommandPalette onClose={() => setCmdOpen(false)} onTheme={toggleTheme} theme={theme} />}
    </div>
  );
}

/* ---------------------------------- ⌘K ---------------------------------- */

interface Cmd { id: string; label: string; hint?: string; icon: ReactNode; run: () => void }

function CommandPalette({ onClose, onTheme, theme }: { onClose: () => void; onTheme: () => void; theme: "dark" | "light" }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const go = useCallback((href: string) => { onClose(); router.push(href); }, [onClose, router]);

  const items = useMemo<Cmd[]>(() => {
    const t = q.trim();
    const jump: Cmd[] = [
      ...LENSES.map((l) => ({ id: l.href, label: `Go to ${l.label}`, icon: <l.icon />, run: () => go(l.href) })),
      { id: "bring", label: "Bring in a statement", icon: <Plus />, run: () => go("/bring-in") },
      { id: "signals", label: "Signals", hint: "unusual activity, patterns, coming up", icon: <Bell />, run: () => go("/signals") },
      { id: "vault", label: "Vault", hint: "sources, statements, privacy, data", icon: <FileText />, run: () => go("/vault") },
      { id: "theme", label: theme === "dark" ? "Switch to paper theme" : "Switch to night theme", icon: theme === "dark" ? <Sun /> : <Moon />, run: () => { onTheme(); onClose(); } },
    ];
    if (!t) return [
      { id: "ask-1", label: "List all transactions on August 24", hint: "Ask", icon: <MessageCircle />, run: () => go(`/ask?q=${encodeURIComponent("List all transactions on August 24")}`) },
      { id: "ask-2", label: "Which day had the highest number of transactions?", hint: "Ask", icon: <MessageCircle />, run: () => go(`/ask?q=${encodeURIComponent("Which day had the highest number of transactions?")}`) },
      ...jump,
    ];
    const lower = t.toLowerCase();
    const matches = jump.filter((c) => c.label.toLowerCase().includes(lower) || (c.hint ?? "").toLowerCase().includes(lower));
    return [
      { id: "ask", label: `Ask: “${t}”`, hint: "answered from your ledger", icon: <MessageCircle />, run: () => go(`/ask?q=${encodeURIComponent(t)}`) },
      { id: "search", label: `Search the Ledger for “${t}”`, hint: "merchant, description, notes", icon: <Search />, run: () => go(`/ledger?q=${encodeURIComponent(t)}`) },
      ...matches,
    ];
  }, [q, go, onClose, onTheme, theme]);

  useEffect(() => setHi(0), [q]);
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(items.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[hi]?.run(); }
  }
  return (
    <div className="cmdk-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question, search transactions, or jump to a page…" aria-label="Command" />
        <div className="sec lab">{q.trim() ? "Do" : "Try"}</div>
        <div style={{ paddingBottom: 8 }}>
          {items.map((c, i) => (
            <button key={c.id} className={i === hi ? "hi" : ""} onMouseEnter={() => setHi(i)} onClick={c.run}>
              {c.icon}
              <span style={{ flex: 1 }}>{c.label}</span>
              {c.hint && <span className="faint" style={{ fontSize: 12 }}>{c.hint}</span>}
              {i === hi && <CornerDownLeft size={14} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
