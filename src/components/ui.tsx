"use client";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/* --------------------------------- toasts --------------------------------- */
interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}
const ToastCtx = createContext<{ toast: (text: string, kind?: Toast["kind"]) => void }>({ toast: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, kind }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* --------------------------------- layout --------------------------------- */
export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

export function Card({
  title,
  sub,
  right,
  children,
  className = "",
  flush,
  glow,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  glow?: boolean;
}) {
  return (
    <section className={`card ${flush ? "flush" : ""} ${glow ? "glow" : ""} ${className}`}>
      {(title || right) && (
        <div className="card-head" style={flush ? { padding: "16px 18px 0" } : undefined}>
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  tone,
  delta,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "warn";
  delta?: { text: string; dir: "up" | "down" | "flat" } | null;
  icon?: ReactNode;
}) {
  return (
    <div className="card kpi fade-in">
      <div className="label">
        {icon}
        {label}
      </div>
      <div className={`value ${tone ?? ""}`}>{value}</div>
      <div className="sub row wrap" style={{ gap: 6 }}>
        {delta && <span className={`delta ${delta.dir}`}>{delta.text}</span>}
        {sub}
      </div>
    </div>
  );
}

export function Badge({ children, tone, title }: { children: ReactNode; tone?: "pos" | "neg" | "warn" | "info" | "demo"; title?: string }) {
  return (
    <span className={`badge ${tone ?? ""}`} title={title}>
      {children}
    </span>
  );
}

export function Estimate() {
  return (
    <span className="estt" title="Based on historical patterns - not a guarantee">
      Est
    </span>
  );
}

export function Skeleton({ h = 16, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

export function CardSkeleton({ h = 220 }: { h?: number }) {
  return (
    <div className="card">
      <Skeleton h={14} w="40%" />
      <div style={{ height: 14 }} />
      <Skeleton h={h} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Alert({ kind = "info", children, onClose }: { kind?: "error" | "warn" | "ok" | "info"; children: ReactNode; onClose?: () => void }) {
  const Icon = kind === "error" ? XCircle : kind === "warn" ? AlertTriangle : kind === "ok" ? CheckCircle2 : Info;
  return (
    <div className={`alert ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon />
      <div className="grow">{children}</div>
      {onClose && (
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={onClose} aria-label="Dismiss">
          <X />
        </button>
      )}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: { message: string }; retry?: () => void }) {
  return (
    <Alert kind="error">
      <div className="row spread">
        <span>{error.message}</span>
        {retry && (
          <button className="btn sm" onClick={retry}>
            Retry
          </button>
        )}
      </div>
    </Alert>
  );
}

export function Modal({ title, sub, onClose, children, wide }: { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row spread" style={{ alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h3>{title}</h3>
            {sub && <div className="dim" style={{ fontSize: 13 }}>{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode }) {
  return (
    <label className="row" style={{ alignItems: "flex-start", gap: 14, cursor: "pointer" }}>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      <span>
        <b style={{ fontWeight: 550 }}>{label}</b>
        {hint && <span className="dim" style={{ display: "block", fontSize: 12.5 }}>{hint}</span>}
      </span>
    </label>
  );
}

export function Progress({ value, status, mark }: { value: number; status?: "ok" | "warn" | "over"; mark?: number }) {
  return (
    <div className={`progress ${status === "warn" ? "warn" : status === "over" ? "over" : ""}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      {mark !== undefined && <span className="mark" style={{ left: `${Math.min(100, mark)}%` }} />}
    </div>
  );
}

export function CategoryDot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} />;
}
