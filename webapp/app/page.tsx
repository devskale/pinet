"use client";

import { useEffect, useState } from "react";
import Board from "./board";

type User = {
  id: number;
  kind: "human" | "agent";
  handle: string;
  machine: string | null;
  role: "admin" | "orchestrator" | "worker";
  display_name: string | null;
};

const PERSONAS: { label: string; tag: string; machine: string; path: string }[] = [
  { label: "orchestrator · kontext.one", tag: "orchestrator", machine: "mac", path: "~/code/kontext.one" },
  { label: "frontend · kontext.one/klark0", tag: "worker", machine: "mac", path: "~/code/kontext.one/klark0" },
  { label: "backend · kontext.one/python-utils", tag: "worker", machine: "pi5", path: "~/code/kontext.one/python-utils" },
];

export default function Page() {
  const [me, setMe] = useState<User | null>(null);
  const [adminPw, setAdminPw] = useState("admin");
  const [machine, setMachine] = useState("mac");
  const [repoPath, setRepoPath] = useState("~/code/kontext.one/klark0");
  const [last, setLast] = useState<unknown>(null);
  const [state, setState] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function refreshMe() {
    const r = await fetch("/api/me");
    setMe(r.ok ? (await r.json()).user : null);
  }
  useEffect(() => {
    refreshMe();
  }, []);

  async function call(url: string, init?: RequestInit) {
    setBusy(true);
    try {
      const r = await fetch(url, init);
      const j = await r.json().catch(() => ({ error: "no json" }));
      setLast({ status: r.status, body: j });
      await refreshMe();
      if (me?.role === "admin" || j?.user?.role === "admin") {
        const s = await fetch("/api/admin/state");
        if (s.ok) setState(await s.json());
      }
      return j;
    } finally {
      setBusy(false);
    }
  }

  const loginHuman = () =>
    call("/api/login/human", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPw }),
    });

  const loginAgent = () =>
    call("/api/login/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine, path: repoPath }),
    });

  const logout = () => call("/api/logout", { method: "POST" });

  const devLogin = (persona: string) =>
    call("/api/login/dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona }),
    });

  const loadState = async () => {
    const s = await fetch("/api/admin/state");
    setState(s.ok ? await s.json() : { error: "admin only", status: s.status });
  };

  return (
    <div className="wrap">
      <h1>
        PiNet <span className="sub">— agent team login</span>
      </h1>
      <p className="muted">
        Humans log in with the admin password. Pi agents log in with <code>machine</code> + a repo{" "}
        <code>path</code> — role is implicit from the path depth.
      </p>

      <div className="me">
        {me ? (
          <>
            <span>
              <span className={`tag ${me.role}`}>{me.role}</span>{" "}
              <strong>{me.handle}</strong>{" "}
              <span className="muted">({me.kind})</span>
            </span>
            <button className="ghost" onClick={logout} disabled={busy}>
              log out
            </button>
          </>
        ) : (
          <span className="muted">not logged in</span>
        )}
      </div>

      {process.env.NODE_ENV === "development" && (
        <div className="card">
          <h2 style={{ marginBottom: 8 }}>Dev · one-click login</h2>
          <div className="pills">
            {["admin", "orchestrator", "frontend", "backend"].map((p) => (
              <button key={p} className="pill" onClick={() => devLogin(p)} disabled={busy}>
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid">
        <div className="card">
          <h2>Human · admin</h2>
          <div className="row">
            <input
              type="password"
              placeholder="admin password"
              value={adminPw}
              onChange={(e) => setAdminPw(e.target.value)}
            />
            <button onClick={loginHuman} disabled={busy}>
              log in
            </button>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Default password <code>admin</code> (env <code>ADMIN_PASSWORD</code>).
          </p>
        </div>

        <div className="card">
          <h2>Pi agent</h2>
          <div className="row">
            <input
              placeholder="machine"
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              style={{ flex: "0 0 90px", width: "auto" }}
            />
            <input
              placeholder="repo path (e.g. ~/code/kontext.one/klark0)"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
            />
            <button onClick={loginAgent} disabled={busy}>
              log in
            </button>
          </div>
          <div className="pills">
            {PERSONAS.map((p) => (
              <button
                key={p.label}
                className="pill"
                onClick={() => {
                  setMachine(p.machine);
                  setRepoPath(p.path);
                }}
              >
                <span className={`tag ${p.tag}`}>{p.tag}</span> {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {me && <Board me={me} />}

      {me?.role === "admin" && (
        <>
          <h2>
            Admin overview{" "}
            <button className="ghost" style={{ marginLeft: 8 }} onClick={loadState} disabled={busy}>
              refresh
            </button>
          </h2>
          <pre>{JSON.stringify(state, null, 2)}</pre>
        </>
      )}

      <h2>Last response</h2>
      <pre>{JSON.stringify(last, null, 2)}</pre>
    </div>
  );
}
