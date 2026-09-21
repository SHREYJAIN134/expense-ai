"use client";
/**
 * Transaction detail: a right-hand drawer on desktop, a bottom sheet on phones.
 * Shows where the payment came from (one event, one or two statement threads), how it is classified, and lets the user
 * correct it. All saving goes through the existing PATCH / match endpoints.
 */
import { Check, MessageCircle, Repeat, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { TimeLens } from "@/lib/services/timelens";
import type { TxnRow } from "@/lib/services/transactions";
import { Glyph } from "@/components/ll";
import { Alert, Badge, ErrorState, Field, Skeleton, useToast } from "@/components/ui";
import { api, ApiClientError, qs, useApi } from "@/lib/client/api";
import { catColor, categoryLabel, inr, longDate, METHOD_LABEL } from "@/lib/client/format";
import { addMonths, endOfMonth, startOfMonth } from "@/lib/util/dates";

export interface TxnOptions { merchants: string[]; categories: { name: string; color: string; subcategories: { name: string }[] }[] }
interface Detail extends TxnRow { classificationHistory: { merchant: string; category: string; subcategory: string; confidence: number; method: string; reason: string | null; is_current: number; created_at: string }[] }

const SOURCE_NAME: Record<string, string> = { HDFC: "HDFC", GOOGLE_PAY: "Google Pay" };
export const isMoved = (r: Pick<TxnRow, "category" | "direction">) => r.direction === "debit" && (r.category === "TRANSFERS" || r.category === "INVESTMENTS");

export function TransactionDrawer({ id, options, onClose, onSaved }: { id: string; options: TxnOptions | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const q = useApi<{ transaction: Detail }>(`/api/transactions/${id}`);
  const t = q.data?.transaction;
  const [category, setCategory] = useState("");
  const [sub, setSub] = useState("");
  const [merchant, setMerchant] = useState("");
  const [notes, setNotes] = useState("");
  const [similar, setSimilar] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (t) {
      setCategory(t.category);
      setSub(t.subcategory);
      setMerchant(t.merchant ?? "");
      setNotes(t.notes ?? "");
    }
  }, [t]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const subs = options?.categories.find((c) => c.name === category)?.subcategories ?? [];
  const changed = !!t && (category !== t.category || sub !== t.subcategory || merchant !== (t.merchant ?? "") || notes !== (t.notes ?? ""));
  const quick = t ? [...new Set([t.category, ...(t.classificationHistory.map((h) => h.category)), "SHOPPING", "FOOD & DINING", "GROCERIES"])].filter((c) => options?.categories.some((o) => o.name === c)).slice(0, 4) : [];

  async function save() {
    if (!t) return;
    setBusy(true);
    setErr(null);
    try {
      const catChanged = category !== t.category || sub !== t.subcategory;
      const r = await api<{ updated: number }>(`/api/transactions/${id}`, {
        method: "PATCH",
        json: {
          ...(catChanged ? { category, subcategory: sub || undefined } : {}),
          ...(merchant.trim() !== (t.merchant ?? "") ? { merchant: merchant.trim() } : {}),
          ...(notes !== (t.notes ?? "") ? { notes: notes.trim() ? notes : null } : {}),
          applyToSimilar: similar,
        },
      });
      toast(r.updated > 1 ? `Saved. Applied to ${r.updated} transactions from this merchant.` : "Saved.");
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiClientError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const name = t?.merchant || t?.description || "Transaction";
  return (
    <>
      <div className="drawer-back" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Transaction details">
        <div className="grab" />
        <div className="d-head">
          {t && <Glyph name={name} category={t.category} size={46} />}
          <div className="grow">
            <h2 className="serif" style={{ fontSize: 28, fontWeight: 500, letterSpacing: "-.02em", lineHeight: 1.05 }}>{t ? name : <Skeleton h={28} w={160} />}</h2>
            {t && <div className="faint" style={{ fontSize: 13, marginTop: 4 }}>{longDate(t.date)}{t.time ? ` · ${t.time}` : ""}{t.valueDate && t.valueDate !== t.date ? ` (value ${longDate(t.valueDate)})` : ""} · {t.paymentMethod ?? t.type}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="d-body">
          {q.error && <ErrorState error={q.error} retry={q.reload} />}
          {!t && !q.error && <div className="stack"><Skeleton h={60} /><Skeleton h={120} /><Skeleton h={160} /></div>}
          {t && (
            <div className="stack" style={{ gap: 18 }}>
              <div>
                <div className={`serif ${t.direction === "credit" ? "in" : ""}`} style={{ fontSize: 50, letterSpacing: "-.03em", lineHeight: 1 }}>{t.direction === "credit" ? "+" : "−"}{inr(t.amount)}</div>
                <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                  <span className="tag">{t.direction === "credit" ? "Credit" : "Debit"}</span>
                  <span className="tag"><i className="dot" style={{ background: catColor(t.category) }} />{categoryLabel(t.category)} › {t.subcategory}</span>
                  {isMoved(t) && <span className="tag" style={{ boxShadow: "inset 0 0 0 1.5px var(--out)", background: "none" }}>moved, not spent</span>}
                  {t.isRecurring && <span className="tag"><Repeat size={12} /> recurring</span>}
                  {t.isRefund && <span className="tag">refund</span>}
                  {t.paymentMethod === "AUTOPAY" && <span className="tag">AutoPay</span>}
                  {t.needsReview && !t.userEdited && <span className="tag hlt">needs review</span>}
                  {t.userEdited && <span className="tag">edited by you</span>}
                </div>
                {t.balanceAfter !== null && <div className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Balance after: <span className="mono">{inr(t.balanceAfter)}</span></div>}
              </div>

              {t.unusual && (
                <div className="marginnote"><span className="lab">Unusual activity</span><p style={{ marginTop: 4 }}><span className="hl">{t.unusual.reason}</span></p><div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Unusual only means different from your own pattern.</div></div>
              )}

              <Provenance id={id} t={t} onChanged={() => { q.reload(); onSaved(); }} />

              <div>
                <div className="lab">Classification</div>
                <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                  {quick.map((c) => (
                    <button key={c} className={`chip ${category === c ? "on" : ""}`} style={{ minHeight: 34 }} onClick={() => { setCategory(c); setSub(""); }}>{categoryLabel(c)}</button>
                  ))}
                  <button className={`chip ${more ? "on" : ""}`} style={{ minHeight: 34 }} onClick={() => setMore((m) => !m)}>More…</button>
                </div>
                <div className="row" style={{ gap: 10, marginTop: 10 }}>
                  <span style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--soft)", position: "relative" }}><i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(t.confidence * 100)}%`, background: "var(--ink)", borderRadius: 4 }} /></span>
                  <span className="mono" style={{ fontSize: 12 }}>{Math.round(t.confidence * 100)}% · {(METHOD_LABEL[t.source] ?? t.source).toLowerCase()}</span>
                </div>
                {(more || category !== t.category || sub !== t.subcategory) && (
                  <div className="form-grid fade-in" style={{ marginTop: 12 }}>
                    <Field label="Category">
                      <select className="select" value={category} onChange={(e) => { setCategory(e.target.value); setSub(""); }}>
                        {options?.categories.map((c) => <option key={c.name} value={c.name}>{categoryLabel(c.name)}</option>)}
                      </select>
                    </Field>
                    <Field label="Subcategory">
                      <select className="select" value={sub} onChange={(e) => setSub(e.target.value)}>
                        <option value="">{category === t.category ? t.subcategory : "—"}</option>
                        {subs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
                <div className="form-grid" style={{ marginTop: 12 }}>
                  <Field label="Merchant"><input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} maxLength={120} /></Field>
                  <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Add a note…" /></Field>
                </div>
                <label className="check" style={{ marginTop: 12, minHeight: 44, alignItems: "center" }}>
                  <input type="checkbox" checked={similar} onChange={(e) => setSimilar(e.target.checked)} />
                  <span>Apply to all payments from <b>{t.merchant ?? "this merchant"}</b> and remember for future statements</span>
                </label>
              </div>

              <CountedIn t={t} />

              <div>
                <div className="row spread"><span className="lab">Original narration (kept exactly)</span><button className="btn sm ghost" onClick={() => setShowRaw((s) => !s)}>{showRaw ? "Hide" : "Show raw"}</button></div>
                <div className="mono" style={{ fontSize: 12.5, wordBreak: "break-all", marginTop: 6, whiteSpace: "pre-wrap" }}>{showRaw ? t.rawNarration ?? t.rawDescription : t.description}</div>
                {showRaw && (
                  <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
                    {t.paymentProvider && <>Payment provider: <b>{t.paymentProvider}</b> (rails, not the merchant) · </>}
                    {t.reference && <>Ref: <span className="mono">{t.reference}</span> · </>}
                    Merchant confidence: {Math.round(t.merchantConfidence * 100)}%
                    {t.isRefund && <> · {t.refundReference ? "Linked to the original purchase" : "Refund not yet matched to a purchase"}</>}
                    {t.isRecurringCandidate && <> · Recurring candidate ({Math.round(t.recurringConfidence * 100)}%, an estimate)</>}
                  </div>
                )}
              </div>

              {t.classificationHistory.length > 0 && (
                <details>
                  <summary className="dim" style={{ cursor: "pointer", fontSize: 12.5 }}>Classification history ({t.classificationHistory.length})</summary>
                  <div className="list" style={{ marginTop: 8 }}>
                    {t.classificationHistory.map((h, i) => (
                      <div className="item" key={i}>
                        <div className="grow"><b style={{ fontSize: 13 }}>{categoryLabel(h.category)} › {h.subcategory}</b><span>{METHOD_LABEL[h.method] ?? h.method} · {Math.round(h.confidence * 100)}%{h.reason ? ` · ${h.reason}` : ""}</span></div>
                        {h.is_current ? <Badge tone="pos">current</Badge> : null}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {err && <Alert kind="error">{err}</Alert>}
              <div className="row" style={{ position: "sticky", bottom: 0, background: "var(--sheet)", padding: "12px 0 4px", borderTop: "1px solid var(--hair)" }}>
                <button className="btn solid lg" style={{ flex: 1 }} onClick={save} disabled={!changed || busy}>{busy ? "Saving…" : "Save"}</button>
                <Link className="btn lg" style={{ width: 64, padding: 0 }} href={`/ask?q=${encodeURIComponent(`Show all transactions for ${t.merchant ?? t.description}`)}`} aria-label="Ask about this merchant"><MessageCircle size={20} /></Link>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/** Where the payment came from: one event, one or two statement threads, and the decision on a possible duplicate. */
function Provenance({ id, t, onChanged }: { id: string; t: Detail; onChanged: () => void }) {
  const { toast } = useToast();
  const p = useApi<{
    members: { id: string; sourceLabel: string; isPrimary: boolean; date: string; time: string | null; amount: number; counterparty: string | null; fundingBank: string | null; fundingMask: string | null; statementFile: string | null; matchMethod: string | null; matchConfidence: number | null }[];
    potential: { id: string; source: string; date: string; amount: number; merchant: string | null; confidence: number | null } | null;
  }>(`/api/transactions/${id}/provenance`);
  const [busy, setBusy] = useState(false);
  const members = p.data?.members ?? [];
  const potential = p.data?.potential ?? null;

  async function decide(action: "merge" | "separate") {
    setBusy(true);
    try {
      await api(`/api/transactions/${id}/match`, { method: "POST", json: { action } });
      toast(action === "merge" ? "Merged into one payment" : "Kept as two separate payments");
      p.reload();
      onChanged();
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }
  const sources = t.eventSources.map((x) => SOURCE_NAME[x] ?? x);

  return (
    <div>
      <div className="lab">Where this came from</div>
      {!p.data ? <Skeleton h={54} style={{ marginTop: 8 }} /> : members.length > 1 ? (
        <>
          <div className="threadline" style={{ marginTop: 8 }}>
            <div className="threadbox"><span className="lab">{members[0].sourceLabel}</span><b>{members[0].statementFile ?? "statement"}</b><div className="faint" style={{ fontSize: 11.5 }}>{members[0].isPrimary ? "counted" : "copy"}</div></div>
            <span className="row" style={{ gap: 0 }}><i style={{ width: 14, height: 2, background: "var(--ink)" }} /><span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--ink)", color: "var(--onink)", display: "inline-grid", placeItems: "center" }}><Check size={13} strokeWidth={2.6} /></span><i style={{ width: 14, height: 2, background: "var(--ink)" }} /></span>
            <div className="threadbox"><span className="lab">{members[1].sourceLabel}</span><b>{members[1].statementFile ?? "statement"}</b><div className="faint" style={{ fontSize: 11.5 }}>{members[1].isPrimary ? "counted" : "copy"}</div></div>
          </div>
          <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
            One payment, matched{members.find((m) => !m.isPrimary)?.matchMethod === "upi_id" ? " by UPI transaction id" : members.find((m) => !m.isPrimary)?.matchMethod === "user" ? " by you" : " by similarity"}. Counted once{members.length > 2 ? ` (${members.length} statement rows)` : ""}.
          </div>
        </>
      ) : (
        <div className="faint" style={{ fontSize: 13, marginTop: 6 }}>
          From the <b>{sources[0] ?? "statement"}</b> statement{members[0]?.statementFile ? ` (${members[0].statementFile})` : ""}. Not seen in another source, so there is nothing to match.
          {t.fundingBank && <> Paid from {t.fundingBank} {t.fundingMask ? `••${t.fundingMask}` : ""}.</>}
        </div>
      )}
      {potential && (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <Alert kind="warn">This might be the same payment as a {SOURCE_NAME[potential.source] ?? potential.source} entry: {potential.merchant ?? "unknown"} · {longDate(potential.date)} · {inr(potential.amount)}. Until you decide, both are counted.</Alert>
          <div className="row wrap">
            <button className="btn sm solid" disabled={busy} onClick={() => decide("merge")}>Same payment</button>
            <button className="btn sm" disabled={busy} onClick={() => decide("separate")}>Different payments</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Which totals this row feeds, from the same analytics the rest of the app uses. */
function CountedIn({ t }: { t: Detail }) {
  const moved = isMoved(t);
  const month = { from: startOfMonth(t.date), to: endOfMonth(t.date) };
  const day = useApi<{ lens: TimeLens | null }>(!moved && t.direction === "debit" ? `/api/analytics/time${qs({ from: t.date, to: t.date, label: "day" })}` : null);
  const mon = useApi<{ lens: TimeLens | null }>(!moved && t.direction === "debit" ? `/api/analytics/time${qs({ from: month.from, to: month.to, label: "month" })}` : null);
  void addMonths;
  if (t.direction === "credit") return (
    <div><div className="lab">Counted in</div><div className="dim" style={{ fontSize: 13.5, marginTop: 6 }}>Money in · {longDate(t.date)}. {t.isRefund ? "A refund reduces the spending of the purchase it reverses." : "Credits are never counted as spending."}</div></div>
  );
  if (moved) return (
    <div><div className="lab">Counted in</div><div className="dim" style={{ fontSize: 13.5, marginTop: 6 }}>Not counted as spending — this is money moved ({categoryLabel(t.category).toLowerCase()}). It still leaves your balance.</div></div>
  );
  const catRow = mon.data?.lens?.spending.categories.find((c) => c.key === t.category);
  return (
    <div>
      <div className="lab">Counted in</div>
      <div style={{ fontSize: 14, marginTop: 4 }}>
        <Link href={`/ledger?from=${t.date}&to=${t.date}`} className="row spread" style={{ padding: "9px 0", borderTop: "1px solid var(--hair2)" }}><span className="trace">Spending · {longDate(t.date).replace(/ \d{4}$/, "")}</span><span className="mono">{day.data?.lens ? inr(day.data.lens.strip.totals.spend) : "…"}</span></Link>
        <Link href={`/ledger?category=${encodeURIComponent(t.category)}&from=${month.from}&to=${month.to}`} className="row spread" style={{ padding: "9px 0", borderTop: "1px solid var(--hair2)" }}><span className="trace">{categoryLabel(t.category)} · month</span><span className="mono">{catRow ? inr(catRow.amount) : mon.data ? "—" : "…"}</span></Link>
      </div>
    </div>
  );
}
