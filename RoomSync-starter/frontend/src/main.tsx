import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, money, submit, type Expense, type ExpenseRow, type GroupDetail, type Payment, type Session, type Share } from "./api";
import { ExpenseForm, type ExpenseDraft } from "./ExpenseForm";
import { GroupHome } from "./GroupHome";
import { useAutoRefresh } from "./useAutoRefresh";
import { PaymentReportForm } from "./PaymentReportForm";
import { PaymentReturn } from "./PaymentReturn";
import { reportPayment, type PaymentDraft } from "./paymentDraft";
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
    PARTIALLY_SETTLED: "Partially settled",
  };
  return <span className={"badge " + status.toLowerCase()}>{labels[status]}</span>;
}

function focusSection(id: string) {
  const heading = document.getElementById(id);
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
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

function Ledger({ session, groupId, onLogout }: {
  session: Session; groupId: number | null; onLogout: () => void;
}) {
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [available, setAvailable] = useState(false);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [selected, setSelected] = useState<Expense | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const pending = useRef(new Map<string, string>());
  const selectedId = selected?.id;
  const requestedExpense = Number(new URLSearchParams(window.location.search).get("expense"));

  const openLedger = useCallback(async (id?: number, signal?: AbortSignal) => {
    const [detail, expenses] = await Promise.all([
      groupId === null ? Promise.resolve(null) : api<GroupDetail>(`/groups/${groupId}`, { signal }),
      api<ExpenseRow[]>(groupId === null ? "/expenses" : `/groups/${groupId}/expenses`, { signal }),
    ]);
    const nextId = id ?? expenses[0]?.id;
    const expense = nextId === undefined ? null : await api<Expense>("/expenses/" + nextId, { signal });
    if (signal?.aborted) return;
    if (expense && expense.group_id !== groupId) throw new ApiError(404, "Expense not found in this ledger.");
    setGroup(detail);
    setRows(expenses);
    setSelected(expense);
    setAvailable(true);
    setError("");
  }, [groupId]);

  const handleReadError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onLogout();
    else if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      setAvailable(false);
      setGroup(null);
      setRows([]);
      setSelected(null);
      setError(groupId === null ? "Historical expenses are unavailable." : "This group is unavailable or you do not have access.");
    } else setError(errorMessage(error));
  }, [groupId, onLogout]);

  useEffect(() => {
    const initial = new AbortController();
    openLedger(Number.isSafeInteger(requestedExpense) && requestedExpense > 0 ? requestedExpense : undefined, initial.signal)
      .catch(error => { if (!initial.signal.aborted) handleReadError(error); })
      .finally(() => { if (!initial.signal.aborted) setBusy(false); });
    return () => initial.abort();
  }, [openLedger, handleReadError, requestedExpense]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      await openLedger(selectedId, signal);
    } catch (error) {
      if (!signal?.aborted) handleReadError(error);
      throw error;
    }
  }, [openLedger, selectedId, handleReadError]);
  const cancelRefresh = useAutoRefresh(refresh, !busy && available);

  async function run(action: () => Promise<void>) {
    cancelRefresh();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout();
      else setError(errorMessage(error));
      return false;
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

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!group) return;
    const form = event.currentTarget;
    const username = String(new FormData(form).get("username")).trim();
    void run(async () => {
      await submit(`/groups/${group.id}/invitations`, JSON.stringify({ username }));
      form.reset();
      setNotice("Invitation saved.");
    });
  }

  async function addExpense(draft: ExpenseDraft) {
    if (!group) return false;
    const path = `/groups/${group.id}/expenses`;
    return run(async () => {
      const body = JSON.stringify(draft);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path + "\n" + body));
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const storageKey = `roomsync:expense:${session.viewer.id}:${fingerprint}`;
      const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      let result: { id: number };
      try {
        result = await submit<{ id: number }>(path, body, key);
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) sessionStorage.removeItem(storageKey);
        throw error;
      }
      await openLedger(result.id);
      sessionStorage.removeItem(storageKey);
    });
  }

  async function updatePayment(path: string, fields: object) {
    await run(async () => {
      await write(path, fields);
      await openLedger(selectedId);
      pending.current.delete(path + "\n" + JSON.stringify(fields));
    });
  }

  async function submitReport(shareId: number, draft: PaymentDraft) {
    if (!selected) return false;
    return run(async () => {
      await reportPayment(session.viewer.id, selected.id, shareId, draft);
      await openLedger(selected.id);
    });
  }

  return <>
    <a className="back-link" href="/">Back to groups</a>
    <div className="page-heading">
      <div className="ledger-heading">
        <h1>{groupId === null ? "Historical expenses" : group?.name ?? (busy ? "Loading group…" : "Group unavailable")}</h1>
        <div className="group-heading">
          {group && <nav aria-label="Group shortcuts">
            <button type="button" className="quiet" onClick={() => focusSection("new-expense-heading")}>New expense</button>
            <button type="button" className="quiet" onClick={() => focusSection("expense-list-heading")}>View expenses</button>
          </nav>}
          {available && <button className="quiet" disabled={busy} onClick={() => void run(() => refresh())}>Refresh</button>}
        </div>
      </div>
      <div className="account">
        <span>{session.viewer.display_name}</span>
        <button className="quiet" disabled={busy} onClick={() => void run(async () => {
          await api("/session", { method: "DELETE" });
          onLogout();
        })}>Sign out</button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!available && !error && <p>Loading expenses…</p>}
    {available && <div className="workspace">
      <aside>
        {group?.creator_id === session.viewer.id && <section className="panel">
          <h2>Invite a member</h2>
          <form onSubmit={invite}>
            <label>Invite username<input name="username" required maxLength={64} /></label>
            <button disabled={busy}>Send invitation</button>
          </form>
        </section>}
        {group && <ExpenseForm key={group.id} members={group.members} payer={session.viewer} busy={busy} save={addExpense} />}
        <section className="panel expense-list">
          <h2 id="expense-list-heading" tabIndex={-1}>{group ? "Group expenses" : "Historical expenses"}</h2>
          {rows.length === 0 && <p>{busy ? "Loading expenses…" : "No expenses yet."}</p>}
          {rows.map(row => <button type="button" key={row.id} className="expense-item"
            aria-current={selected?.id === row.id ? "true" : undefined} disabled={busy}
            onClick={() => void run(() => openLedger(row.id))}>
            <span>{row.description}<small>Paid by {row.original_payer}</small></span>
            <span>{money(row.total_minor)}{badge(row.status)}</span>
          </button>)}
        </section>
      </aside>
      <div>
        {selected ? <section className="panel detail">
          <div className="row title"><h2>{selected.description}</h2>{badge(selected.status)}</div>
          <dl className="expense-summary">
            <div><dt>Paid by</dt><dd>{selected.original_payer}</dd></div>
            <div><dt>Total paid</dt><dd>{money(selected.total_minor)}</dd></div>
          </dl>
          <section aria-labelledby="expense-allocations-heading">
            <h3 id="expense-allocations-heading">Amount per person</h3>
            <ul className="allocations">{selected.allocations.map(allocation => <li key={allocation.member_id}>
              <span>{allocation.display_name}</span><strong>{money(allocation.amount_minor)}</strong>
            </li>)}</ul>
          </section>
          <div className="balance">
            <span>Total outstanding</span>
            <strong>{money(selected.outstanding_minor)}</strong>
          </div>
          {selected.shares.length === 0 && <p>No payments are due for this expense.</p>}
          {selected.shares.length > 0 && !selected.allocations.some(allocation => allocation.member_id === session.viewer.id) &&
            <p>You have no allocation for this expense.</p>}
          {selected.shares.map(share => <ShareView key={share.id} share={share}
            actorId={session.viewer.id} expense={selected} report={submitReport}
            payer={share.debtor_id === session.viewer.id} recipient={share.recipient_id === session.viewer.id}
            groupVisible={selected.group_id !== null} busy={busy} update={updatePayment} />)}
          <div className="activity">
            <h3>Activity</h3>
            <ol>{selected.audit.map(event => <li key={event.id}>
              <span><strong>{event.actor}</strong> {activity[event.kind] ?? event.kind}</span>
              <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time>
            </li>)}</ol>
          </div>
        </section> : <section className="panel empty"><p>{busy ? "Loading expense details…" : "No expense selected."}</p></section>}
      </div>
    </div>}
  </>;
}

