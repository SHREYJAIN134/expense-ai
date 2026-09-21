"use client";
import { ChevronLeft, ChevronRight, Download, Repeat, Search, SlidersHorizontal, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import type { TxnRow } from "@/lib/services/transactions";
import { Glyph, PageTitle, Twin } from "@/components/ll";
import { isMoved, TransactionDrawer, type TxnOptions } from "@/components/txn-drawer";
import { Empty, ErrorState, Field, Skeleton } from "@/components/ui";
import { qs, useApi } from "@/lib/client/api";
import { categoryLabel, inr, longDate } from "@/lib/client/format";

interface ListRes { rows: TxnRow[]; total: number; page: number; pageSize: number; pages: number; totals: { debits: number; credits: number } }

interface Filters {
  q: string; from: string; to: string; category: string; merchant: string; direction: string;
  minAmount: string; maxAmount: string; lowConfidence: boolean; statementId: string; source: string; potential: boolean; flag: "" | "refund" | "recurring" | "moved";
  sort: "date" | "amount" | "merchant" | "category"; dir: "asc" | "desc"; page: number; pageSize: number;
}

const fromParams = (sp: URLSearchParams): Filters => ({
  q: sp.get("q") ?? "", from: sp.get("from") ?? "", to: sp.get("to") ?? "", category: sp.get("category") ?? "", merchant: sp.get("merchant") ?? "",
  direction: sp.get("direction") ?? "", minAmount: "", maxAmount: "", lowConfidence: sp.get("lowConfidence") === "1", statementId: sp.get("statementId") ?? "",
  source: sp.get("source") ?? "", potential: sp.get("matchStatus") === "potential", flag: (["refund", "recurring", "moved"].includes(sp.get("flag") ?? "") ? sp.get("flag") : "") as Filters["flag"],
  sort: "date", dir: "desc", page: 1, pageSize: 50,
});

const SORTS: { label: string; sort: Filters["sort"]; dir: Filters["dir"] }[] = [
  { label: "Newest first", sort: "date", dir: "desc" },
  { label: "Oldest first", sort: "date", dir: "asc" },
  { label: "Largest first", sort: "amount", dir: "desc" },
  { label: "Smallest first", sort: "amount", dir: "asc" },
  { label: "Merchant A–Z", sort: "merchant", dir: "asc" },
  { label: "Category", sort: "category", dir: "asc" },
];

export default function LedgerPage() {
  return (
    <Suspense fallback={<Skeleton h={420} />}>
      <Ledger />
    </Suspense>
  );
}

const SOURCE_NAME: Record<string, string> = { HDFC: "HDFC", GOOGLE_PAY: "Google Pay" };

function Ledger() {
  const sp = useSearchParams();
  const spKey = sp.toString();
  const [f, setF] = useState<Filters>(() => fromParams(sp));
  const [search, setSearch] = useState(f.q);
  const [showFilters, setShowFilters] = useState(false);
  const [openId, setOpenId] = useState<string | null>(sp.get("open"));
  const opts = useApi<TxnOptions>("/api/transactions/options");

  // Links from other lenses (traces, ⌘K, signals) change the query string while this page stays mounted.
  useEffect(() => {
    const next = fromParams(new URLSearchParams(spKey));
    setF(next);
    setSearch(next.q);
    setOpenId(new URLSearchParams(spKey).get("open"));
  }, [spKey]);

  useEffect(() => {
    const t = setTimeout(() => setF((s) => (s.q === search ? s : { ...s, q: search, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const query = useMemo(
    () => qs({ q: f.q, from: f.from, to: f.to, category: f.category, merchant: f.merchant, direction: f.direction, minAmount: f.minAmount, maxAmount: f.maxAmount, lowConfidence: f.lowConfidence ? "1" : "", source: f.source, matchStatus: f.potential ? "potential" : "", flag: f.flag, statementId: f.statementId, sort: f.sort, dir: f.dir, page: f.page, pageSize: f.pageSize }),
    [f],
  );
  const list = useApi<ListRes>(`/api/transactions${query}`);
  const set = (patch: Partial<Filters>) => setF((s) => ({ ...s, ...patch, page: patch.page ?? 1 }));

  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (f.from && f.from === f.to) chips.push({ key: "day", label: longDate(f.from), clear: () => set({ from: "", to: "" }) });
  else {
    if (f.from) chips.push({ key: "from", label: `from ${longDate(f.from)}`, clear: () => set({ from: "" }) });
    if (f.to) chips.push({ key: "to", label: `to ${longDate(f.to)}`, clear: () => set({ to: "" }) });
  }
  if (f.category) chips.push({ key: "cat", label: categoryLabel(f.category), clear: () => set({ category: "" }) });
  if (f.merchant) chips.push({ key: "mer", label: f.merchant, clear: () => set({ merchant: "" }) });
  if (f.direction) chips.push({ key: "dir", label: f.direction === "debit" ? "Out only" : "In only", clear: () => set({ direction: "" }) });
  if (f.source) chips.push({ key: "src", label: SOURCE_NAME[f.source] ?? f.source, clear: () => set({ source: "" }) });
  if (f.statementId) chips.push({ key: "stm", label: "one statement", clear: () => set({ statementId: "" }) });
  if (f.minAmount) chips.push({ key: "min", label: `≥ ₹${f.minAmount}`, clear: () => set({ minAmount: "" }) });
  if (f.maxAmount) chips.push({ key: "max", label: `≤ ₹${f.maxAmount}`, clear: () => set({ maxAmount: "" }) });
  if (f.q) chips.push({ key: "q", label: `“${f.q}”`, clear: () => { setSearch(""); set({ q: "" }); } });

  const quick = [
    { key: "review", label: "Needs review", on: f.lowConfidence, toggle: () => set({ lowConfidence: !f.lowConfidence }) },
    { key: "dup", label: "Possible duplicates", on: f.potential, toggle: () => set({ potential: !f.potential }) },
    { key: "refund", label: "Refunds", on: f.flag === "refund", toggle: () => set({ flag: f.flag === "refund" ? "" : "refund" }) },
    { key: "recurring", label: "Recurring", on: f.flag === "recurring", toggle: () => set({ flag: f.flag === "recurring" ? "" : "recurring" }) },
    { key: "moved", label: "Moved, not spent", on: f.flag === "moved", toggle: () => set({ flag: f.flag === "moved" ? "" : "moved" }) },
  ];
  const anyFilter = chips.length > 0 || quick.some((c) => c.on);
  function reset() {
    setSearch("");
    setF({ ...fromParams(new URLSearchParams()), sort: f.sort, dir: f.dir, pageSize: f.pageSize });
  }

  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const grouped = f.sort === "date";
  const groups = useMemo(() => {
    if (!grouped) return [{ date: "", rows }];
    const out: { date: string; rows: TxnRow[] }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.date === r.date) last.rows.push(r);
      else out.push({ date: r.date, rows: [r] });
    }
    return out;
  }, [rows, grouped]);
  const pages = list.data?.pages ?? 1;
  const page = list.data?.page ?? 1;

  return (
    <div className="fade-in">
      <PageTitle lab="Lens" title="Ledger" sub="Every payment is one event, whichever statements reported it. Tap a row to see where it came from.">
        <a className="btn ghost" href={`/api/export/transactions${query.replace(/[?&](page|pageSize)=\d+/g, "").replace(/^&/, "?")}`}><Download /> Export CSV</a>
      </PageTitle>

      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <label style={{ position: "relative", flex: "1 1 280px" }}>
          <Search size={16} style={{ position: "absolute", left: 14, top: 12, color: "var(--ink3)" }} />
          <input className="input" style={{ paddingLeft: 38, borderRadius: 999, height: 40 }} placeholder="Search merchant, description, notes, reference…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search transactions" />
        </label>
        <button className={`btn ${showFilters ? "solid" : ""}`} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}><SlidersHorizontal /> Filters</button>
        <select className="select" style={{ width: 160, borderRadius: 999 }} value={`${f.sort}:${f.dir}`} onChange={(e) => { const [sort, dir] = e.target.value.split(":") as [Filters["sort"], Filters["dir"]]; set({ sort, dir }); }} aria-label="Sort">
          {SORTS.map((s) => <option key={s.label} value={`${s.sort}:${s.dir}`}>{s.label}</option>)}
        </select>
      </div>

      <div className="row wrap chiprow" style={{ gap: 8, marginTop: 12 }}>
        {chips.map((c) => <button key={c.key} className="chip on" onClick={c.clear} aria-label={`Remove filter ${c.label}`}>{c.label} <X size={12} /></button>)}
        {quick.map((c) => <button key={c.key} className={`chip ${c.on ? "on" : ""}`} aria-pressed={c.on} onClick={c.toggle}>{c.label}</button>)}
        {anyFilter && <button className="chip" onClick={reset}>Clear all</button>}
      </div>

      {showFilters && (
        <div className="sheet fade-in" style={{ padding: 16, marginTop: 12 }}>
          <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            <Field label="From"><input className="input" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></Field>
            <Field label="To"><input className="input" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></Field>
            <Field label="Direction">
              <select className="select" value={f.direction} onChange={(e) => set({ direction: e.target.value })}>
                <option value="">In and out</option><option value="debit">Out only</option><option value="credit">In only</option>
              </select>
            </Field>
            <Field label="Category">
              <select className="select" value={f.category} onChange={(e) => set({ category: e.target.value })}>
                <option value="">All</option>
                {opts.data?.categories.map((c) => <option key={c.name} value={c.name}>{categoryLabel(c.name)}</option>)}
              </select>
            </Field>
            <Field label="Merchant">
              <input className="input" list="merchant-list" value={f.merchant} onChange={(e) => set({ merchant: e.target.value })} placeholder="Any" />
              <datalist id="merchant-list">{opts.data?.merchants.slice(0, 200).map((m) => <option key={m} value={m} />)}</datalist>
            </Field>
            <Field label="Min amount (₹)"><input className="input" type="number" min={0} value={f.minAmount} onChange={(e) => set({ minAmount: e.target.value })} /></Field>
            <Field label="Max amount (₹)"><input className="input" type="number" min={0} value={f.maxAmount} onChange={(e) => set({ maxAmount: e.target.value })} /></Field>
            <Field label="Source">
              <select className="select" value={f.source} onChange={(e) => set({ source: e.target.value })}>
                <option value="">All sources</option><option value="HDFC">HDFC</option><option value="GOOGLE_PAY">Google Pay</option>
              </select>
            </Field>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, borderTop: "1px solid var(--hair)" }}>
        {list.error ? (
          <div style={{ marginTop: 16 }}><ErrorState error={list.error} retry={list.reload} /></div>
        ) : !list.data ? (
          <div className="stack" style={{ padding: 18 }}>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={44} />)}</div>
        ) : rows.length === 0 ? (
          <Empty title="No transactions match">Try widening the dates or clearing a filter.{anyFilter && <><br /><button className="btn sm" style={{ marginTop: 12 }} onClick={reset}>Clear all filters</button></>}</Empty>
        ) : (
          <div style={{ opacity: list.loading ? 0.55 : 1, transition: "opacity .15s" }}>
            {groups.map((g, gi) => {
              const complete = !(gi === 0 && page > 1) && !(gi === groups.length - 1 && page < pages);
              const out = g.rows.filter((r) => r.direction === "debit").reduce((a, r) => a + r.amount, 0);
              const inn = g.rows.filter((r) => r.direction === "credit").reduce((a, r) => a + r.amount, 0);
              return (
                <Fragment key={g.date || "flat"}>
                  {grouped && (
                    <div className="dayhead">
                      <span className="row" style={{ gap: 8 }}>
                        <b>{new Date(g.date + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</b>
                        <span className="faint" style={{ fontSize: 12.5 }}>{g.rows.length} event{g.rows.length === 1 ? "" : "s"}{!complete ? " on this page" : ""}</span>
                      </span>
                      {complete && <span className="mono" style={{ fontSize: 12 }}><span className="out">−{inr(out)}</span>{inn > 0 && <> <span className="in">+{inr(inn)}</span></>}</span>}
                    </div>
                  )}
                  {g.rows.map((r) => <Row key={r.id} r={r} selected={openId === r.id} flat={!grouped} onOpen={() => setOpenId(r.id)} />)}
                </Fragment>
              );
            })}
          </div>
        )}
        {list.data && (
          <div className="pager" style={{ borderTop: "1px solid var(--hair)" }}>
            <span className="dim" style={{ fontSize: 12.5 }}>
              {list.data.total.toLocaleString("en-IN")} event{list.data.total === 1 ? "" : "s"} · out <b className="out">{inr(list.data.totals.debits)}</b> · in <b className="in">{inr(list.data.totals.credits)}</b>
            </span>
            <div className="row">
              <select className="select" style={{ width: 110, borderRadius: 999 }} value={f.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) })} aria-label="Rows per page">
                {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <button className="icon-btn" disabled={page <= 1} onClick={() => set({ page: page - 1 })} aria-label="Previous page"><ChevronLeft /></button>
              <span className="dim num" style={{ fontSize: 12.5 }}>{page} / {pages}</span>
              <button className="icon-btn" disabled={page >= pages} onClick={() => set({ page: page + 1 })} aria-label="Next page"><ChevronRight /></button>
            </div>
          </div>
        )}
      </div>

      {openId && <TransactionDrawer id={openId} options={opts.data} onClose={() => setOpenId(null)} onSaved={list.reload} />}
    </div>
  );
}

function Row({ r, selected, flat, onOpen }: { r: TxnRow; selected: boolean; flat: boolean; onOpen: () => void }) {
  const moved = isMoved(r);
  const multi = r.eventSources.length > 1;
  const name = r.merchant || r.description || "Unknown";
  return (
    <button className={`txrow ${selected ? "sel" : ""}`} onClick={onOpen} aria-label={`${name}, ${r.direction === "credit" ? "received" : "paid"} ${inr(r.amount)}, ${longDate(r.date)}`}>
      <Glyph name={name} category={r.category} size={38} />
      <span style={{ minWidth: 0 }}>
        <span className="nm">
          <span>{name}</span>
          {r.needsReview && !r.userEdited && <span className="tag hlt" style={{ height: 18, fontSize: 10.5 }}>review</span>}
          {r.isRefund && <span className="tag" style={{ height: 18, fontSize: 10.5 }}>refund</span>}
          {r.semanticType === "REFUND_REQUIRES_REVIEW" && <span className="tag hlt" style={{ height: 18, fontSize: 10.5 }}>refund: review</span>}
          {r.matchStatus === "potential" && <span className="tag hlt" style={{ height: 18, fontSize: 10.5 }} title="Might be the same payment as an entry from another source">possible duplicate</span>}
          {r.semanticType === "SELF_TRANSFER" && <span className="tag" style={{ height: 18, fontSize: 10.5 }}>own account</span>}
          {r.paymentMethod === "AUTOPAY" && <span className="tag" style={{ height: 18, fontSize: 10.5 }}>AutoPay</span>}
          {r.unusual && <span className="tag hlt" style={{ height: 18, fontSize: 10.5 }} title={r.unusual.reason}>unusual</span>}
        </span>
        <span className="sub">
          {flat && <span>{longDate(r.date)} ·</span>}
          {r.time && <span className="mono">{r.time}</span>}
          <span>{r.time ? "·" : ""} {moved ? `${categoryLabel(r.category)} · moved` : categoryLabel(r.category)}</span>
          {r.isRecurring && <Repeat size={11} aria-label="Recurring" />}
          <span>·</span>
          {multi ? <><Twin title={`Seen in ${r.eventSources.map((x) => SOURCE_NAME[x] ?? x).join(" and ")} — counted once`} /><span>{r.eventSources.map((x) => SOURCE_NAME[x] ?? x).join(" + ")}</span></> : <span>{SOURCE_NAME[r.eventSources[0]] ?? r.eventSources[0]}</span>}
        </span>
      </span>
      <span className={`amt ${r.direction === "credit" ? "cr" : moved ? "mv" : ""}`}>{r.direction === "credit" ? "+" : "−"}{inr(r.amount)}</span>
    </button>
  );
}
