"use client";
import { Check, Eye, EyeOff, FileText, Loader2, Lock, ShieldCheck, UploadCloud, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import type { PreviewResult, PreviewRow } from "@/lib/pipeline/import";
import { PageTitle, Twin } from "@/components/ll";
import { Alert, Badge, Card, Field, Progress, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { catColor, categoryLabel, confidenceLabel, inr, longDate } from "@/lib/client/format";

const MAX_BYTES = 15 * 1024 * 1024;
const STAGES: { key: string; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "decrypt", label: "Decrypt" },
  { key: "parse", label: "Extract" },
  { key: "validate", label: "Validate" },
  { key: "reconcile", label: "Reconcile" },
  { key: "duplicates", label: "Detect duplicates" },
  { key: "classify", label: "Classify" },
  { key: "preview", label: "Preview" },
];

type Phase = "select" | "processing" | "preview" | "importing" | "done";

interface StreamError { code: string; message: string }

/** Upload via XHR so we get real upload progress AND can read the server's streamed (NDJSON) parse progress. */
function uploadStatement(file: File, password: string, cb: { onUpload: (pct: number) => void; onStage: (stage: string, detail?: string) => void }) {
  return new Promise<PreviewResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/statements/upload");
    xhr.responseType = "text";
    let seen = 0;
    let result: PreviewResult | null = null;
    let streamErr: StreamError | null = null;
    const drain = () => {
      const text = xhr.responseText;
      const end = text.lastIndexOf("\n");
      if (end < seen) return;
      for (const line of text.slice(seen, end).split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "progress") cb.onStage(ev.stage, ev.detail);
          else if (ev.type === "preview") result = ev.preview;
          else if (ev.type === "error") streamErr = ev.error;
        } catch { /* partial line */ }
      }
      seen = end + 1;
    };
    xhr.upload.onprogress = (e) => e.lengthComputable && cb.onUpload(Math.round((e.loaded / e.total) * 100));
    xhr.upload.onload = () => cb.onUpload(100);
    xhr.onprogress = drain;
    xhr.onerror = () => reject(new ApiClientError(0, "NETWORK", "Network error while uploading. Check your connection and try again."));
    xhr.onload = () => {
      if (xhr.status === 401 && !xhr.getResponseHeader("content-type")?.includes("ndjson")) { window.location.replace("/login"); return; }
      if (xhr.status >= 400 && !xhr.getResponseHeader("content-type")?.includes("ndjson")) {
        try { const j = JSON.parse(xhr.responseText); return reject(new ApiClientError(xhr.status, j.error?.code ?? "ERROR", j.error?.message ?? "Upload failed.")); } catch { return reject(new ApiClientError(xhr.status, "ERROR", "Upload failed.")); }
      }
      drain();
      // process any trailing line without newline
      const tail = xhr.responseText.slice(seen).trim();
      if (tail) { try { const ev = JSON.parse(tail); if (ev.type === "preview") result = ev.preview; if (ev.type === "error") streamErr = ev.error; } catch { /* ignore */ } }
      if (streamErr) return reject(new ApiClientError(422, (streamErr as StreamError).code, (streamErr as StreamError).message));
      if (result) return resolve(result);
      reject(new ApiClientError(500, "ERROR", "The server did not return a result."));
    };
    const form = new FormData();
    form.append("file", file);
    if (password) form.append("password", password);
    xhr.send(form);
  });
}

