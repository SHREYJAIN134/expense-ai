"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { CashFlowProjection } from "@/lib/analytics/projection";
import Onboarding from "@/components/Onboarding";
import { EstTag, PageTitle, SafeToSpendBlock } from "@/components/ll";
import Strip, { StripLegend } from "@/components/strip";
import { Alert, ErrorState, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import { inr, inrCompact, longDate, shortDate } from "@/lib/client/format";
import type { StripData } from "@/lib/services/strip";
import { BudgetsSection } from "./budgets";
import { ForecastCard, RecurringSection } from "./recurring";

function Section({ id, lab, title, sub, children }: { id?: string; lab: string; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} style={{ marginTop: 44, borderTop: "1px solid var(--ink)", paddingTop: 18, scrollMarginTop: 80 }}>
      <span className="lab">{lab}</span>
      <h2 className="serif" style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-.02em", marginTop: 4 }}>{title}</h2>
      {sub && <p className="dim" style={{ marginTop: 4, maxWidth: "70ch" }}>{sub}</p>}
      <div style={{ marginTop: 18 }}>{children}</div>
    </section>
  );
}

export default function AheadPage() {
  const ov = useApi<{ hasData: boolean }>("/api/analytics/overview");
  const strip = useApi<{ strip: StripData | null }>(ov.data?.hasData ? "/api/analytics/strip?view=month" : null);
  const proj = useApi<CashFlowProjection>(ov.data?.hasData ? "/api/intelligence/projection" : null);

  if (ov.error) return <ErrorState error={ov.error} retry={ov.reload} />;
  if (ov.loading && !ov.data) return <div className="stack"><Skeleton h={50} w={200} /><Skeleton h={260} /></div>;
  if (!ov.data?.hasData) return <Onboarding onLoaded={ov.reload} />;

  const s = strip.data?.strip ?? null;
  const p = proj.data;

  return (
    <div className="fade-in">
      <PageTitle lab="Lens" title="Ahead" sub={<>Everything forward-looking on this page is an <b>estimate</b> from your own past patterns and the obligations you entered. It is drawn hatched so it is never mistaken for a statement figure.</>}>
        <EstTag>estimates, not guarantees</EstTag>
      </PageTitle>

      {p && p.staleDays > 3 && <div style={{ marginBottom: 16 }}><Alert kind="warn">{p.assumptions[0]} <Link href="/bring-in" style={{ textDecoration: "underline", fontWeight: 600 }}>Bring in a newer statement</Link></Alert></div>}

      <div className="ahead-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 48 }}>
        <div style={{ minWidth: 0 }}>
          <div className="lab">Balance · actual, then estimated</div>
          <div style={{ marginTop: 6 }}>
            {strip.error ? <ErrorState error={strip.error} retry={strip.reload} /> : !s ? <Skeleton h={280} /> : <Strip data={s} />}
          </div>
          <div style={{ marginTop: 10 }}><StripLegend estimate /></div>

          <div className="lab" style={{ marginTop: 26 }}>Where the balance is heading</div>
          {proj.error ? <ErrorState error={proj.error} retry={proj.reload} /> : !p ? <Skeleton h={100} style={{ marginTop: 8 }} /> : p.balance === null ? (
            <p className="dim" style={{ marginTop: 8 }}>Your statements don’t include a running balance, so projected balances can’t be shown.</p>
          ) : (
            <>
              <div className="ahead-tiles" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12, marginTop: 8 }}>
                {p.horizons.map((h) => (
                  <div key={h.days} style={{ padding: "14px 16px", border: "1px dashed var(--est)", borderRadius: 12, background: "color-mix(in srgb, var(--est) 5%, transparent)" }}>
                    <div className="row spread"><span className="lab" style={{ color: "var(--est)" }}>+{h.days} days</span><span className="faint" style={{ fontSize: 12 }}>{shortDate(h.to)}</span></div>
                    <div className="serif estc" style={{ fontSize: 30, letterSpacing: "-.02em", marginTop: 6 }}>{h.likelyBalance === null ? "n/a" : `≈ ${inr(Math.round(h.likelyBalance / 100) * 100)}`}</div>
                    <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{h.likelyLow !== null ? `range ${inrCompact(h.likelyLow)} – ${inrCompact(h.likelyHigh!)}` : ""}</div>
                    <div className="mono" style={{ fontSize: 11.5, marginTop: 8, color: "var(--ink2)", lineHeight: 1.6 }}>
                      {h.expectedCredits > 0 && <div>+ {inr(h.expectedCredits)} expected in</div>}
                      <div>− {inr(h.expectedRecurring)} bills{h.knownObligations > 0 ? ` (${inrCompact(h.knownObligations)} entered by you)` : ""}</div>
                      <div>− {inr(h.everydaySpending.expected)} everyday</div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>
                Actual balance: <b className="mono" style={{ color: "var(--ink)" }}>{inr(p.balance)}</b>{p.balanceAsOf ? ` as of ${longDate(p.balanceAsOf)}` : ""}. Projected figures never replace it. Confidence: <b>{p.confidence}</b>. {p.disclaimer}
              </p>
            </>
          )}
        </div>

        <aside style={{ borderLeft: "1px solid var(--hair)", paddingLeft: 32 }} className="now-aside">
          <SafeToSpendBlock size={48} />
          {p && p.assumptions.length > 0 && (
            <details style={{ marginTop: 20 }}>
              <summary className="dim" style={{ cursor: "pointer", fontSize: 13 }}>Assumptions behind these estimates</summary>
              <ul className="dim" style={{ fontSize: 12.5, margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>{p.assumptions.map((a, i) => <li key={i} style={{ marginBottom: 4 }}>{a}</li>)}</ul>
            </details>
          )}
          <p className="faint" style={{ fontSize: 12, marginTop: 16 }}>Change the buffer and what counts as recurring in the <Link href="/vault#intelligence" style={{ textDecoration: "underline" }}>Vault</Link>.</p>
        </aside>
      </div>

      <Section id="upcoming" lab="Recurring & upcoming" title="What is likely to leave next" sub="Detected from your history and combined with what you enter. Fixed, variable and AutoPay payments are labelled, with a next expected date and a confidence.">
        <RecurringSection />
      </Section>

      <Section id="what-if" lab="What if" title="Try a planned spend" sub="Add a one-off amount and see how the estimated remaining cash moves.">
        <ForecastCard />
      </Section>

      <Section id="budgets" lab="Budgets & goals" title="Limits and savings targets" sub="Solid is what you have spent so far; hatched is where your current pace is heading.">
        <BudgetsSection />
      </Section>
    </div>
  );
}
