import { useId, useState, type FormEvent } from "react";
import { money, parseCents, type Share } from "./api";
import { emptyStatement, readStatement, saveStatement, type StatementDraft } from "./statementDraft";

export type SaveStatement = (path: string, draft: StatementDraft) => Promise<boolean>;

function StatementForm({ actorId, path, opening, available, remaining, busy, save }: {
  actorId: number; path: string; opening: boolean; available: boolean; remaining: number;
  busy: boolean; save: SaveStatement;
}) {
  const [draft, setDraft] = useState(() => readStatement(actorId, path) ?? emptyStatement());
  const inputId = useId();
  const amount = parseCents(draft.amount);
  const valid = draft.text.trim().length > 0 && draft.text.trim().length <= 2000 &&
    (!opening || amount !== null && amount <= remaining);

  function edit(field: "amount" | "text", value: string) {
    const next = { ...draft, [field]: value, key: crypto.randomUUID(), attempted: false };
    saveStatement(actorId, path, next);
    setDraft(next);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (await save(path, draft)) setDraft(emptyStatement());
    else setDraft(readStatement(actorId, path) ?? emptyStatement());
  }

  if (!available && !draft.attempted) return null;
  return <form className="statement-form" onSubmit={send}>
    {opening && <>
      <label htmlFor={inputId + "-amount"}>Disputed amount (USD)</label>
      <input id={inputId + "-amount"} inputMode="decimal" required maxLength={20} value={draft.amount}
        disabled={busy || draft.attempted} onChange={event => edit("amount", event.currentTarget.value)} />
    </>}
    <label htmlFor={inputId + "-text"}>{opening ? "Dispute reason" : "Response"}</label>
      <textarea id={inputId + "-text"} required maxLength={2000} value={draft.text} disabled={busy || draft.attempted}
        onChange={event => edit("text", event.currentTarget.value)} />
    {draft.attempted && <p>The previous submission has an unknown result. Retry to recover the saved response.</p>}
    {opening && !draft.attempted && <p>Use a positive amount up to the current balance of {money(remaining)}.</p>}
    <button disabled={busy || !draft.attempted && (!available || !valid)}>
      {draft.attempted ? opening ? "Retry dispute" : "Retry response" : opening ? "Open dispute" : "Add response"}
    </button>
  </form>;
}

export function DisputePanel({ actorId, share, groupVisible, busy, save }: {
  actorId: number; share: Share; groupVisible: boolean; busy: boolean; save: SaveStatement;
}) {
  const thread = share.dispute;
  const debtor = actorId === share.debtor_id;
  const party = debtor || actorId === share.recipient_id;
  if (!thread && !debtor) return null;
  return <section className="dispute-panel" aria-label={`${share.debtor}'s dispute`}>
    <h4>Dispute{thread ? " · Open" : ""}</h4>
    <p>{groupVisible ? "The full dispute and responses are visible to active group members."
      : "Only the original two participants can see this dispute."}</p>
    <p>Disputes and responses do not change the balance or stop payments.</p>
    {debtor && <StatementForm actorId={actorId} path={`/shares/${share.id}/disputes`}
      opening available={!thread && share.outstanding_minor > 0} remaining={share.outstanding_minor} busy={busy} save={save} />}
    {!thread && share.outstanding_minor === 0 && <p>Settled shares cannot accept a new dispute.</p>}
    {thread && <>
      <p>Current balance: {money(share.outstanding_minor)}</p>
      <p>Claimed when opened: {money(thread.claimed_minor)}</p>
      <p>Balance when opened: {money(thread.outstanding_at_open_minor)}</p>
      <p>Opened by {thread.opened_by_name} <time dateTime={thread.created_at}>{new Date(thread.created_at).toLocaleString()}</time></p>
      <p className="statement-body">{thread.reason}</p>
      <ol className="dispute-responses">{thread.responses.map(response => <li className="dispute-response" key={response.id}>
        <strong>{response.author}</strong><time dateTime={response.created_at}>{new Date(response.created_at).toLocaleString()}</time>
        <p className="statement-body">{response.body}</p>
      </li>)}</ol>
      {party && <StatementForm key={thread.id} actorId={actorId} path={`/disputes/${thread.id}/responses`}
        opening={false} available remaining={share.outstanding_minor} busy={busy} save={save} />}
    </>}
  </section>;
}