export default function UploadPage() {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("select");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [drag, setDrag] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [stage, setStage] = useState<string>("upload");
  const [detail, setDetail] = useState<string>("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<{ imported: number; duplicatesSkipped: number; recurring: { series: number } } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  const pick = useCallback((f: File | null | undefined) => {
    setFileError(null);
    setError(null);
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") return setFileError("Only PDF files are supported.");
    if (f.size === 0) return setFileError("That file is empty.");
    if (f.size > MAX_BYTES) return setFileError("That file is larger than the 15 MB limit.");
    setFile(f);
  }, []);

  async function process() {
    if (!file) return;
    setError(null);
    setPhase("processing");
    setStage("upload");
    setUploadPct(0);
    setDetail("");
    const pw = password;
    setPassword(""); // the password never lives in React state after submission
    try {
      const p = await uploadStatement(file, pw, { onUpload: setUploadPct, onStage: (s, d) => { setStage(s); setDetail(d ?? ""); } });
      setPreview(p);
      setPhase("preview");
    } catch (e) {
      const err = e instanceof ApiClientError ? e : new ApiClientError(0, "ERROR", "Something went wrong.");
      setError({ code: err.code, message: err.message });
      setPhase("select");
      if (err.code === "PASSWORD_REQUIRED" || err.code === "INCORRECT_PASSWORD") setTimeout(() => pwRef.current?.focus(), 50);
    }
  }

  async function confirm(acknowledge = false) {
    if (!preview) return;
    setPhase("importing");
    try {
      const r = await api<{ imported: number; duplicatesSkipped: number; recurring: { series: number } }>("/api/statements/process", { method: "POST", json: { statementId: preview.statementId, acknowledgeReconciliation: acknowledge || undefined } });
      setResult(r);
      setPhase("done");
      toast(`Imported ${r.imported} transactions`);
    } catch (e) {
      setError({ code: "IMPORT", message: e instanceof ApiClientError ? e.message : "Import failed." });
      setPhase("preview");
    }
  }

  async function discard() {
    if (preview) await api(`/api/statements/${preview.statementId}`, { method: "DELETE" }).catch(() => undefined);
    reset();
  }

  function reset() {
    setPhase("select");
    setFile(null);
    setPassword("");
    setPreview(null);
    setResult(null);
    setError(null);
    setUploadPct(0);
  }

  const stageIndex = STAGES.findIndex((s) => s.key === stage);

  return (
    <div className="stack fade-in" style={{ gap: 18, maxWidth: phase === "preview" ? 1300 : 860, margin: "0 auto" }}>
      <PageTitle lab="Bring in" title="Bring in a statement" sub="An HDFC account statement or a Google Pay transaction statement (PDF). The format is detected automatically; the file is read on the server, checked against its own totals, and never stored." />
      <FlowSteps phase={phase} />

      {(phase === "select" || phase === "processing") && (
        <Card>
          <div className="stack" style={{ gap: 18 }}>
            {error && (
              <Alert kind="error">
                <b>{errorTitle(error.code)}</b>
                <div>{error.message}</div>
              </Alert>
            )}
            {!file ? (
              <div
                className={`dropzone ${drag ? "drag" : ""}`}
                role="button"
                tabIndex={0}
                aria-label="Choose a PDF statement"
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
              >
                <div className="big"><UploadCloud /></div>
                <b style={{ fontSize: 16 }}>Drop your HDFC or Google Pay statement PDF here</b>
                <div className="dim" style={{ marginTop: 4 }}>or click to browse · PDF only · up to 15 MB</div>
                <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
              </div>
            ) : (
              <div className="card row" style={{ padding: 14, gap: 14 }}>
                <div className="chip-icon" style={{ background: "var(--soft)", color: "var(--ink)", width: 42, height: 42 }}><FileText size={20} /></div>
                <div className="grow">
                  <b style={{ wordBreak: "break-all" }}>{file.name}</b>
                  <div className="faint" style={{ fontSize: 12 }}>{(file.size / 1024).toFixed(0)} KB · PDF</div>
                </div>
                {phase === "select" && <button className="icon-btn" onClick={() => setFile(null)} aria-label="Remove file"><X /></button>}
              </div>
            )}
            {fileError && <Alert kind="warn">{fileError}</Alert>}

            {phase === "select" && (
              <>
                <Field label="PDF password (if the statement is protected)" hint={<span className="row" style={{ gap: 6 }}><Lock size={12} /> Used only to open the PDF in memory. It is never stored, logged or sent anywhere else. HDFC statements often use your customer ID or a date-of-birth based password; Google Pay exports are normally not protected.</span>}>
                  <div style={{ position: "relative" }}>
                    <input
                      ref={pwRef}
                      className="input"
                      type={showPw ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Leave empty if the PDF isn't protected"
                      style={{ paddingRight: 44, ...(error && /PASSWORD/.test(error.code) ? { borderColor: "var(--neg)" } : {}) }}
                      onKeyDown={(e) => e.key === "Enter" && file && process()}
                    />
                    <button type="button" className="icon-btn" style={{ position: "absolute", right: 3, top: 3, border: "none", background: "none" }} onClick={() => setShowPw((s) => !s)} aria-label={showPw ? "Hide password" : "Show password"}>
                      {showPw ? <EyeOff /> : <Eye />}
                    </button>
                  </div>
                </Field>
                <div className="row spread wrap">
                  <span className="faint row" style={{ gap: 6, fontSize: 12 }}><ShieldCheck size={14} /> Nothing is saved until you review and confirm.</span>
                  <button className="btn primary" disabled={!file} onClick={process}><UploadCloud /> Process statement</button>
                </div>
              </>
            )}

            {phase === "processing" && (
              <div className="stack" style={{ gap: 14 }}>
                <div className="steps">
                  {STAGES.map((s, i) => {
                    const done = i < stageIndex || (s.key === "upload" && uploadPct === 100 && stage !== "upload");
                    const active = i === stageIndex;
                    return (
                      <span key={s.key} className={`step ${done ? "done" : active ? "active" : ""}`}>
                        {done ? <Check /> : active ? <Loader2 className="spin" /> : null}
                        {s.label}
                      </span>
                    );
                  })}
                </div>
                <Progress value={stage === "upload" ? uploadPct * 0.15 : 15 + (stageIndex / (STAGES.length - 1)) * 85} />
                <div className="dim" style={{ fontSize: 13 }}>{stage === "upload" ? `Uploading… ${uploadPct}%` : detail || "Working…"}</div>
              </div>
            )}
          </div>
        </Card>
      )}

      {(phase === "preview" || phase === "importing") && preview && (
        <PreviewPanel preview={preview} busy={phase === "importing"} error={error?.message ?? null} onConfirm={confirm} onDiscard={discard} />
      )}

      {phase === "done" && result && preview && (
        <div className="sheet" style={{ padding: "28px clamp(18px, 4vw, 36px)", borderColor: "var(--ink)" }}>
          <div className="row" style={{ gap: 12 }}>
            <span style={{ width: 38, height: 38, borderRadius: "50%", background: "var(--in)", color: "var(--onink)", display: "inline-grid", placeItems: "center" }}><Check size={20} strokeWidth={2.6} /></span>
            <h2 className="serif" style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-.02em" }}>Imported. Nothing counted twice.</h2>
          </div>
          <div className="grid g3" style={{ marginTop: 18, maxWidth: 560 }}>
            <div><div className="serif" style={{ fontSize: 34 }}>{result.imported}</div><span className="faint">new event{result.imported === 1 ? "" : "s"}</span></div>
            <div><div className="serif" style={{ fontSize: 34 }}>{result.duplicatesSkipped + preview.counts.matched}</div><span className="faint">already here</span></div>
            <div><div className="serif" style={{ fontSize: 34 }}>{preview.counts.potential + preview.counts.lowConfidence}</div><span className="faint">for you to decide</span></div>
          </div>
          <p className="dim" style={{ marginTop: 14 }}>Analytics, signals and projections have been refreshed from the ledger.</p>
          <div className="row wrap" style={{ marginTop: 18, gap: 10 }}>
            <Link href={`/ledger?statementId=${preview.statementId}`} className="btn solid">Open in Ledger</Link>
            <Link href="/now" className="btn">See Now</Link>
            {preview.counts.potential > 0 && <Link href="/ledger?matchStatus=potential" className="btn">Decide {preview.counts.potential} possible match{preview.counts.potential === 1 ? "" : "es"}</Link>}
            {preview.counts.lowConfidence > 0 && <Link href="/ledger?lowConfidence=1" className="btn">Review {preview.counts.lowConfidence} uncertain</Link>}
            <button className="btn ghost" onClick={reset}>Bring in another</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Five steps, one screen each. Nothing is saved until the last one. */
function FlowSteps({ phase }: { phase: Phase }) {
  const cur = phase === "select" ? 0 : phase === "processing" ? 1 : phase === "preview" ? 3 : phase === "importing" ? 4 : 5;
  const labels = ["Choose", "Read", "Check", "Compare", "Confirm"];
  return (
    <div>
      <div className="stepbar" aria-hidden>{labels.map((l, i) => <i key={l} className={i < cur ? "done" : i === cur ? "cur" : ""} />)}</div>
      <div className="row spread" style={{ marginTop: 6 }}>
        <span className="lab">{cur >= 5 ? "Done" : `Step ${cur + 1} of 5 · ${labels[cur]}`}</span>
        <span className="faint row" style={{ gap: 5, fontSize: 12 }}><Lock size={12} /> {cur >= 5 ? "saved to your ledger" : "nothing saved yet"}</span>
      </div>
    </div>
  );
}

function errorTitle(code: string) {
  switch (code) {
    case "PASSWORD_REQUIRED": return "This PDF is password protected";
    case "INCORRECT_PASSWORD": return "Incorrect password";
    case "INVALID_PDF": case "INVALID_FILE": return "Not a valid PDF";
    case "UNSUPPORTED_FORMAT": return "Unsupported statement format";
    case "NO_TRANSACTIONS": return "No transactions found";
    case "FILE_TOO_LARGE": return "File too large";
    case "NETWORK": return "Network problem";
    case "RATE_LIMITED": return "Slow down a little";
    default: return "Couldn't process the statement";
  }
}

function PreviewPanel({ preview, busy, error, onConfirm, onDiscard }: { preview: PreviewResult; busy: boolean; error: string | null; onConfirm: (acknowledge: boolean) => void; onDiscard: () => void }) {
  const [filter, setFilter] = useState<"all" | "new" | "review" | "dupes" | "refunds" | "recurring" | "matched">("all");
  const [page, setPage] = useState(0);
  const [ack, setAck] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(() => {
    const all = preview.transactions;
    return all.filter((r: PreviewRow) =>
      filter === "new" ? !r.isDuplicate
      : filter === "dupes" ? r.isDuplicate
      : filter === "review" ? !r.isDuplicate && r.needsReview
      : filter === "matched" ? !!r.match
      : filter === "refunds" ? r.isRefund
      : filter === "recurring" ? r.isRecurringCandidate
      : true,
    );
  }, [preview, filter]);
  const PAGE = 50;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const c = preview.counts;
  const rec = preview.reconciliation;
  const nothingNew = c.new === 0;
  const blocked = preview.requiresAcknowledgement && !ack;
  const st = rec.status === "reconciled" ? { tone: "pos" as const, text: "Reconciled" } : rec.status === "mismatch" ? { tone: "neg" as const, text: "Does NOT reconcile" } : rec.status === "requires_review" ? { tone: "warn" as const, text: "Reconciliation requires review" } : { tone: "warn" as const, text: "No official summary found" };
  const isWallet = preview.source === "GOOGLE_PAY";
  const pt = preview.providerTotals;
  const total = Math.max(1, c.new);
  const otherWarnings = preview.warnings.filter((w) => !/already imported/i.test(w) && !rec.issues.includes(w));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card>
        <div className="row spread wrap" style={{ gap: 16 }}>
          <div>
            <h2 className="serif" style={{ fontSize: 26, fontWeight: 500 }}>Review before importing</h2>
            <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>
              {preview.filename} · <b>{preview.sourceLabel}</b> · {preview.source === "GOOGLE_PAY" ? "paid from" : "account"} ••{preview.account.mask}
              {preview.period && <> · {longDate(preview.period.start)} → {longDate(preview.period.end)}</>}
            </div>
          </div>
          <div className="row">
            <button className="btn ghost" onClick={onDiscard} disabled={busy}>Discard</button>
            <button className="btn primary" onClick={() => onConfirm(ack)} disabled={busy || nothingNew || blocked} title={blocked ? "Acknowledge the reconciliation problem first" : undefined}>
              {busy ? <><Loader2 className="spin" /> Importing…</> : <>Import {c.new} new transaction{c.new === 1 ? "" : "s"}</>}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="lab">What will change</div>
          <div style={{ marginTop: 6 }}>
            <div className="row spread" style={{ minHeight: 56, borderTop: "1px solid var(--hair)" }}><span className="row" style={{ gap: 10 }}><Twin /><span><b>Already here</b><span className="faint" style={{ fontSize: 12.5, display: "block" }}>same payment already in your ledger, counted once</span></span></span><span className="serif" style={{ fontSize: 26 }}>{c.duplicates + c.matched}</span></div>
            <div className="row spread" style={{ minHeight: 56, borderTop: "1px solid var(--hair)" }}><span className="row" style={{ gap: 10 }}><span style={{ width: 20, textAlign: "center", color: "var(--in)", fontWeight: 700, fontSize: 18 }}>＋</span><span><b>New to your ledger</b><span className="faint" style={{ fontSize: 12.5, display: "block" }}>added when you confirm</span></span></span><span className="serif" style={{ fontSize: 26 }}>{c.newEvents}</span></div>
            <div style={{ borderTop: "1px solid var(--ink)", padding: "14px 0 4px" }}>
              <div className="row spread"><span className="row" style={{ gap: 10 }}><span className="hl" style={{ fontWeight: 700, width: 20, textAlign: "center" }}>?</span><span><b>Your decision</b><span className="faint" style={{ fontSize: 12.5, display: "block" }}>{c.potential > 0 ? "possible duplicates — you choose right after import" : "nothing is uncertain"}</span></span></span><span className="serif" style={{ fontSize: 26 }}>{c.potential}</span></div>
              {preview.transactions.filter((r) => r.match?.status === "potential").slice(0, 3).map((r) => (
                <div key={r.seq} style={{ marginTop: 10, padding: "12px 14px", borderRadius: 12, background: "var(--soft)" }}>
                  <b>{r.merchant} · {inr(r.debit || r.credit)}</b>
                  <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>{longDate(r.date)} ↔ {r.match!.with}. {r.match!.reason}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {isWallet ? (
          <>
            <div className="grid g4" style={{ marginTop: 16 }}>
              <Stat label="Transactions detected" value={String(c.total)} sub={`${c.debits} paid · ${c.credits} received`} />
              <Stat label="Sent" value={pt ? inr(pt.sent) : "—"} tone="neg" sub={pt ? `parsed rows: ${inr(pt.sentCalculated)}` : "no total on the statement"} />
              <Stat label="Received" value={pt ? inr(pt.received) : "—"} tone="pos" sub={pt ? `parsed rows: ${inr(pt.receivedCalculated)}` : "no total on the statement"} />
              <Stat label="Statement period" value={preview.period ? `${longDate(preview.period.start).replace(/ 20\d\d$/, "")} – ${longDate(preview.period.end).replace(/ 20\d\d$/, "")}` : "—"} sub={preview.period ? preview.period.end.slice(0, 4) : undefined} />
            </div>
            <div className="grid g4" style={{ marginTop: 12 }}>
              <Stat label="Matched existing" value={String(c.matched)} tone={c.matched ? "pos" : undefined} sub="same payment already in your history (kept once)" />
              <Stat label="New transactions" value={String(c.newEvents)} sub="added to your history" />
              <Stat label="Potential matches" value={String(c.potential)} tone={c.potential ? undefined : "pos"} sub="need your decision after import" />
              <Stat label="Needs review" value={String(c.needsReview)} sub={`${c.duplicates} already imported (skipped)`} tone={c.needsReview ? undefined : "pos"} />
            </div>
          </>
        ) : (
          <>
            <div className="grid g4" style={{ marginTop: 16 }}>
              <Stat label="Transactions" value={String(c.total)} sub={`${c.debits} debits · ${c.credits} credits`} />
              <Stat label="Opening balance" value={preview.openingBalance !== undefined ? inr(preview.openingBalance) : "—"} sub={`closing ${preview.closingBalance !== undefined ? inr(preview.closingBalance) : "—"}`} />
              <Stat label="Total debits" value={inr(preview.totals.debits)} tone="neg" sub={`new: ${inr(preview.totals.newDebits)}`} />
              <Stat label="Total credits" value={inr(preview.totals.credits)} tone="pos" sub={`new: ${inr(preview.totals.newCredits)}`} />
            </div>
            <div className="grid g4" style={{ marginTop: 12 }}>
              <Stat label="Already imported" value={String(c.duplicates)} sub="duplicates (skipped)" />
              <Stat label="Refunds" value={String(c.refunds)} sub="credits reversing a purchase" />
              <Stat label="Recurring candidates" value={String(c.recurringCandidates)} sub={`${c.autopay} AUTOPAY · estimates only`} />
              <Stat label="Needs review" value={String(c.needsReview)} sub={`${c.unclassified} unclassified`} tone={c.needsReview ? undefined : "pos"} />
            </div>
            {(c.matched > 0 || c.potential > 0) && (
              <div className="grid g4" style={{ marginTop: 12 }}>
                <Stat label="Matched in other sources" value={String(c.matched)} tone="pos" sub="also in your Google Pay history (kept once)" />
                <Stat label="Potential matches" value={String(c.potential)} sub="need your decision after import" />
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 14 }}>
          <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>Classification confidence (new transactions)</div>
          <div style={{ display: "flex", height: 10, borderRadius: 99, overflow: "hidden", background: "var(--surface-2)" }} role="img" aria-label={`High ${preview.confidence.high}, medium ${preview.confidence.medium}, low ${preview.confidence.low}`}>
            <div style={{ width: `${(preview.confidence.high / total) * 100}%`, background: "var(--pos)" }} />
            <div style={{ width: `${(preview.confidence.medium / total) * 100}%`, background: "var(--warn)" }} />
            <div style={{ width: `${(preview.confidence.low / total) * 100}%`, background: "var(--neg)" }} />
          </div>
          <div className="row wrap dim" style={{ gap: 14, fontSize: 12, marginTop: 6 }}>
            <span><span className="dot" style={{ background: "var(--pos)" }} /> High (85%+) {preview.confidence.high}</span>
            <span><span className="dot" style={{ background: "var(--warn)" }} /> Medium {preview.confidence.medium}</span>
            <span><span className="dot" style={{ background: "var(--neg)" }} /> Low (under 60%) {preview.confidence.low}</span>
          </div>
        </div>
      </Card>

      {preview.overlap.statements.length > 0 && !preview.duplicateStatement && (
        <Alert kind="warn">
          <b>This statement overlaps with existing data.</b>{" "}
          {preview.overlap.statements.map((o) => `${o.source === "GOOGLE_PAY" ? "Google Pay" : o.source} statement ${longDate(o.periodStart)} – ${longDate(o.periodEnd)}`).join("; ")}.
          {" "}You already have {preview.overlap.existingInPeriod} transactions in this period. Of this statement: <b>{c.duplicates}</b> already exist (skipped), <b>{c.matched}</b> are the same payment as one you already have (kept once, never double counted), <b>{c.potential}</b> need your decision and <b>{c.newEvents - c.potential}</b> are new.
        </Alert>
      )}

      <Card title="Reconciliation" sub={isWallet ? "Paid rows checked against the statement's own Sent total, and received rows against Received (self transfers are excluded by Google Pay)" : "Parsed rows checked against the bank's own STATEMENT SUMMARY and the running balance"} right={<Badge tone={st.tone}>{st.text}</Badge>}>
        {isWallet && rec.checks.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Check</th><th className="n">Statement says</th><th className="n">Parsed rows give</th><th className="n">Result</th></tr></thead>
              <tbody>
                {rec.checks.map((k) => (
                  <tr key={k.key}>
                    <td>{k.label}</td>
                    <td className="n">{k.official === undefined ? "—" : inr(k.official)}</td>
                    <td className="n">{k.calculated === undefined ? "—" : inr(k.calculated)}</td>
                    <td className="n">{k.ok === null ? <Badge>n/a</Badge> : k.ok ? <Badge tone="pos">match</Badge> : <Badge tone="neg">differs</Badge>}</td>
                  </tr>
                ))}
                {pt && pt.excludedSelfTransfers > 0 && <tr><td>Self transfers left out (as Google Pay does)</td><td className="n">—</td><td className="n">{inr(pt.excludedSelfTransfers)}</td><td className="n"><Badge>excluded</Badge></td></tr>}
              </tbody>
            </table>
          </div>
        ) : rec.official ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Check</th><th className="n">Statement says</th><th className="n">Parsed rows give</th><th className="n">Result</th></tr></thead>
              <tbody>
                {rec.checks.filter((k) => k.key !== "balanceChain").map((k) => {
                  const money = !/count/i.test(k.key);
                  const f = (v?: number) => (v === undefined ? "—" : money ? inr(v) : String(v));
                  return (
                    <tr key={k.key}>
                      <td>{k.label}</td>
                      <td className="n">{f(k.official)}</td>
                      <td className="n">{f(k.calculated)}</td>
                      <td className="n">{k.ok === null ? <Badge>n/a</Badge> : k.ok ? <Badge tone="pos">match</Badge> : <Badge tone="neg">differs</Badge>}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td>Running balance follows row by row</td><td className="n">—</td>
                  <td className="n">{rec.balanceChain.checked} rows checked</td>
                  <td className="n">{rec.balanceChain.breaks.length === 0 ? <Badge tone="pos">unbroken</Badge> : <Badge tone="neg">{rec.balanceChain.breaks.length} break(s)</Badge>}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <Alert kind="warn">{isWallet ? "The Sent / Received totals were not found, so this statement could not be reconciled." : <>The statement summary block was not found, so totals could not be checked against the bank&apos;s own figures.</>} Calculated closing balance: <b>{preview.calculatedClosingBalance !== undefined ? inr(preview.calculatedClosingBalance) : "—"}</b>. Running-balance check: {rec.balanceChain.breaks.length === 0 ? "unbroken" : `${rec.balanceChain.breaks.length} break(s)`}.</Alert>
        )}
        {rec.issues.length > 0 && (
          <div className="stack" style={{ marginTop: 12, gap: 8 }}>
            {rec.issues.map((i, k) => <Alert key={k} kind={rec.status === "mismatch" ? "error" : "warn"}>{i}</Alert>)}
          </div>
        )}
        {rec.balanceChain.breaks.length > 0 && (
          <div className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>
            First breaks: {rec.balanceChain.breaks.slice(0, 3).map((b) => `${b.date} (expected ${inr(b.expected)}, statement ${inr(b.actual)})`).join(" · ")}
          </div>
        )}
        {preview.requiresAcknowledgement && (
          <label className="check" style={{ marginTop: 14, padding: 12, border: "1px solid var(--out)", borderRadius: 10, background: "transparent" }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span><b>I have reviewed the differences above and want to import anyway.</b><span className="dim" style={{ display: "block", fontSize: 12.5 }}>Discarding and re-uploading is safer if the parse looks wrong.</span></span>
          </label>
        )}
        {error && <div style={{ marginTop: 12 }}><Alert kind="error">{error}</Alert></div>}
        {preview.duplicateStatement && <div style={{ marginTop: 12 }}><Alert kind="warn"><b>Duplicate statement.</b> This exact file was imported before, so there is nothing new to add.</Alert></div>}
        {nothingNew && !preview.duplicateStatement && <div style={{ marginTop: 12 }}><Alert kind="warn">Every transaction in this statement already exists in your history, so there is nothing new to import.</Alert></div>}
      </Card>

      {otherWarnings.length > 0 && (
        <Card title="Warnings">
          <div className="stack" style={{ gap: 8 }}>
            {otherWarnings.map((w, i) => <Alert key={i} kind="warn">{w}</Alert>)}
          </div>
        </Card>
      )}

      <Card flush>
        <div className="row spread wrap" style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <div className="seg">
            {([["all", `All (${c.total})`], ["new", `New (${c.new})`], ["review", `Needs review (${c.needsReview})`], ["refunds", `Refunds (${c.refunds})`], ["recurring", `Recurring (${c.recurringCandidates})`], ["dupes", `Duplicates (${c.duplicates})`], ...(c.matched + c.potential > 0 ? [["matched", `Cross-source (${c.matched + c.potential})`] as const] : [])] as const).map(([k, l]) => (
              <button key={k} className={filter === k ? "on" : ""} onClick={() => { setFilter(k); setPage(0); }}>{l}</button>
            ))}
          </div>
          {preview.truncated && <span className="faint" style={{ fontSize: 12 }}>Showing the first {preview.transactions.length} rows; all rows will be imported.</span>}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Narration / merchant</th><th className="hide-sm">Category</th><th className="hide-sm">Conf.</th><th className="n">Debit</th><th className="n">Credit</th><th className="n hide-sm">Balance</th></tr></thead>
            <tbody>
              {rows.slice(page * PAGE, page * PAGE + PAGE).map((r) => {
                const conf = confidenceLabel(r.confidence);
                const differs = r.valueDate && r.valueDate !== r.date;
                return (
                  <tr key={r.seq} className="clickable" style={{ opacity: r.isDuplicate ? 0.5 : 1 }} onClick={() => setOpen(open === r.seq ? null : r.seq)}>
                    <td style={{ whiteSpace: "nowrap" }}>{longDate(r.date)}{r.time && <div className="faint" style={{ fontSize: 11 }}>{r.time}</div>}{differs && <div className="faint" style={{ fontSize: 11 }} title="Value date differs from transaction date">value {longDate(r.valueDate!)}</div>}</td>
                    <td className="desc">
                      <b>{r.merchant} {r.isDuplicate && <Badge>duplicate</Badge>} {r.isRefund && <Badge tone="pos">refund</Badge>} {r.paymentMethod === "AUTOPAY" && <Badge tone="info">autopay</Badge>} {r.isRecurringCandidate && <Badge title="Candidate only - needs repeat payments to confirm">recurring?</Badge>} {r.needsReview && <Badge tone="warn" title={r.warnings.join("; ") || (r.semanticType === "PERSON_TO_PERSON" ? "Payment to a person: classify it yourself" : "Low confidence")}>review</Badge>} {r.match?.status === "matched" && <Badge tone="pos" title={r.match.reason}>same as {r.match.with.split(" · ")[0]}</Badge>} {r.match?.status === "potential" && <Badge tone="warn" title={`${r.match.reason} (${r.match.with})`}>possible match</Badge>} {r.semanticType === "SELF_TRANSFER" && <Badge tone="info">self transfer</Badge>}</b>
                      {open === r.seq ? (
                        <div className="mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11.5, marginTop: 4 }}>
                          {r.narrationLines.join("\n")}
                          {r.match ? `\n${r.match.status === "matched" ? "Same payment as" : "Might be the same as"}: ${r.match.with}` : ""}{"\n"}ref: {r.reference ?? "—"}{r.paymentProvider ? ` · via ${r.paymentProvider}` : ""} · merchant confidence {Math.round(r.merchantConfidence * 100)}%
                        </div>
                      ) : <span title={r.description}>{r.description}</span>}
                    </td>
                    <td className="hide-sm"><span className="row" style={{ gap: 7 }}><span className="dot" style={{ background: catColor(r.category) }} />{categoryLabel(r.category)}</span><span className="faint" style={{ fontSize: 11.5, marginLeft: 15 }}>{r.subcategory}</span></td>
                    <td className="hide-sm"><Badge tone={conf.tone}>{Math.round(r.confidence * 100)}%</Badge></td>
                    <td className="n neg">{r.debit ? inr(r.debit) : ""}</td>
                    <td className="n pos">{r.credit ? inr(r.credit) : ""}</td>
                    <td className="n faint hide-sm">{r.balance === undefined ? "—" : inr(r.balance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="dim" style={{ fontSize: 12.5 }}>{rows.length} row{rows.length === 1 ? "" : "s"} · click a row to see the original narration lines</span>
          <div className="row">
            <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="dim num" style={{ fontSize: 12.5 }}>{page + 1} / {pages}</span>
            <button className="btn sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em" }}>{label}</div>
      <div className={`num ${tone ?? ""}`} style={{ fontSize: 21, fontWeight: 650, marginTop: 4 }}>{value}</div>
      {sub && <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
