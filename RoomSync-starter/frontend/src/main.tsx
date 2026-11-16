import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, money, submit, type Expense, type ExpenseRow, type Group, type GroupDetail, type Payment, type Session, type Share } from "./api";
import { ExpenseForm, type ExpenseDraft } from "./ExpenseForm";
import "./styles.css";

const REFRESH_INTERVAL_MS = 12_000;

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

function Ledger({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [selected, setSelected] = useState<Expense | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const pending = useRef(new Map<string, string>());
  const backgroundRead = useRef<AbortController | null>(null);
  const groupId = group?.id ?? null;
  const selectedId = selected?.id;

  const openLedger = useCallback(async (groupId: number | null, id?: number, signal?: AbortSignal) => {
    const [detail, expenses] = await Promise.all([
      groupId === null ? Promise.resolve(null) : api<GroupDetail>(`/groups/${groupId}`, { signal }),
      api<ExpenseRow[]>(groupId === null ? "/expenses" : `/groups/${groupId}/expenses`, { signal }),
    ]);
    const nextId = id ?? expenses[0]?.id;
    const expense = nextId === undefined ? null : await api<Expense>("/expenses/" + nextId, { signal });
    if (signal?.aborted) return;
    setGroup(detail);
    setRows(expenses);
    setSelected(expense);
  }, []);

  const refreshGroups = useCallback(async (signal?: AbortSignal) => {
    const entries = await api<Group[]>("/groups", { signal });
    if (!signal?.aborted) setGroups(entries);
  }, []);

  async function refresh() {
    await Promise.all([refreshGroups(), openLedger(groupId, selectedId)]);
  }

  useEffect(() => {
    void run(refresh);
  }, []);

  useEffect(() => {
    if (busy) return;

    async function refreshVisibleLedger() {
      if (document.visibilityState !== "visible" || backgroundRead.current) return;
      const request = new AbortController();
      backgroundRead.current = request;
      try {
        await Promise.all([refreshGroups(request.signal), openLedger(groupId, selectedId, request.signal)]);
      } catch {
        // Preserve the visible ledger and let the next foreground refresh retry.
        request.abort();
      } finally {
        if (backgroundRead.current === request) backgroundRead.current = null;
      }
    }

    const timer = window.setInterval(refreshVisibleLedger, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshVisibleLedger);
    document.addEventListener("visibilitychange", refreshVisibleLedger);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisibleLedger);
      document.removeEventListener("visibilitychange", refreshVisibleLedger);
      backgroundRead.current?.abort();
      backgroundRead.current = null;
    };
  }, [busy, groupId, selectedId, openLedger, refreshGroups]);

  async function run(action: () => Promise<void>) {
    backgroundRead.current?.abort();
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

  function addGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = { name: String(new FormData(form).get("name")).trim() };
    void run(async () => {
      const result = await write<{ id: number }>("/groups", payload);
      await Promise.all([refreshGroups(), openLedger(result.id)]);
      pending.current.delete("/groups\n" + JSON.stringify(payload));
      form.reset();
    });
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

  function join(groupId: number) {
    void run(async () => {
      await api(`/groups/${groupId}/join`, { method: "POST" });
      await Promise.all([refreshGroups(), openLedger(groupId)]);
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
      await openLedger(group.id, result.id);
      sessionStorage.removeItem(storageKey);
    });
  }

  async function updatePayment(path: string, fields: object) {
    await run(async () => {
      await write(path, fields);
      await openLedger(groupId, selectedId);
      pending.current.delete(path + "\n" + JSON.stringify(fields));
    });
  }

  return <>
    <div className="page-heading">
      <div>
        <h1>Shared expenses</h1>
        <div className="group-heading">
          <p>{group?.name ?? "Historical expenses"}</p>
          {group && <nav aria-label="Group shortcuts">
            <button type="button" className="quiet" onClick={() => focusSection("new-expense-heading")}>New expense</button>
            <button type="button" className="quiet" onClick={() => focusSection("expense-list-heading")}>View expenses</button>
          </nav>}
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
    <div className="workspace">
      <aside>
        <section className="panel">
          <div className="row"><h2>Groups</h2>
            <button className="quiet" disabled={busy} onClick={() => void run(refresh)}>Refresh</button>
          </div>
          <form onSubmit={addGroup}>
            <label>Group name<input name="name" required maxLength={160} /></label>
            <button disabled={busy}>Create group</button>
          </form>
          <nav className="group-list" aria-label="Ledgers">
            <button className="secondary" disabled={busy} aria-current={group === null ? "page" : undefined}
              onClick={() => void run(() => openLedger(null))}>Historical expenses</button>
            {groups.map(entry => entry.status === "active"
              ? <button className="secondary" key={entry.id} disabled={busy}
                  aria-current={group?.id === entry.id ? "page" : undefined}
                  onClick={() => void run(() => openLedger(entry.id))}>{entry.name}</button>
              : <button className="secondary" key={entry.id} disabled={busy}
                  onClick={() => join(entry.id)}>Accept invitation to {entry.name}</button>)}
          </nav>
        </section>
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
            onClick={() => void run(() => openLedger(groupId, row.id))}>
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
    </div>
  </>;
}

type Mutate = (path: string, body: object) => Promise<void>;

function ShareView({ share, payer, recipient, groupVisible, busy, update }: {
  share: Share; payer: boolean; recipient: boolean; groupVisible: boolean; busy: boolean; update: Mutate;
}) {
  return <section className="share" aria-label={`${share.debtor}'s share`}>
    <div className="row"><h3>{share.debtor} → {share.recipient}</h3>{badge(share.status)}</div>
    <p>Remaining: {money(share.outstanding_minor)}</p>
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