type Mutate = (path: string, body: object) => Promise<void>;

function ShareView({ share, payer, recipient, groupVisible, busy, update, actorId, expense, report }: {
  share: Share; payer: boolean; recipient: boolean; groupVisible: boolean; busy: boolean; update: Mutate;
  actorId: number; expense: Expense; report: (shareId: number, draft: PaymentDraft) => Promise<boolean>;
}) {
  const progress = share.outstanding_minor === 0 ? "SETTLED" : share.confirmed_minor > 0 ? "PARTIALLY_SETTLED" : "UNPAID";
  return <section className="share" aria-label={`${share.debtor}'s share`}>
    <div className="row"><h3>{share.debtor} → {share.recipient}</h3>{badge(progress)}</div>
    {share.payment_pending && badge("PAYMENT_REPORTED")}
    <p>Original share: {money(share.amount_minor)} · Confirmed: {money(share.confirmed_minor)}</p>
    {share.payment_pending && <p>Awaiting confirmation: {money(share.pending_minor)}</p>}
    <p>Remaining: {money(share.outstanding_minor)}</p>
    {payer && <PaymentReportForm key={`${share.id}:${share.outstanding_minor}:${share.payment_pending}`}
      actorId={actorId} expense={expense} share={share} busy={busy} report={report} />}
    {share.payments.map(payment => <div className="payment" key={payment.id}>
      <div className="row"><strong>{money(payment.amount_minor)} report</strong>{badge(payment.status)}</div>
      <p>Reported <time dateTime={payment.created_at}>{new Date(payment.created_at).toLocaleString()}</time></p>
      {payment.confirmed_minor !== null && <p>Confirmed receipt: {money(payment.confirmed_minor)}</p>}
      {payment.decided_at && <p>Decided <time dateTime={payment.decided_at}>{new Date(payment.decided_at).toLocaleString()}</time></p>}
      {payment.reason && <p>Reason: {payment.reason}</p>}
      {payment.status === "REPORTED" && (recipient
        ? <Decide payment={payment} groupVisible={groupVisible} busy={busy} update={update} />
        : <p>Waiting for {share.recipient} to confirm receipt.</p>)}
    </div>)}
  </section>;
}

function Decide({ payment, groupVisible, busy, update }: {
  payment: Payment; groupVisible: boolean; busy: boolean; update: Mutate;
}) {
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
      {groupVisible && <p>Visible to group members.</p>}
      <button className="secondary" disabled={busy}>Submit rejection</button>
    </form>}
  </>;
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");
  const logout = useCallback(() => setSession(null), []);
  const path = window.location.pathname;
  const groupMatch = /^\/groups\/([1-9][0-9]*)\/?$/.exec(path);
  const groupId = groupMatch ? Number(groupMatch[1]) : null;
  const isGroup = groupId !== null && Number.isSafeInteger(groupId);
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
        ? path === "/"
          ? <GroupHome session={session} onLogout={logout} />
          : isGroup || path === "/history"
            ? <Ledger session={session} groupId={groupId} onLogout={logout} />
            : <><h1>Page not found</h1><a className="back-link" href="/">Back to groups</a></>
        : <Login onLogin={next => { setError(""); setSession(next); }} />}
      {session && <PaymentReturn key={session.viewer.id} actorId={session.viewer.id} />}
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
