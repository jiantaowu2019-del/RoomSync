export type Member = { id: number; display_name: string };
export type Session = { viewer: Member; other_member: Member };
export type ExpenseRow = {
  id: number;
  description: string;
  original_payer: string;
  total_minor: number;
  outstanding_minor: number;
  status: "OPEN" | "SETTLED";
  created_at: string;
};
export type Payment = {
  id: number;
  amount_minor: number;
  status: "REPORTED" | "REJECTED" | "CONFIRMED";
  reason: string | null;
};
export type Share = {
  id: number;
  debtor_id: number;
  debtor: string;
  recipient: string;
  outstanding_minor: number;
  status: "UNPAID" | "PAYMENT_REPORTED" | "SETTLED";
  payment_url: string | null;
  payments: Payment[];
};
export type Expense = ExpenseRow & {
  other_member: string;
  shares: Share[];
  audit: { id: number; actor: string; kind: string; created_at: string }[];
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api" + path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const fallback = response.status === 422 ? "Check the submitted values." : "The request could not be completed.";
    throw new ApiError(response.status, typeof body?.detail === "string" ? body.detail : fallback);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function submit<T>(path: string, body: string, key?: string): Promise<T> {
  return api<T>(path, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
  });
}

export function parseCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

export function money(cents: number): string {
  const dollars = Math.floor(cents / 100);
  return "$" + dollars.toLocaleString("en-US") + "." + String(cents - dollars * 100).padStart(2, "0");
}
