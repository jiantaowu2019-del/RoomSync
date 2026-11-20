import { api, ApiError, parseCents, submit, type Expense, type Share } from "./api";

export type PaymentDraft = { amount: string; key: string; attempted: boolean };
export type PaymentJump = {
  id: string; actorId: number; groupId: number | null; expenseId: number;
  shareId: number; amountMinor: number; requestKey: string; prompted: boolean;
};

const draftKey = (actorId: number, expenseId: number, shareId: number) =>
  `roomsync:payment:${actorId}:${expenseId}:${shareId}`;
const jumpKey = (actorId: number) => `roomsync:payment-return:${actorId}`;

export function amountText(minor: number) {
  return Math.floor(minor / 100) + "." + String(minor % 100).padStart(2, "0");
}

export function readPaymentDraft(actorId: number, expenseId: number, shareId: number): PaymentDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(actorId, expenseId, shareId)) ?? "null");
    if (value && typeof value.amount === "string" && typeof value.key === "string" && typeof value.attempted === "boolean") {
      return value;
    }
  } catch { /* A malformed local draft can be re-entered. */ }
  return null;
}

export function savePaymentDraft(actorId: number, expenseId: number, shareId: number, draft: PaymentDraft) {
  sessionStorage.setItem(draftKey(actorId, expenseId, shareId), JSON.stringify(draft));
}

export async function reportPayment(actorId: number, expenseId: number, shareId: number, draft: PaymentDraft) {
  const amount = parseCents(draft.amount);
  if (amount === null) throw new ApiError(422, "Enter a positive USD amount with up to two decimal places.");
  savePaymentDraft(actorId, expenseId, shareId, { ...draft, attempted: true });
  let result: { id: number; status: string };
  try {
    result = await submit(`/shares/${shareId}/payments`, JSON.stringify({ amount_minor: amount }), draft.key);
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      savePaymentDraft(actorId, expenseId, shareId, { ...draft, attempted: false });
    }
    throw error;
  }
  const current = readPaymentDraft(actorId, expenseId, shareId);
  if (current?.key === draft.key) sessionStorage.removeItem(draftKey(actorId, expenseId, shareId));
  return result;
}

export function rememberPaymentJump(actorId: number, expense: Expense, share: Share, draft: PaymentDraft) {
  const amountMinor = parseCents(draft.amount);
  if (amountMinor === null) throw new Error("Invalid payment draft.");
  savePaymentDraft(actorId, expense.id, share.id, draft);
  const jump: PaymentJump = {
    id: crypto.randomUUID(), actorId, groupId: expense.group_id, expenseId: expense.id,
    shareId: share.id, amountMinor, requestKey: draft.key, prompted: false,
  };
  sessionStorage.setItem(jumpKey(actorId), JSON.stringify(jump));
}

export function readPaymentJump(actorId: number): PaymentJump | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(jumpKey(actorId)) ?? "null");
    if (value && value.actorId === actorId && typeof value.id === "string" &&
        typeof value.requestKey === "string" && typeof value.prompted === "boolean" &&
        [value.expenseId, value.shareId, value.amountMinor].every(n => Number.isSafeInteger(n) && n > 0) &&
        (value.groupId === null || Number.isSafeInteger(value.groupId) && value.groupId > 0)) return value;
  } catch { /* Ignore malformed tab-local metadata. */ }
  return null;
}

export function markJumpPrompted(jump: PaymentJump) {
  const current = readPaymentJump(jump.actorId);
  if (current?.id === jump.id) sessionStorage.setItem(jumpKey(jump.actorId), JSON.stringify({ ...jump, prompted: true }));
}

export function expenseAddress(groupId: number | null, expenseId: number) {
  return (groupId === null ? "/history" : `/groups/${groupId}`) + `?expense=${expenseId}`;
}

export async function readJumpExpense(jump: PaymentJump) {
  const expense = await api<Expense>("/expenses/" + jump.expenseId);
  const share = expense.shares.find(share => share.id === jump.shareId);
  if (expense.group_id !== jump.groupId || !share || share.debtor_id !== jump.actorId) {
    throw new ApiError(404, "The original payment share is unavailable.");
  }
  return { expense, share };
}
