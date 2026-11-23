import { ApiError, parseCents, submit } from "./api";

export type StatementDraft = { key: string; amount: string; text: string; attempted: boolean };
const storageKey = (actorId: number, path: string) => `roomsync:statement:${actorId}:${path}`;

export function emptyStatement(): StatementDraft {
  return { key: crypto.randomUUID(), amount: "", text: "", attempted: false };
}

export function readStatement(actorId: number, path: string): StatementDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(actorId, path)) ?? "null");
    if (value && [value.key, value.amount, value.text].every(item => typeof item === "string") &&
        typeof value.attempted === "boolean") return value;
  } catch { /* A malformed local draft can be entered again. */ }
  return null;
}

export function saveStatement(actorId: number, path: string, draft: StatementDraft) {
  sessionStorage.setItem(storageKey(actorId, path), JSON.stringify(draft));
}

export async function submitStatement(actorId: number, path: string, draft: StatementDraft) {
  const opening = path.endsWith("/disputes");
  const body = opening ? { amount_minor: parseCents(draft.amount), reason: draft.text.trim() }
    : { body: draft.text.trim() };
  saveStatement(actorId, path, { ...draft, attempted: true });
  try {
    await submit(path, JSON.stringify(body), draft.key);
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) saveStatement(actorId, path, { ...draft, attempted: false });
    throw error;
  }
  if (readStatement(actorId, path)?.key === draft.key) sessionStorage.removeItem(storageKey(actorId, path));
}
