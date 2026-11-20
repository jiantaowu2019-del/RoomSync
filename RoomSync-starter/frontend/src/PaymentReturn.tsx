import { useEffect, useRef, useState } from "react";
import { ApiError, money, type Expense, type Share } from "./api";
import {
  amountText, expenseAddress, markJumpPrompted, readJumpExpense, readPaymentDraft, readPaymentJump,
  reportPayment, type PaymentJump,
} from "./paymentDraft";

type ReturnPrompt = { jump: PaymentJump; expense: Expense; share: Share };

export function PaymentReturn({ actorId }: { actorId: number }) {
  const [prompt, setPrompt] = useState<ReturnPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const reading = useRef(false);

  useEffect(() => {
    let disposed = false;
    async function checkReturn() {
      if (document.visibilityState !== "visible" || reading.current) return;
      const jump = readPaymentJump(actorId);
      if (!jump || jump.prompted) return;
      reading.current = true;
      try {
        const latest = await readJumpExpense(jump);
        if (disposed || readPaymentJump(actorId)?.id !== jump.id) return;
        markJumpPrompted(jump);
        setPrompt({ jump, ...latest });
        setError("");
      } catch (error) {
        if (!disposed) setError(error instanceof ApiError ? error.message : "Unable to reload the original payment. Return to this page to retry.");
      } finally {
        reading.current = false;
      }
    }
    void checkReturn();
    window.addEventListener("focus", checkReturn);
    window.addEventListener("pageshow", checkReturn);
    document.addEventListener("visibilitychange", checkReturn);
    return () => {
      disposed = true;
      window.removeEventListener("focus", checkReturn);
      window.removeEventListener("pageshow", checkReturn);
      document.removeEventListener("visibilitychange", checkReturn);
    };
  }, [actorId]);

  useEffect(() => {
    if (prompt && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [prompt]);

  function later() {
    // Reload the form's saved operation after an uncertain modal submission.
    // Otherwise its pre-modal state could start a new operation after a lost response.
    if (prompt && readPaymentDraft(actorId, prompt.jump.expenseId, prompt.jump.shareId)?.attempted) {
      window.location.assign(expenseAddress(prompt.jump.groupId, prompt.jump.expenseId));
      return;
    }
    dialog.current?.close();
    setPrompt(null);
    setError("");
  }

  async function confirmReport() {
    if (!prompt) return;
    setBusy(true);
    setError("");
    try {
      const latest = await readJumpExpense(prompt.jump);
      setPrompt({ ...prompt, ...latest });
      if (latest.share.payment_pending || latest.share.outstanding_minor < prompt.jump.amountMinor) {
        setError("The share changed. Review its latest state before reporting.");
        return;
      }
      await reportPayment(actorId, prompt.expense.id, prompt.share.id, {
        amount: amountText(prompt.jump.amountMinor), key: prompt.jump.requestKey, attempted: false,
      });
      window.location.assign(expenseAddress(prompt.jump.groupId, prompt.jump.expenseId));
    } catch (error) {
      setError(error instanceof ApiError ? error.message : "Unable to reach RoomSync. Retry the report from the original expense.");
    } finally {
      setBusy(false);
    }
  }

  if (!prompt) return error ? <p role="alert" className="error">{error}</p> : null;
  const { jump, expense, share } = prompt;
  const changed = share.payment_pending || share.outstanding_minor < jump.amountMinor;
  return <dialog ref={dialog} aria-labelledby="payment-return-title" onCancel={event => {
    event.preventDefault();
    if (!busy) later();
  }}>
    <h2 id="payment-return-title">Did you transfer {money(jump.amountMinor)} to {share.recipient}?</h2>
    <p>Expense: {expense.description}</p>
    <p>Confirmed: {money(share.confirmed_minor)} · Remaining: {money(share.outstanding_minor)}</p>
    {share.payment_pending && <p>A payment report is already awaiting confirmation.</p>}
    {share.outstanding_minor === 0 && <p>This share is settled.</p>}
    {!share.payment_pending && share.outstanding_minor > 0 && jump.amountMinor > share.outstanding_minor &&
      <p>The draft exceeds the latest balance. Review the amount in the original expense.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <p>Returning from the payment page does not confirm receipt.</p>
    <div className="actions">
      <button disabled={busy || changed} onClick={() => void confirmReport()}>Transferred, report {money(jump.amountMinor)}</button>
      <button className="quiet" disabled={busy} onClick={later}>Continue later</button>
      <a href={expenseAddress(jump.groupId, jump.expenseId)}>Review original expense</a>
    </div>
  </dialog>;
}
