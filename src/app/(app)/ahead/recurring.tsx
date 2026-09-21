"use client";
import { Check, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { Forecast, UpcomingItem } from "@/lib/analytics/planning";
import type { RecurringSeries } from "@/lib/analytics/recurring";
import { monthlyEquivalent } from "@/lib/analytics/recurring";
import { RecurringBars, UpcomingTimeline } from "@/components/charts/basic";
import { Alert, Badge, Card, CardSkeleton, Empty, ErrorState, Estimate, Field, Seg, useToast } from "@/components/ui";
import { api, ApiClientError, useApi } from "@/lib/client/api";
import { catColor, categoryLabel, inr, inrCompact, longDate, shortDate } from "@/lib/client/format";
import { CATEGORY_NAMES } from "@/lib/domain/categories";

type Detected = RecurringSeries & { merchantKey: string; dismissed: boolean; tracked: boolean };
interface Manual { id: string; name: string; amount: number; frequency: string; dueDay: number | null; category: string; kind: string }
interface RecurringRes { manual: Manual[]; detected: Detected[]; estimatedMonthlyTotal: number }

const FREQS = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
const ord = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

export function RecurringSection() {
  const r = useApi<RecurringRes>("/api/recurring");
  const [days, setDays] = useState("30");
  const up = useApi<{ asOf: string; items: UpcomingItem[]; total: number }>(`/api/upcoming?days=${days}`);
  const { toast } = useToast();

  async function act(action: "track" | "dismiss" | "restore", d: Detected) {
    await api("/api/recurring/detected", { method: "POST", json: { action, merchant: d.merchant, amount: d.averageAmount, frequency: d.frequency, category: d.category, dueDay: Number(d.lastDate.slice(8, 10)) } });
    toast(action === "track" ? `Tracking ${d.merchant} as a fixed obligation` : action === "dismiss" ? `Ignoring ${d.merchant}` : "Restored");
    r.reload(); up.reload();
  }
  async function del(id: string) {
    await api(`/api/recurring/${id}`, { method: "DELETE" });
    r.reload(); up.reload();
  }

  const d = r.data;
  const active = d?.detected.filter((x) => !x.dismissed && !x.possiblyEnded && x.kind === "expense") ?? [];
  const income = d?.detected.filter((x) => x.kind === "income" && !x.possiblyEnded) ?? [];
  const ended = d?.detected.filter((x) => x.possiblyEnded) ?? [];
  const dismissed = d?.detected.filter((x) => x.dismissed) ?? [];

  return (
    <div className="stack" style={{ gap: 18 }}>
      {r.error ? <ErrorState error={r.error} retry={r.reload} /> : !d ? <CardSkeleton h={300} /> : (
        <>
          <div className="grid g3">
            <Card className="span-2" title="Upcoming payments" sub="Expected from patterns and your entries" right={<div className="row"><Estimate /><Seg label="Horizon" value={days} options={[{ value: "14", label: "14d" }, { value: "30", label: "30d" }, { value: "60", label: "60d" }, { value: "90", label: "90d" }]} onChange={setDays} /></div>}>
              {!up.data ? <CardSkeleton h={140} /> : (
                <>
                  {up.data.items.some((i) => i.kind === "expense") ? (
                    <>
                      <UpcomingTimeline from={up.data.asOf} days={Math.min(Number(days), 60)} items={up.data.items.filter((i) => i.kind === "expense").map((i) => ({ date: i.date, amount: i.amount, name: i.name }))} />
                      <div className="row spread" style={{ margin: "14px 0 8px" }}>
                        <span className="dim">{up.data.items.filter((i) => i.kind === "expense").length} expected payments</span>
                        <b className="num">≈ {inr(up.data.items.filter((i) => i.kind === "expense").reduce((a, i) => a + i.amount, 0))}</b>
                      </div>
                      <div className="list">
                        {up.data.items.filter((i) => i.kind === "expense").slice(0, 12).map((i) => (
                          <div className="item" key={i.id}>
                            <div className="chip-icon" style={{ background: `${catColor(i.category)}22`, color: catColor(i.category) }}>{shortDate(i.date).split(" ")[0]}</div>
                            <div className="grow"><b>{i.name}</b><span>{longDate(i.date)} · {i.source === "manual" ? "you entered this" : i.basis}{i.overdue ? " · may be late" : ""}</span></div>
                            <Badge tone={i.confidence === "High" || i.confidence === "Manual" ? "pos" : i.confidence === "Medium" ? "warn" : undefined}>{i.confidence}</Badge>
                            <b className="num" style={{ width: 92, textAlign: "right" }}>{inr(i.amount)}</b>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : <Empty title="Nothing expected in this window">Add obligations below or upload more history.</Empty>}
                </>
              )}
            </Card>
            <Card title="Monthly commitments" sub="Monthly-equivalent cost of recurring payments" right={<Estimate />}>
              <div style={{ fontSize: 30, fontWeight: 700 }} className="num">{inr(d.estimatedMonthlyTotal)}</div>
              <RecurringBars rows={[...active.slice(0, 8).map((x) => ({ name: x.merchant, monthly: monthlyEquivalent(x), category: x.category })), ...d.manual.filter((m) => m.kind === "expense").map((m) => ({ name: m.name, monthly: monthlyEquivalent({ frequency: m.frequency as never, averageAmount: m.amount }), category: m.category }))].sort((a, b) => b.monthly - a.monthly).slice(0, 10)} height={220} />
            </Card>
          </div>

          <ForecastCard />

          <div className="grid g-7-5">
            <Card flush title="Detected from your history" sub="Pin one to treat it as a fixed obligation, or ignore false positives" right={<Estimate />}>
              {!active.length ? <Empty title="Nothing detected yet">A payment needs about 3 similar occurrences, roughly evenly spaced.</Empty> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Payment</th><th className="n">Expected amount</th><th>Frequency</th><th className="hide-sm">Last / next expected</th><th>Confidence</th><th /></tr></thead>
                    <tbody>
                      {active.map((s) => (
                        <tr key={s.key}>
                          <td className="desc"><b className="row" style={{ gap: 8 }}><span className="dot" style={{ background: catColor(s.category) }} />{s.merchant}</b><span>{categoryLabel(s.category)} · {s.subcategory}{s.tracked ? " · tracked" : ""}</span></td>
                          <td className="n">{inr(s.expectedAmount)}<div className="faint" style={{ fontSize: 11 }}><Badge tone={s.type === "AUTOPAY" ? "info" : undefined} title={s.type === "AUTOPAY" ? "The bank narration says this is an AutoPay / mandate payment" : s.type === "FIXED" ? "About the same amount every time" : "The amount changes from payment to payment"}>{s.type === "AUTOPAY" ? "AutoPay" : s.type === "FIXED" ? "Fixed" : "Variable"}</Badge>{s.type !== "FIXED" && s.amountVariability > 0.05 ? ` ±${Math.round(s.amountVariability * 100)}%` : ""}{s.amountChangedFrom !== null ? ` · was ${inrCompact(s.amountChangedFrom)}` : ""}</div></td>
                          <td>{s.frequency}<div className="faint" style={{ fontSize: 11 }}>{s.occurrences} payments</div></td>
                          <td className="hide-sm" style={{ whiteSpace: "nowrap" }}>{shortDate(s.lastDate)} → ~{shortDate(s.nextExpected)}{s.overdue && <Badge tone="warn"> may be late</Badge>}</td>
                          <td><Badge tone={s.confidenceLabel === "High" ? "pos" : s.confidenceLabel === "Medium" ? "warn" : undefined}>{s.confidenceLabel}</Badge></td>
                          <td className="right" style={{ whiteSpace: "nowrap" }}>
                            {!s.tracked && <button className="btn sm" onClick={() => act("track", s)} title="Track as a fixed obligation"><Check /> Track</button>}{" "}
                            <button className="btn sm ghost" onClick={() => act("dismiss", s)} title="Not recurring - ignore"><X /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(income.length > 0 || ended.length > 0 || dismissed.length > 0) && (
                <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)" }} className="stack">
                  {income.length > 0 && <div className="dim" style={{ fontSize: 12.5 }}><b>Recurring income detected:</b> {income.map((x) => `${x.merchant} (${inrCompact(x.averageAmount)}, ${x.frequency})`).join(" · ")}</div>}
                  {ended.length > 0 && <div className="dim" style={{ fontSize: 12.5 }}><b>Possibly stopped:</b> {ended.map((x) => x.merchant).join(", ")}</div>}
                  {dismissed.length > 0 && <div className="row wrap" style={{ gap: 8, fontSize: 12.5 }}><b className="dim">Ignored:</b>{dismissed.map((x) => <button key={x.key} className="chip" onClick={() => act("restore", x)}><RotateCcw size={11} /> {x.merchant}</button>)}</div>}
                </div>
              )}
            </Card>
            <ManualForm manual={d.manual} onChange={() => { r.reload(); up.reload(); }} onDelete={del} />
          </div>
        </>
      )}
    </div>
  );
}

function ManualForm({ manual, onChange, onDelete }: { manual: Manual[]; onChange: () => void; onDelete: (id: string) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [dueDay, setDueDay] = useState("1");
  const [category, setCategory] = useState("RENT");
  const [kind, setKind] = useState("expense");
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api("/api/recurring", { method: "POST", json: { name, amount: Number(amount), frequency, dueDay: Number(dueDay) || null, category, kind } });
      toast("Obligation added");
      setName(""); setAmount("");
      onChange();
    } catch (e2) {
      setErr(e2 instanceof ApiClientError ? e2.message : "Could not save.");
    }
  }
  const weekly = frequency === "weekly" || frequency === "biweekly";
  return (
    <Card title="Your recurring obligations" sub="Rent, electricity, internet… entered by you">
      <div className="stack">
        {manual.length ? (
          <div className="list">
            {manual.map((m) => (
              <div className="item" key={m.id}>
                <span className="dot" style={{ background: catColor(m.category) }} />
                <div className="grow"><b>{m.name} {m.kind === "income" && <Badge tone="pos">income</Badge>}</b><span>{m.frequency}{m.dueDay ? (["weekly", "biweekly"].includes(m.frequency) ? ` · ${["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][m.dueDay] ?? ""}` : ` · due ${ord(m.dueDay)}`) : ""}</span></div>
                <b className="num">{inr(m.amount)}</b>
                <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => onDelete(m.id)} aria-label={`Delete ${m.name}`}><Trash2 /></button>
              </div>
            ))}
          </div>
        ) : <div className="dim" style={{ fontSize: 13 }}>None yet. Example: Rent ₹25,000 due on the 1st.</div>}
        <form className="stack" onSubmit={add} style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          {err && <Alert kind="error">{err}</Alert>}
          <Field label="Name"><input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rent" /></Field>
          <div className="form-grid">
            <Field label="Amount (₹)"><input className="input" required type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Frequency"><select className="select" value={frequency} onChange={(e) => { setFrequency(e.target.value); setDueDay(["weekly", "biweekly"].includes(e.target.value) ? "1" : "1"); }}>{FREQS.map((f) => <option key={f}>{f}</option>)}</select></Field>
            <Field label={weekly ? "Weekday" : "Due day of month"}>
              {weekly ? (
                <select className="select" value={dueDay} onChange={(e) => setDueDay(e.target.value)}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
              ) : (
                <input className="input" type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
              )}
            </Field>
            <Field label="Category"><select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORY_NAMES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</select></Field>
          </div>
          <Field label="Type"><Seg value={kind} options={[{ value: "expense", label: "Expense" }, { value: "income", label: "Income" }]} onChange={setKind} /></Field>
          <button className="btn primary" type="submit"><Plus /> Add obligation</button>
        </form>
      </div>
    </Card>
  );
}

export function ForecastCard() {
  const [days, setDays] = useState("30");
  const [planned, setPlanned] = useState("");
  const f = useApi<Forecast>(`/api/forecast?days=${days}${planned && Number(planned) > 0 ? `&planned=${Number(planned)}` : ""}`);
  const d = f.data;
  return (
    <Card title="Cash-flow forecast" sub="Estimated from historical income, recurring bills and your typical everyday spending" right={<div className="row wrap"><Estimate /><Seg label="Horizon" value={days} options={[{ value: "30", label: "30d" }, { value: "60", label: "60d" }, { value: "90", label: "90d" }]} onChange={setDays} /></div>}>
      {f.error ? <ErrorState error={f.error} retry={f.reload} /> : !d ? <CardSkeleton h={160} /> : (
        <div className="grid g-7-5" style={{ gap: 24 }}>
          <div className="stack" style={{ gap: 12 }}>
            <Row label="Current balance" value={d.currentBalance === null ? "unknown" : inr(d.currentBalance)} note={d.balanceAsOf ? `as of ${shortDate(d.balanceAsOf)}` : undefined} />
            <Row label="Expected income" value={inr(d.expectedIncome)} tone="pos" note={d.expectedIncomeBasis.split(" (")[0]} />
            <Row label="Expected recurring expenses" value={`− ${inr(d.expectedRecurring)}`} tone="neg" />
            <Row label="Estimated everyday spending" value={`− ${inr(d.discretionary.expected)}`} tone="neg" note={`typical range ${inrCompact(d.discretionary.low)}–${inrCompact(d.discretionary.high)}`} />
            {Number(planned) > 0 && <Row label="Planned one-off expense" value={`− ${inr(Number(planned))}`} tone="neg" />}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <Row strong label="Estimated remaining cash" value={d.expectedRemaining === null ? "n/a" : inr(d.expectedRemaining)} note={d.expectedRemainingLow !== null ? `plausible range ${inrCompact(d.expectedRemainingLow!)}–${inrCompact(d.expectedRemainingHigh!)}` : undefined} />
              {d.safeToSpend !== null && <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>Estimated safe extra spending (after a {inr(d.buffer)} buffer): <b className="num">{inr(d.safeToSpend)}</b></div>}
            </div>
          </div>
          <div className="stack">
            <Field label="What if I spend a planned amount? (₹)"><input className="input" type="number" min={0} value={planned} onChange={(e) => setPlanned(e.target.value)} placeholder="e.g. 10000" /></Field>
            <div className="alert info" style={{ fontSize: 12.5 }}>
              <div><b>Assumptions</b> · confidence: {d.confidence}
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{d.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value, tone, note, strong }: { label: string; value: string; tone?: "pos" | "neg"; note?: string; strong?: boolean }) {
  return (
    <div className="row spread" style={{ alignItems: "baseline", gap: 12 }}>
      <span className={strong ? "" : "dim"} style={{ fontWeight: strong ? 600 : 400 }}>{label}{note && <span className="faint" style={{ fontSize: 11.5, display: "block" }}>{note}</span>}</span>
      <span className={`num ${tone ?? ""}`} style={{ fontWeight: strong ? 700 : 550, fontSize: strong ? 20 : 14.5, whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
