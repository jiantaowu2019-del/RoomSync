import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, submit, type Group, type Session } from "./api";
import { useAutoRefresh } from "./useAutoRefresh";

export function GroupHome({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef(new Map<string, string>());

  const loadGroups = useCallback(async (signal?: AbortSignal) => {
    try {
      const entries = await api<Group[]>("/groups", { signal });
      if (!signal?.aborted) setGroups(entries);
    } catch (error) {
      if (!signal?.aborted && error instanceof ApiError && error.status === 401) onLogout();
      throw error;
    }
  }, [onLogout]);

  const cancelRefresh = useAutoRefresh(loadGroups, !busy);

  useEffect(() => {
    const initial = new AbortController();
    loadGroups(initial.signal)
      .catch(error => {
        if (!initial.signal.aborted) setError(error instanceof ApiError ? error.message : "Unable to load your groups.");
      })
      .finally(() => { if (!initial.signal.aborted) setBusy(false); });
    return () => initial.abort();
  }, [loadGroups]);

  async function run(action: () => Promise<void>) {
    cancelRefresh();
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout();
      else setError(error instanceof ApiError ? error.message : "Unable to reach RoomSync. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    void run(async () => {
      const key = pending.current.get(name) ?? crypto.randomUUID();
      pending.current.set(name, key);
      const result = await submit<{ id: number }>("/groups", JSON.stringify({ name }), key);
      window.location.assign(`/groups/${result.id}`);
    });
  }

  return <>
    <div className="page-heading">
      <div><h1>Shared expenses</h1><p>Your groups</p></div>
      <div className="account">
        <span>{session.viewer.display_name}</span>
        <button className="quiet" disabled={busy} onClick={() => void run(async () => {
          await api("/session", { method: "DELETE" });
          onLogout();
        })}>Sign out</button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel group-home">
      <div className="row">
        <h2>Groups</h2>
        <button className="quiet" disabled={busy} onClick={() => void run(() => loadGroups())}>Refresh</button>
      </div>
      <form onSubmit={createGroup}>
        <label>Group name<input name="name" required maxLength={160} /></label>
        <button disabled={busy}>Create group</button>
      </form>
      <nav className="group-list" aria-label="Ledgers">
        {groups.map(group => group.status === "active"
          ? <a className="secondary" key={group.id} href={`/groups/${group.id}`}>{group.name}</a>
          : <button className="secondary" key={group.id} disabled={busy} onClick={() => void run(async () => {
              await api(`/groups/${group.id}/join`, { method: "POST" });
              window.location.assign(`/groups/${group.id}`);
            })}>Accept invitation to {group.name}</button>)}
        <a className="secondary" href="/history">Historical expenses</a>
      </nav>
    </section>
  </>;
}
