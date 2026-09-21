"use client";
import { ArrowUp, ChevronRight, Plus, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TxnRow } from "@/lib/services/transactions";
import { Glyph, Twin } from "@/components/ll";
import { isMoved, TransactionDrawer, type TxnOptions } from "@/components/txn-drawer";
import { Alert, Skeleton } from "@/components/ui";
import { api, ApiClientError, qs, useApi } from "@/lib/client/api";
import { categoryLabel, inr, longDate } from "@/lib/client/format";

interface Understood {
  intent: string;
  category?: string;
  merchant?: string;
  period: string | null;
  from: string | null;
  to: string | null;
  direction: "debit" | "credit" | null;
  focusDates: string[];
  followUp: boolean;
}
interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  intent?: string | null;
  table?: { columns: string[]; rows: (string | number)[][] };
  calculation?: string[];
  suggestions?: string[];
  usedLlm?: boolean;
  understood?: Understood;
}
interface Session { id: string; title: string; updated_at: string }

const STARTERS = [
  "How much did I spend this month?",
  "List all transactions on August 24.",
  "Which day had the highest number of transactions?",
  "Which day did I spend the most?",
  "What was my largest transaction?",
  "Compare this month with last month",
  "Why did my spending increase this month?",
  "What are my recurring expenses?",
  "What payments are coming up in the next 30 days?",
  "How much can I safely spend this month?",
  "Show me unusual spending recently",
  "Where is most of my money going?",
];

const INTENT_LABEL: Record<string, string> = {
  spend_category: "Spending by category", spend_merchant: "Spending at a merchant", spend_total: "Total spending", income_total: "Money in", biggest_expense: "Biggest expense",
  recurring_list: "Recurring payments", upcoming_payments: "Coming up", monthly_average: "Monthly average", safe_to_spend: "Safe to spend", afford: "Can I afford it",
  remaining_after_bills: "Left after bills", cash_requirement: "Cash needed", compare_periods: "Comparison", spending_trend: "Trend", top_categories: "Top categories",
  anomalies: "Unusual activity", balance: "Balance", historical_balance: "Balance on a day", transaction_list: "Transactions", busiest_day: "Busiest day",
  top_spending_day: "Priciest day", top_income_day: "Most money in", top_value_day: "Highest value day", largest_transaction: "Largest transaction", top_merchants: "Top merchants",
  top_spending_period: "Top period", why_spending_changed: "Why it changed", categories_changed: "What changed", unknown: "Not understood",
};

/** Intents whose answer is backed by ledger rows the user can look at. */
const ROW_BACKED = new Set(["transaction_list", "spend_total", "spend_category", "spend_merchant", "income_total", "biggest_expense", "busiest_day", "top_spending_day", "top_income_day", "top_value_day", "largest_transaction"]);

/** Renders **bold** and line breaks without ever using innerHTML. */
function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  text.split("\n").forEach((line, li) => {
    if (li) parts.push(<br key={`br${li}`} />);
    line.split(/(\*\*[^*]+\*\*)/g).forEach((seg, i) => {
      if (/^\*\*[^*]+\*\*$/.test(seg)) parts.push(<strong key={`${li}-${i}`}>{seg.slice(2, -2)}</strong>);
      else if (seg) parts.push(<span key={`${li}-${i}`}>{seg}</span>);
    });
  });
  return <>{parts}</>;
}

