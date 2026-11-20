import { useState, type FormEvent } from "react";
import { money, parseCents, type Expense, type Share } from "./api";
import {
  amountText, readPaymentDraft, rememberPaymentJump, savePaymentDraft, type PaymentDraft,
} from "./paymentDraft";

export function PaymentReportForm({ actorId, expense, share, busy, report }: {
  actorId: number; expense: Expense; share: Share; busy: boolean;
  report: (shareId: number, draft: PaymentDraft) => Promise<boolean>;
}) {
  const defaultDraft = () => ({
    amount: amountText(share.outstanding_minor), key: crypto.randomUUID(), attempted: false,
  });
  const [draft, setDraft] = useState<PaymentDraft>(() =>
    readPaymentDraft(actorId, expense.id, share.id) ?? defaultDraft());
  const [error, setError] = useState("");
  const amount = parseCents(draft.amount);
  const unresolved = draft.attempted;
  const canReport = amount !== null && amount <= share.outstanding_minor && !share.payment_pending && share.outstanding_minor > 0;

  async function send(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (await report(share.id, draft)) setDraft(defaultDraft());
    else setDraft(readPaymentDraft(actorId, expense.id, share.id) ?? defaultDraft());
  }

  if (!unresolved && (share.payment_pending || share.outstanding_minor === 0)) return null;

  return <form className="payment-entry" onSubmit={send}>
    <p>Already transferred? Report what you sent. Money already sent does not need to be paid again.</p>
    <label>Payment amount (USD)
      <input inputMode="decimal" value={draft.amount} required maxLength={20} disabled={busy || unresolved}
        onChange={event => {
          const next = { amount: event.currentTarget.value, key: crypto.randomUUID(), attempted: false };
          setDraft(next);
          savePaymentDraft(actorId, expense.id, share.id, next);
        }} />
    </label>
    {unresolved && <p>The previous report has an unknown result. Retry it to recover the saved response.</p>}
    {!unresolved && !canReport && <p>Enter a positive amount up to the remaining {money(share.outstanding_minor)}.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      {!unresolved && canReport && share.payment_url && <a className="secondary"
        href={share.payment_url} target="_blank" rel="noopener noreferrer" onClick={event => {
          try {
            rememberPaymentJump(actorId, expense, share, draft);
          } catch {
            event.preventDefault();
            setError("Unable to save the payment draft. Keep this page open and try again.");
          }
        }}>Go to payment</a>}
      <button disabled={busy || !unresolved && !canReport}>
        {unresolved ? "Retry report " : "Report "}{amount === null ? "payment" : money(amount)}{unresolved ? "" : " paid"}
      </button>
    </div>
  </form>;
}
