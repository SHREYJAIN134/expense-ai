"use client";
import { FileText, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Card, CardSkeleton, Empty, ErrorState, Modal, useToast } from "@/components/ui";
import { api, ApiClientError, useApi } from "@/lib/client/api";
import { inr, longDate } from "@/lib/client/format";

interface Statement {
  id: string; filename: string; bank: string; accountMask: string | null; periodStart: string | null; periodEnd: string | null;
  status: string; transactionCount: number; duplicatesSkipped: number; totalDebits: number; totalCredits: number;
  openingBalance: number | null; closingBalance: number | null; reconciliationStatus: string | null; uploadedAt: string; importedAt: string | null; isDemo: boolean;
}

export function StatementsSection() {
  const q = useApi<{ statements: Statement[] }>("/api/statements");
  const { toast } = useToast();
  const [del, setDel] = useState<Statement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    if (!del) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/statements/${del.id}`, { method: "DELETE" });
      toast("Statement and its transactions were deleted.");
      setDel(null);
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiClientError ? e.message : "Could not delete.");
    } finally {
      setBusy(false);
    }
  }

  const list = q.data?.statements ?? [];
  const imported = list.filter((s) => s.status === "imported");
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Link href="/bring-in" className="btn solid"><Plus /> Bring in a statement</Link>
      </div>
      {q.error ? <ErrorState error={q.error} retry={q.reload} /> : !q.data ? <CardSkeleton h={260} /> : !list.length ? (
        <Card><Empty title="No statements yet">Upload your first HDFC or Google Pay statement to build your history.</Empty></Card>
      ) : (
        <>
          <div className="grid g3">
            <Card><div className="faint">Statements imported</div><div style={{ fontSize: 26, fontWeight: 650 }}>{imported.length}</div></Card>
            <Card><div className="faint">Transactions stored</div><div style={{ fontSize: 26, fontWeight: 650 }} className="num">{imported.reduce((a, s) => a + s.transactionCount, 0).toLocaleString("en-IN")}</div></Card>
            <Card><div className="faint">Coverage</div><div style={{ fontSize: 18, fontWeight: 650, marginTop: 4 }}>{(() => { const ps = imported.map((s) => s.periodStart).filter(Boolean).sort(); const pe = imported.map((s) => s.periodEnd).filter(Boolean).sort(); return ps.length ? `${longDate(ps[0]!)} → ${longDate(pe[pe.length - 1]!)}` : "—"; })()}</div></Card>
          </div>
          <Card flush>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Statement</th><th>Period</th><th className="n">Txns</th><th className="n hide-sm">Credits</th><th className="n hide-sm">Debits</th><th>Status</th><th className="hide-sm">Uploaded</th><th /></tr></thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id}>
                      <td className="desc">
                        <b className="row" style={{ gap: 8 }}><FileText size={15} style={{ color: "var(--ink)" }} />{s.filename} {s.isDemo && <Badge tone="demo">DEMO</Badge>}</b>
                        <span>{s.bank === "GOOGLE_PAY" ? "Google Pay" : s.bank}{s.accountMask ? ` · ${s.bank === "GOOGLE_PAY" ? "paid from" : "account"} ••${s.accountMask}` : ""}</span>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{s.periodStart ? `${longDate(s.periodStart)} → ${s.periodEnd ? longDate(s.periodEnd) : ""}` : "—"}</td>
                      <td className="n">{s.transactionCount}{s.duplicatesSkipped ? <span className="faint" title="duplicates skipped"> (+{s.duplicatesSkipped} dup)</span> : null}</td>
                      <td className="n pos hide-sm">{inr(s.totalCredits)}</td>
                      <td className="n neg hide-sm">{inr(s.totalDebits)}</td>
                      <td><Badge tone={s.status === "imported" ? "pos" : s.status === "failed" ? "neg" : "warn"}>{s.status === "preview" ? "awaiting review" : s.status}</Badge>{s.reconciliationStatus && <div style={{ marginTop: 4 }}><Badge tone={s.reconciliationStatus === "reconciled" ? "pos" : s.reconciliationStatus === "mismatch" ? "neg" : "warn"}>{s.reconciliationStatus === "reconciled" ? "reconciled" : s.reconciliationStatus === "mismatch" ? "mismatch" : "no summary"}</Badge></div>}</td>
                      <td className="faint hide-sm" style={{ whiteSpace: "nowrap" }}>{s.uploadedAt.slice(0, 10)}</td>
                      <td className="right" style={{ whiteSpace: "nowrap" }}>
                        {s.status === "imported" && <Link className="btn sm" href={`/ledger?statementId=${s.id}`}>View</Link>}{" "}
                        <button className="btn sm danger outline" onClick={() => setDel(s)} aria-label={`Delete ${s.filename}`}><Trash2 /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {del && (
        <Modal title="Delete this statement?" onClose={() => setDel(null)}>
          <div className="stack">
            <p className="dim" style={{ margin: 0 }}>This permanently removes <b>{del.filename}</b>{del.status === "imported" ? <> and its <b>{del.transactionCount}</b> transactions</> : null}. Analytics will be recalculated. This cannot be undone.</p>
            {err && <Alert kind="error">{err}</Alert>}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setDel(null)}>Cancel</button>
              <button className="btn danger" onClick={remove} disabled={busy}>{busy ? "Deleting…" : "Delete permanently"}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