const money = (v: string | number): number | null => {
  if (typeof v === "number") return null;
  const m = /^[-+]?₹\s?([\d,]+(?:\.\d+)?)$/.exec(v.trim());
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

/** The deterministic table, with an inline bar under the first all-rupee column so rankings read as a chart. */
function AnswerTable({ table, chart }: { table: NonNullable<Msg["table"]>; chart: boolean }) {
  const col = chart && table.rows.length > 1 ? table.columns.findIndex((_, j) => table.rows.every((r) => money(r[j]) !== null)) : -1;
  const vals = col >= 0 ? table.rows.map((r) => money(r[col]) ?? 0) : [];
  const max = Math.max(1, ...vals);
  return (
    <div className="tbl" style={{ marginTop: 12 }}>
      <table>
        <thead><tr>{table.columns.map((c, j) => <th key={c} style={j === col ? { width: "34%" } : undefined}>{c}</th>)}</tr></thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={j === col ? "mono" : undefined}>
                  {c}
                  {j === col && <div style={{ height: 4, borderRadius: 2, background: "var(--soft)", marginTop: 4 }}><i style={{ display: "block", height: 4, borderRadius: 2, width: `${(vals[i] / max) * 100}%`, background: "var(--ink)" }} /></div>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The ledger rows behind an answer, read from the same canonical events as the Ledger lens. */
function Supporting({ u, onOpen }: { u: Understood; onOpen: (id: string) => void }) {
  const from = u.from ?? u.focusDates[0] ?? "";
  const to = u.to ?? u.focusDates[u.focusDates.length - 1] ?? "";
  const single = u.focusDates.length === 1 ? u.focusDates[0] : null;
  const q = qs({ from: single ?? from, to: single ?? to, category: u.category, merchant: u.merchant, direction: u.direction, sort: "date", dir: "asc", pageSize: 12 });
  const r = useApi<{ rows: TxnRow[]; total: number }>(`/api/transactions${q}`);
  if (!r.data) return <div className="stack" style={{ marginTop: 10 }}><Skeleton h={38} /><Skeleton h={38} /></div>;
  if (r.data.rows.length === 0) return <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>No matching transactions in the ledger.</p>;
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--hair)" }}>
      {r.data.rows.map((t) => (
        <button key={t.id} className="row spread" onClick={() => onOpen(t.id)} style={{ width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--hair2)", padding: "9px 2px", cursor: "pointer", textAlign: "left", gap: 10 }}>
          <span className="row" style={{ gap: 10, minWidth: 0 }}>
            <Glyph name={t.merchant || t.description} category={t.category} size={28} />
            <span style={{ minWidth: 0 }}>
              <b style={{ fontWeight: 600 }}>{t.merchant || t.description}</b>
              <span className="faint" style={{ fontSize: 12, display: "block" }}>{longDate(t.date)}{t.time ? ` · ${t.time}` : ""} · {categoryLabel(t.category)} {t.eventSources.length > 1 && <Twin />}</span>
            </span>
          </span>
          <span className={`mono ${t.direction === "credit" ? "in" : ""}`} style={isMoved(t) ? { border: "1.5px solid var(--out)", borderRadius: 6, padding: "1px 6px", color: "var(--out)" } : undefined}>{t.direction === "credit" ? "+" : "−"}{inr(t.amount)}</span>
        </button>
      ))}
      {r.data.total > r.data.rows.length && <div className="faint" style={{ fontSize: 12.5, padding: "8px 2px" }}>Showing {r.data.rows.length} of {r.data.total}.</div>}
    </div>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={<Skeleton h={300} />}>
      <Ask />
    </Suspense>
  );
}

function Ask() {
  const sp = useSearchParams();
  const initial = sp.get("q");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openTxn, setOpenTxn] = useState<string | null>(null);
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<Record<string, boolean>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const sent = useRef<string | null>(null);
  const opts = useApi<TxnOptions>("/api/transactions/options");

  const loadSessions = useCallback(() => api<{ sessions: Session[] }>("/api/chat/sessions").then((r) => setSessions(r.sessions)).catch(() => undefined), []);
  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [messages, busy]);

  async function open(id: string) {
    setError(null);
    try {
      const s = await api<{ id: string; messages: Msg[] }>(`/api/chat/sessions/${id}`);
      setSessionId(id);
      setMessages(s.messages);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not load the chat.");
    }
  }
  function fresh() { setSessionId(null); setMessages([]); setError(null); }
  async function remove(id: string) {
    await api(`/api/chat/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
    if (id === sessionId) fresh();
    loadSessions();
  }

  const send = useCallback(async (text: string, sid: string | null) => {
    const q = text.trim();
    if (!q) return;
    setInput("");
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { id: `u${Date.now()}`, role: "user", content: q }]);
    try {
      const r = await api<{ sessionId: string; message: Msg; understood: Understood }>("/api/chat", { method: "POST", json: { message: q, sessionId: sid } });
      setSessionId(r.sessionId);
      setMessages((m) => [...m, { ...r.message, understood: r.understood }]);
      loadSessions();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [loadSessions]);

  // A question handed over from ⌘K, Time or a transaction: ask it once.
  useEffect(() => {
    if (initial && sent.current !== initial) {
      sent.current = initial;
      void send(initial, null);
    }
  }, [initial, send]);

  const ask = (t: string) => { if (!busy) void send(t, sessionId); };

  return (
    <div className="fade-in">
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <span className="lab">Lens</span>
          <h1>Ask</h1>
          <p>Plain English in, numbers out. Every figure is calculated from your stored transactions; the assistant cannot invent one.</p>
        </div>
      </div>
      <div className="chat">
        <div className="chat-side">
          <button className="btn solid" onClick={fresh}><Plus /> New question</button>
          <div className="lab" style={{ margin: "12px 4px 2px" }}>History</div>
          {sessions.length === 0 && <div className="faint" style={{ fontSize: 12.5, padding: 6 }}>Nothing asked yet.</div>}
          {sessions.map((s) => (
            <div key={s.id} className={`s ${s.id === sessionId ? "on" : ""}`} onClick={() => open(s.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(s.id)}>
              <span title={s.title}>{s.title}</span>
              <button className="icon-btn" style={{ width: 28, height: 28, border: "none", background: "none" }} onClick={(e) => { e.stopPropagation(); remove(s.id); }} aria-label="Delete conversation"><Trash2 /></button>
            </div>
          ))}
        </div>

        <div className="sheet chat-main">
          <div className="chat-scroll" ref={scroller} aria-live="polite">
            {messages.length === 0 && !busy && (
              <div style={{ margin: "auto", maxWidth: 680, textAlign: "center" }}>
                <h2 className="serif" style={{ fontSize: 34, fontWeight: 500, letterSpacing: "-.02em" }}>What would you like to know?</h2>
                <p className="dim" style={{ marginTop: 8 }}>I look up your actual transactions, calculate the result, and show my working. Forecasts are always labelled as estimates.</p>
                <div className="chips" style={{ justifyContent: "center", marginTop: 18 }}>
                  {STARTERS.map((s) => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}
                </div>
                <div className="faint row" style={{ gap: 6, fontSize: 12, justifyContent: "center", marginTop: 16 }}><ShieldCheck size={13} /> Raw statements, UPI ids and account numbers are never sent to an AI provider.</div>
              </div>
            )}
            {messages.map((m) => {
              const u = m.understood;
              const intent = m.intent ?? u?.intent ?? null;
              const label = intent ? INTENT_LABEL[intent] ?? intent.replace(/_/g, " ") : null;
              const [first, ...rest] = m.content.split("\n");
              const backed = !!intent && ROW_BACKED.has(intent) && !!u && (!!u.from || u.focusDates.length > 0);
              const openRows = rows[m.id] ?? false;
              return m.role === "user" ? (
                <div key={m.id} className="msg user fade-in">{m.content}</div>
              ) : (
                <div key={m.id} className="msg ai fade-in">
                  {label && (
                    <div className="readas" style={{ marginBottom: 10 }}>
                      <span className="lab" style={{ marginRight: 2 }}>Read as</span>
                      <span className="chip on static" style={{ height: 28 }}>{label}</span>
                      {u?.period && <span className="chip on static" style={{ height: 28 }}>{u.period}</span>}
                      {u?.category && <span className="chip on static" style={{ height: 28 }}>{categoryLabel(u.category)}</span>}
                      {u?.merchant && <span className="chip on static" style={{ height: 28 }}>{u.merchant}</span>}
                      {u?.direction && <span className="chip static" style={{ height: 28 }}>{u.direction === "debit" ? "money out" : "money in"}</span>}
                      {u?.followUp && <span className="chip static" style={{ height: 28 }}>follow-up</span>}
                    </div>
                  )}
                  <div className="lab">Answer{m.table ? " · table" : ""}</div>
                  <p className="serif" style={{ fontSize: 23, lineHeight: 1.25, letterSpacing: "-.015em", marginTop: 6, whiteSpace: "pre-wrap" }}><RichText text={first} /></p>
                  {rest.some((l) => l.trim()) && <div style={{ marginTop: 8, fontSize: 14.5 }}><RichText text={rest.join("\n")} /></div>}
                  {m.table && m.table.rows.length > 0 && <AnswerTable table={m.table} chart={intent !== "transaction_list"} />}
                  {backed && openRows && u && <Supporting u={u} onOpen={setOpenTxn} />}
                  <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
                    {backed && u && <Link className="btn sm" href={`/ledger${qs({ from: u.focusDates.length === 1 ? u.focusDates[0] : u.from, to: u.focusDates.length === 1 ? u.focusDates[0] : u.to, category: u.category, merchant: u.merchant, direction: u.direction })}`}>Open in Ledger</Link>}
                    {backed && <button className="btn sm ghost" onClick={() => setRows((r) => ({ ...r, [m.id]: !openRows }))}>{openRows ? "Hide" : "Show"} supporting transactions</button>}
                    {m.calculation && m.calculation.length > 0 && <button className="btn sm ghost" onClick={() => setWorking((w) => ({ ...w, [m.id]: !w[m.id] }))} aria-expanded={!!working[m.id]}>{working[m.id] ? "Hide" : "Show"} working</button>}
                  </div>
                  {working[m.id] && m.calculation && (
                    <ul className="dim" style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{m.calculation.map((c, i) => <li key={i}>{c}</li>)}</ul>
                  )}
                  <div className="meta">
                    <span>{m.usedLlm ? "Worded by AI from numbers we calculated" : "Calculated from your data"}</span>
                  </div>
                  {m.suggestions && m.suggestions.length > 0 && (
                    <div className="chips" style={{ marginTop: 10 }}>{m.suggestions.map((s) => <button key={s} className="chip" onClick={() => ask(s)}>{s} <ChevronRight size={12} /></button>)}</div>
                  )}
                </div>
              );
            })}
            {busy && <div className="msg ai"><span className="typing"><i /><i /><i /></span></div>}
          </div>
          {error && <div style={{ padding: "0 18px 10px" }}><Alert kind="error" onClose={() => setError(null)}>{error}</Alert></div>}
          <form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
            <input className="input" style={{ borderRadius: 999, height: 46, padding: "0 18px" }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about your money…" maxLength={1000} aria-label="Your question" disabled={busy} autoFocus />
            <button className="btn solid" style={{ width: 46, height: 46, padding: 0 }} type="submit" disabled={busy || !input.trim()} aria-label="Send"><ArrowUp /></button>
          </form>
        </div>
      </div>
      {openTxn && <TransactionDrawer id={openTxn} options={opts.data} onClose={() => setOpenTxn(null)} onSaved={() => undefined} />}
    </div>
  );
}
