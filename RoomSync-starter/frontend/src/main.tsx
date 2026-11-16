import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, money, parseCents, submit, type Expense, type ExpenseRow, type Payment, type Session, type Share } from "./api";
import "./styles.css";

const activity: Record<string, string> = {
  EXPENSE_CREATED: "created the expense",
  PAYMENT_REPORTED: "reported a payment",
  PAYMENT_CONFIRMED: "confirmed receipt",
  PAYMENT_REJECTED: "rejected the report",
};

function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "Unable to reach RoomSync. Try again.";
}

function badge(status: string) {
  const labels: Record<string, string> = {
    OPEN: "Open", UNPAID: "Unpaid", PAYMENT_REPORTED: "Payment reported",
    REPORTED: "Payment reported", CONFIRMED: "Receipt confirmed", REJECTED: "Rejected", SETTLED: "Settled",
  };
  return <span className={"badge " + status.toLowerCase()}>{labels[status]}</span>;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    try {
      await submit("/session", JSON.stringify({ username: fields.get("username"), password: fields.get("password") }));
      onLogin(await api<Session>("/session"));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return <section className="panel login">
    <h1>Sign in to RoomSync</h1>
    <form onSubmit={login}>
      <label>Username<input name="username" autoComplete="username" required /></label>
      <label>Password<input name="password" autoComplete="current-password" type="password" required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={busy}>Sign in</button>
    </form>
  </section>;
}

function Ledger({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [selected, setSelected] = useState<Expense | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const pending = useRef(new Map<string, string>());

  async function refresh(id?: number) {
    const expenses = await api<ExpenseRow[]>("/expenses");
    const nextId = id ?? expenses[0]?.id;
    setRows(expenses);
    setSelected(nextId === undefined ? null : await api<Expense>("/expenses/" + nextId));
  }

  useEffect(() => {
    refresh().catch(error => setError(errorMessage(error))).finally(() => setBusy(false));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout();
      else setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function write<T>(path: string, fields: object) {
    const body = JSON.stringify(fields);
    const fingerprint = path + "\n" + body;
    const key = pending.current.get(fingerprint) ?? crypto.randomUUID();
    pending.current.set(fingerprint, key);
    try {
      return await submit<T>(path, body, key);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) pending.current.delete(fingerprint);
      throw error;
    }
  }

  function addExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const total = parseCents(String(fields.get("total")));
    if (total === null) {
      setError("Enter a positive amount in USD with up to two decimal places.");
      return;
    }
    void run(async () => {
      const body = JSON.stringify({ description: String(fields.get("description")).trim(), total_minor: total });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const storageKey = `roomsync:expense:${session.viewer.id}:${fingerprint}`;
      const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      let result: { id: number };
      try {
        result = await submit<{ id: number }>("/expenses", body, key);
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) sessionStorage.removeItem(storageKey);
        throw error;
      }
      await refresh(result.id);
      sessionStorage.removeItem(storageKey);
      form.reset();
    });
  }

  async function updatePayment(path: string, fields: object) {
    await run(async () => {
      await write(path, fields);
      await refresh(selected?.id);
      pending.current.delete(path + "\n" + JSON.stringify(fields));
    });
  }

  return <>
    <div className="page-heading">
      <div><h1>Shared expenses</h1><p>With {session.other_member.display_name}</p></div>
      <div className="account">
        <span>{session.viewer.display_name}</span>
        <button className="quiet" disabled={busy} onClick={() => void run(async () => {
          await api("/session", { method: "DELETE" });
          onLogout();
        })}>Sign out</button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="workspace">
      <aside>
        <section className="panel">
          <h2>New expense</h2>
          <form onSubmit={addExpense}>
            <label>Description<input name="description" placeholder="Groceries" required maxLength={160} /></label>
            <label>Total (USD)<input name="total" inputMode="decimal" placeholder="0.00" required maxLength={20} /></label>
            <button disabled={busy}>Add expense</button>
          </form>
        </section>
        <section className="panel expense-list">
          <div className="row"><h2>Expenses</h2><button className="quiet" disabled={busy} onClick={() => void run(() => refresh(selected?.id))}>Refresh</button></div>
          {rows.length === 0 && <p>{busy ? "Loading expenses…" : "No expenses yet."}</p>}
          {rows.map(row => <button type="button" key={row.id} className="expense-item"
            aria-current={selected?.id === row.id ? "true" : undefined} disabled={busy}
            onClick={() => void run(() => refresh(row.id))}>
            <span>{row.description}<small>Paid by {row.original_payer}</small></span>
            <span>{money(row.total_minor)}{badge(row.status)}</span>
          </button>)}
        </section>
      </aside>
      <div>
        {selected ? <section className="panel detail">
          <div className="row title"><h2>{selected.description}</h2>{badge(selected.status)}</div>
          <p>{selected.original_payer} paid {money(selected.total_minor)} for {selected.original_payer} and {selected.other_member}.</p>
          <div className="balance">
            <span>Outstanding balance</span>
            <strong>{money(selected.outstanding_minor)}</strong>
          </div>
          {selected.shares.length === 0 && <p>The original payer covers this one-cent expense. There is no payment due.</p>}
          {selected.shares.map(share => <ShareView key={share.id} share={share}
            payer={share.debtor_id === session.viewer.id} busy={busy} update={updatePayment} />)}
          <div className="activity">
            <h3>Activity</h3>
            <ol>{selected.audit.map(event => <li key={event.id}>
              <span><strong>{event.actor}</strong> {activity[event.kind] ?? event.kind}</span>
              <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time>
            </li>)}</ol>
          </div>
        </section> : <section className="panel empty"><p>{busy ? "Loading expense details…" : "Add an expense to view its split and payment history."}</p></section>}
      </div>
    </div>
  </>;
}

type Mutate = (path: string, body: object) => Promise<void>;

function ShareView({ share, payer, busy, update }: { share: Share; payer: boolean; busy: boolean; update: Mutate }) {
  return <div className="share">
    <div className="row"><h3>{share.debtor} owes {share.recipient}</h3>{badge(share.status)}</div>
    {payer && share.status === "UNPAID" && <>
      <p>Make payment outside RoomSync. The balance changes after {share.recipient} confirms receipt.</p>
      <div className="actions">
        {share.payment_url
          ? <a className="secondary" href={share.payment_url} target="_blank" rel="noopener noreferrer">Open external payment link</a>
          : <span className="muted">No payment link is configured.</span>}
        <button disabled={busy}
          onClick={() => void update(`/shares/${share.id}/payments`, { amount_minor: share.outstanding_minor })}>
          Report {money(share.outstanding_minor)} paid
        </button>
      </div>
    </>}
    {share.payments.map(payment => <div className="payment" key={payment.id}>
      <div className="row"><strong>{money(payment.amount_minor)} report</strong>{badge(payment.status)}</div>
      {payment.reason && <p>Reason: {payment.reason}</p>}
      {payment.status === "REPORTED" && (payer
        ? <p>Waiting for {share.recipient} to confirm receipt.</p>
        : <Decide payment={payment} busy={busy} update={update} />)}
    </div>)}
  </div>;
}

function Decide({ payment, busy, update }: { payment: Payment; busy: boolean; update: Mutate }) {
  const [showReject, setShowReject] = useState(false);
  const path = `/payments/${payment.id}`;
  return <>
    <p>Confirm only after receiving {money(payment.amount_minor)} outside RoomSync.</p>
    <div className="actions">
      <button disabled={busy} onClick={() => void update(path + "/confirm", { amount_minor: payment.amount_minor })}>
        Confirm {money(payment.amount_minor)} received
      </button>
      <button className="quiet" disabled={busy} aria-expanded={showReject} onClick={() => setShowReject(!showReject)}>
        Reject report
      </button>
    </div>
    {showReject && <form className="reject-form" onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      void update(path + "/reject", { reason: String(fields.get("reason")).trim() });
    }}>
      <label>Rejection reason<textarea name="reason" required maxLength={500} /></label>
      <button className="secondary" disabled={busy}>Submit rejection</button>
    </form>}
  </>;
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Session>("/session").then(setSession).catch(error => {
      if (!(error instanceof ApiError && error.status === 401)) setError(errorMessage(error));
      setSession(null);
    });
  }, []);
  return <>
    <header className="masthead"><div><span className="mark" aria-hidden="true">R</span>RoomSync</div></header>
    <main>
      {error && <p className="error" role="alert">{error}</p>}
      {session === undefined ? <p>Loading RoomSync…</p> : session
        ? <Ledger session={session} onLogout={() => setSession(null)} />
        : <Login onLogin={next => { setError(""); setSession(next); }} />}
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
