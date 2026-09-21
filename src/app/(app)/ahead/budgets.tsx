"use client";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { BudgetVariance } from "@/lib/analytics/planning";
import { BudgetBars } from "@/components/charts/basic";
import { BudgetBar } from "@/components/ll";
import { Alert, Badge, Card, CardSkeleton, Empty, ErrorState, Estimate, Field, Progress, useToast } from "@/components/ui";
import { api, ApiClientError, useApi } from "@/lib/client/api";
import { catColor, categoryLabel, inr, longDate } from "@/lib/client/format";
import { CATEGORY_NAMES, NON_SPENDING_CATEGORIES } from "@/lib/domain/categories";

interface BudgetsRes { budgets: { id: string; category: string; amount: number; alertThreshold: number }[]; status: BudgetVariance[] }
interface Goal { id: string; name: string; targetAmount: number; currentAmount: number; targetDate: string | null; status: string; progress: number }

const SPEND_CATS = CATEGORY_NAMES.filter((c) => !NON_SPENDING_CATEGORIES.has(c) && c !== "SALARY/INCOME" && c !== "REFUNDS");

export function BudgetsSection() {
  const b = useApi<BudgetsRes>("/api/budgets");
  const g = useApi<{ goals: Goal[] }>("/api/goals");
  const { toast } = useToast();
  const [category, setCategory] = useState("FOOD");
  const [amount, setAmount] = useState("");
  const [threshold, setThreshold] = useState("80");
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api("/api/budgets", { method: "POST", json: { category, amount: Number(amount), alertThreshold: Number(threshold) / 100 } });
      toast("Budget saved");
      setAmount("");
      b.reload();
    } catch (e2) {
      setErr(e2 instanceof ApiClientError ? e2.message : "Could not save.");
    }
  }
  async function remove(id: string) {
    await api(`/api/budgets/${id}`, { method: "DELETE" });
    toast("Budget removed");
    b.reload();
  }
  async function edit(id: string, amt: number) {
    if (!(amt > 0)) return;
    await api(`/api/budgets/${id}`, { method: "PATCH", json: { amount: amt } });
    b.reload();
  }

  const status = b.data?.status ?? [];
  const alerts = status.filter((s) => s.status !== "ok");
  return (
    <div className="stack" style={{ gap: 18 }}>
      {b.error ? <ErrorState error={b.error} retry={b.reload} /> : (
        <>
          {alerts.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              {alerts.map((a) => (
                <Alert key={a.id} kind={a.status === "over" ? "error" : "warn"}><b>{categoryLabel(a.category)}:</b> {a.message}</Alert>
              ))}
            </div>
          )}
          <div className="grid g-7-5">
            <Card title="Budget vs actual" sub={status[0] ? `${longDate(status[0].periodStart)} → ${longDate(status[0].periodEnd)}` : "This financial month"} right={<Estimate />}>
              {!b.data ? <CardSkeleton h={260} /> : <BudgetBars rows={status.map((s) => ({ category: s.category, budget: s.budget, actual: s.actual, projected: s.projected }))} />}
            </Card>
            <Card title="Add or update a budget" sub="Monthly limit for a category">
              <form className="stack" onSubmit={add}>
                {err && <Alert kind="error">{err}</Alert>}
                <Field label="Category">
                  <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                    {SPEND_CATS.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
                  </select>
                </Field>
                <Field label="Monthly budget (₹)"><input className="input" type="number" min={1} step="1" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 8000" /></Field>
                <Field label={`Warn me at ${threshold}% used`}><input type="range" min={30} max={100} step={5} value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ accentColor: "var(--ink)" }} /></Field>
                <button className="btn primary" type="submit"><Plus /> Save budget</button>
              </form>
            </Card>
          </div>

          <Card flush title="Your budgets" sub="Budget · actual · remaining · % used · projected month-end">
            {!b.data ? <div style={{ padding: 18 }}><CardSkeleton h={100} /></div> : !status.length ? (
              <Empty title="No budgets yet">Create one above - for example Food ₹8,000 per month.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Category</th><th className="n">Budget</th><th className="n">Actual</th><th className="n">Remaining</th><th style={{ minWidth: 170 }}>Used</th><th className="n hide-sm">Projected <Estimate /></th><th /></tr></thead>
                  <tbody>
                    {status.map((s) => (
                      <tr key={s.id}>
                        <td><span className="row" style={{ gap: 8 }}><span className="dot" style={{ background: catColor(s.category) }} /><b style={{ fontWeight: 550 }}>{categoryLabel(s.category)}</b></span></td>
                        <td className="n"><input className="input" style={{ width: 110, textAlign: "right", padding: "5px 8px" }} type="number" defaultValue={s.budget} onBlur={(e) => Number(e.target.value) !== s.budget && edit(s.id, Number(e.target.value))} aria-label={`Budget for ${categoryLabel(s.category)}`} /></td>
                        <td className="n">{inr(s.actual)}</td>
                        <td className={`n ${s.remaining < 0 ? "neg" : ""}`}>{inr(s.remaining)}</td>
                        <td>
                          <div className="row" style={{ gap: 10 }}>
                            <div className="grow"><BudgetBar actualPct={s.pctUsed} projectedPct={s.projectedPct} over={s.status === "over"} markPct={(s.daysElapsed / s.daysTotal) * 100} /></div>
                            <span className="num" style={{ width: 44, textAlign: "right" }}>{Math.round(s.pctUsed)}%</span>
                          </div>
                        </td>
                        <td className={`n hide-sm ${s.projected > s.budget ? "warn" : ""}`}>{inr(s.projected)} <span className="faint">({Math.round(s.projectedPct)}%)</span></td>
                        <td className="right"><button className="btn sm danger outline" onClick={() => remove(s.id)} aria-label="Delete budget"><Trash2 /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="faint" style={{ fontSize: 12, margin: 0 }}>The vertical tick on each bar marks how far through the month you are. Projected figures assume your recent pace continues.</p>
        </>
      )}
      <Goals goals={g.data?.goals ?? null} error={g.error} reload={g.reload} />
    </div>
  );
}

function Goals({ goals, error, reload }: { goals: Goal[] | null; error: { message: string } | null; reload: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [saved, setSaved] = useState("");
  const [date, setDate] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    await api("/api/goals", { method: "POST", json: { name, targetAmount: Number(target), currentAmount: saved ? Number(saved) : 0, targetDate: date || null } });
    setName(""); setTarget(""); setSaved(""); setDate("");
    toast("Goal added");
    reload();
  }
  return (
    <div className="grid g-7-5">
      <Card title="Financial goals" sub="Track what you're saving toward (progress is what you enter - it isn't derived from statements)">
        {error ? <ErrorState error={error} retry={reload} /> : !goals ? <CardSkeleton h={120} /> : !goals.length ? <Empty title="No goals yet">Add an emergency fund, a trip, a laptop…</Empty> : (
          <div className="stack" style={{ gap: 16 }}>
            {goals.map((gl) => (
              <div key={gl.id}>
                <div className="row spread">
                  <b>{gl.name} {gl.progress >= 100 && <Badge tone="pos">reached</Badge>}</b>
                  <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={async () => { await api(`/api/goals/${gl.id}`, { method: "DELETE" }); reload(); }} aria-label={`Delete ${gl.name}`}><Trash2 /></button>
                </div>
                <div style={{ margin: "8px 0 6px" }}><Progress value={gl.progress} /></div>
                <div className="row spread wrap dim" style={{ fontSize: 12.5 }}>
                  <span className="num">{inr(gl.currentAmount)} of {inr(gl.targetAmount)} ({gl.progress}%){gl.targetDate ? ` · by ${longDate(gl.targetDate)}` : ""}</span>
                  <span className="row" style={{ gap: 6 }}>
                    Saved so far
                    <input className="input" style={{ width: 110, padding: "4px 8px" }} type="number" defaultValue={gl.currentAmount} onBlur={async (e) => { const v = Number(e.target.value); if (v !== gl.currentAmount && v >= 0) { await api(`/api/goals/${gl.id}`, { method: "PATCH", json: { currentAmount: v } }); reload(); } }} aria-label={`Saved toward ${gl.name}`} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title="Add a goal">
        <form className="stack" onSubmit={add}>
          <Field label="Name"><input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Emergency fund" /></Field>
          <div className="form-grid">
            <Field label="Target (₹)"><input className="input" type="number" min={1} required value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
            <Field label="Saved so far (₹)"><input className="input" type="number" min={0} value={saved} onChange={(e) => setSaved(e.target.value)} /></Field>
          </div>
          <Field label="Target date (optional)"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <button className="btn primary" type="submit"><Plus /> Add goal</button>
        </form>
      </Card>
    </div>
  );
}
