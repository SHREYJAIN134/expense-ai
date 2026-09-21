import { getDb, uid } from "../db/client";
import { ApiError } from "../auth/guard";
import { todayISO, type ISODate } from "../util/dates";
import { dataRange, loadAllTxns } from "../services/data";
import { getSettings } from "../services/users";
import { answerQuery, type Answer } from "./answer";
import { parseQuestion, type Intent, type QueryContext } from "./intent";
import { narrate } from "./llm";
import type { ResolvedPeriod } from "./period";

interface SessionContext {
  last?: { intent: Intent; category?: string; subcategory?: string; merchant?: string; direction?: "debit" | "credit"; period?: ResolvedPeriod | null; focusDates?: string[] };
}

export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  intent?: string | null;
  table?: Answer["table"];
  calculation?: string[];
  suggestions?: string[];
  usedLlm?: boolean;
  createdAt: string;
}

function distinctMerchants(userId: string): string[] {
  const seen = new Map<string, number>();
  for (const t of loadAllTxns(userId)) seen.set(t.merchant, (seen.get(t.merchant) ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 600).map(([m]) => m);
}

export function personNames(userId: string): string[] {
  const names = new Set<string>();
  for (const t of loadAllTxns(userId)) if (t.category === "TRANSFERS" && !/^unidentified/i.test(t.merchant)) names.add(t.merchant);
  // Google Pay rows the app could not tell apart from a person (single-word names) are treated as people too.
  for (const r of getDb().prepare("SELECT merchant, counterparty_raw FROM transactions WHERE user_id = ? AND semantic_type IN ('PERSON_TO_PERSON','UNKNOWN_COUNTERPARTY','POSSIBLE_SELF_TRANSFER','SELF_TRANSFER')").all(userId) as { merchant: string | null; counterparty_raw: string | null }[]) {
    if (r.merchant) names.add(r.merchant);
    if (r.counterparty_raw) names.add(r.counterparty_raw);
  }
  return [...names];
}

export async function chatTurn(userId: string, input: { sessionId?: string | null; message: string }, today: ISODate = todayISO()) {
  const db = getDb();
  const message = input.message.trim();
  if (!message) throw new ApiError(400, "EMPTY", "Please type a question.");
  if (message.length > 1000) throw new ApiError(400, "TOO_LONG", "Questions are limited to 1000 characters.");

  let sessionId = input.sessionId ?? null;
  let ctx: SessionContext = {};
  if (sessionId) {
    const s = db.prepare("SELECT id, context_json FROM chat_sessions WHERE id = ? AND user_id = ?").get(sessionId, userId) as { id: string; context_json: string | null } | undefined;
    if (!s) throw new ApiError(404, "NOT_FOUND", "Chat session not found.");
    ctx = s.context_json ? (JSON.parse(s.context_json) as SessionContext) : {};
  } else {
    sessionId = uid();
    db.prepare("INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)").run(sessionId, userId, message.slice(0, 60));
  }

  const settings = getSettings(userId);
  const qctx: QueryContext = { today, monthStartDay: settings.monthStartDay, merchants: distinctMerchants(userId), dataRange: dataRange(userId), last: ctx.last };
  const parsed = parseQuestion(message, qctx);
  // Financial facts always come from the CURRENT database, never from earlier chat messages.
  const answer = answerQuery(userId, parsed, today);
  // People the user paid are never sent to the AI provider (see privacy.ts); they are swapped for placeholders.
  const { text, usedLlm } = await narrate(message, answer, settings.aiNarration, { redactNames: personNames(userId) });

  const userMsgId = uid();
  const asstMsgId = uid();
  db.transaction(() => {
    db.prepare("INSERT INTO chat_messages (id, session_id, user_id, role, content) VALUES (?, ?, ?, 'user', ?)").run(userMsgId, sessionId, userId, message);
    db.prepare("INSERT INTO chat_messages (id, session_id, user_id, role, content, intent, data_json, used_llm) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)").run(
      asstMsgId, sessionId, userId, text, answer.intent, JSON.stringify({ facts: answer.facts, table: answer.table, calculation: answer.calculation, suggestions: answer.suggestions }), usedLlm ? 1 : 0,
    );
    const next: SessionContext = answer.intent !== "unknown" ? { last: { intent: answer.intent, category: parsed.category, subcategory: parsed.subcategory, merchant: parsed.merchant, direction: parsed.direction, period: parsed.period, focusDates: answer.focusDates } } : ctx;
    db.prepare("UPDATE chat_sessions SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(next), sessionId);
  })();

  return {
    sessionId: sessionId!,
    intent: answer.intent,
    message: { id: asstMsgId, role: "assistant" as const, content: text, intent: answer.intent, table: answer.table, calculation: answer.calculation, suggestions: answer.suggestions, usedLlm, createdAt: new Date().toISOString() },
    understood: { intent: parsed.intent, category: parsed.category, merchant: parsed.merchant, period: parsed.period?.label ?? null, from: parsed.period?.from ?? null, to: parsed.period?.to ?? null, direction: parsed.direction ?? null, focusDates: answer.focusDates ?? [], followUp: parsed.followUp },
  };
}

export function listSessions(userId: string) {
  return getDb()
    .prepare("SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 50")
    .all(userId) as { id: string; title: string; created_at: string; updated_at: string }[];
}

export function getSession(userId: string, id: string): { id: string; title: string; messages: ChatMessageDto[] } {
  const db = getDb();
  const s = db.prepare("SELECT id, title FROM chat_sessions WHERE id = ? AND user_id = ?").get(id, userId) as { id: string; title: string } | undefined;
  if (!s) throw new ApiError(404, "NOT_FOUND", "Chat session not found.");
  const rows = db
    .prepare("SELECT id, role, content, intent, data_json, used_llm, created_at FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY rowid")
    .all(id, userId) as any[];
  return {
    ...s,
    messages: rows.map((r) => {
      const data = r.data_json ? JSON.parse(r.data_json) : {};
      return { id: r.id, role: r.role, content: r.content, intent: r.intent, table: data.table, calculation: data.calculation, suggestions: data.suggestions, usedLlm: !!r.used_llm, createdAt: r.created_at };
    }),
  };
}

export function deleteSession(userId: string, id: string) {
  const r = getDb().prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?").run(id, userId);
  if (!r.changes) throw new ApiError(404, "NOT_FOUND", "Chat session not found.");
}
