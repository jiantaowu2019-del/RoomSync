import { useState, type FormEvent } from "react";
import { money, parseCents, type Member, type RemainderPolicy } from "./api";

export type ExpenseDraft = {
  description: string;
  total_minor: number;
  participant_ids: number[];
  remainder_policy: RemainderPolicy;
};

export function ExpenseForm({ members, payer, busy, save }: {
  members: Member[];
  payer: Member;
  busy: boolean;
  save: (draft: ExpenseDraft) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState([payer.id]);
  const [amount, setAmount] = useState("");
  const [policy, setPolicy] = useState<RemainderPolicy>("PAYER");
  const participants = members.filter(member => selected.includes(member.id)).sort((a, b) =>
    Number(b.id === payer.id) - Number(a.id === payer.id) || a.id - b.id);
  const count = participants.length;
  const total = parseCents(amount);
  const canPreview = total !== null && count >= 2;
  const remainder = canPreview ? total % count : 0;
  const base = canPreview ? (total - remainder) / count : 0;
  const effectivePolicy = remainder ? policy : "PAYER";

  async function submitExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPreview) return;
    const form = event.currentTarget;
    const description = String(new FormData(form).get("description")).trim();
    if (await save({
      description, total_minor: total,
      participant_ids: participants.map(member => member.id).sort((a, b) => a - b),
      remainder_policy: effectivePolicy,
    })) {
      form.reset();
      setAmount("");
      setSelected([payer.id]);
      setPolicy("PAYER");
    }
  }

  return <section className="panel">
    <h2 id="new-expense-heading" tabIndex={-1}>New expense</h2>
    <form onSubmit={submitExpense}>
      <label>Description<input name="description" placeholder="Groceries" required maxLength={160} /></label>
      <label>Total (USD)<input name="total" inputMode="decimal" placeholder="0.00" required maxLength={20}
        value={amount} onChange={event => setAmount(event.currentTarget.value)} /></label>
      <fieldset disabled={busy}>
        <legend>Participants</legend>
        <button className="quiet" type="button" onClick={() => setSelected(members.map(member => member.id))}>
          Select all group members
        </button>
        {members.map(member => <label className="choice" key={member.id}>
          <input type="checkbox" checked={selected.includes(member.id)} disabled={member.id === payer.id}
            onChange={event => {
              const checked = event.currentTarget.checked;
              setSelected(previous => checked ? [...previous, member.id] : previous.filter(id => id !== member.id));
            }} />
          {member.display_name}{member.id === payer.id ? " (payer)" : ""}
        </label>)}
        <p aria-live="polite">{count} selected · At least 2 people, including the payer.</p>
      </fieldset>
      {remainder > 0 && <fieldset disabled={busy}>
        <legend>Remainder</legend>
        <label className="choice"><input type="radio" name="remainder" checked={policy === "PAYER"}
          onChange={() => setPolicy("PAYER")} /> Payer covers remainder</label>
        <label className="choice"><input type="radio" name="remainder" checked={policy === "EVEN"}
          onChange={() => setPolicy("EVEN")} /> Distribute as evenly as possible</label>
      </fieldset>}
      {canPreview && <section aria-label="Allocation preview">
        <h3>Allocation preview</h3>
        <ul className="allocations">{participants.map((member, index) => {
          const extra = effectivePolicy === "PAYER" ? (index === 0 ? remainder : 0) : Number(index < remainder);
          return <li key={member.id}><span>{member.display_name}</span><strong>{money(base + extra)}</strong></li>;
        })}</ul>
      </section>}
      {amount !== "" && total === null && <p>Enter a positive USD amount with up to two decimal places.</p>}
      <button disabled={busy || !canPreview}>Add expense</button>
    </form>
  </section>;
}
