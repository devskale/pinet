"use client";

import { useCallback, useEffect, useState } from "react";

type Me = { name: string; kind: "user" | "agent" };
type Issue = { slug: string; state: string; from: string; date: string; text: string; column: string };

const COLS = [
  { col: "backlog", label: "Backlog", state: "OPEN" },
  { col: "active", label: "In Progress", state: "WIP" },
  { col: "review", label: "Review", state: "FOR_REVIEW" },
  { col: "archive", label: "Done", state: "DONE" },
];
const ORDER = COLS.map((c) => c.col);

export default function Page() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [project, setProject] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    const r = await fetch("/api/auth/me");
    setMe(r.ok ? (await r.json()).user : null);
    setReady(true);
  }, []);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    if (me) {
      const p = localStorage.getItem("pinet.project");
      if (p) setProject(p);
    }
  }, [me]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    localStorage.removeItem("pinet.project");
    setProject(null);
    setMe(null);
  };

  if (!ready) return null;
  if (!me) return <Auth onDone={refreshMe} />;
  if (!project) return <Projects me={me} onPick={setProject} onLogout={logout} />;
  return <Board me={me} project={project} onLeave={() => { localStorage.removeItem("pinet.project"); setProject(null); }} onLogout={logout} />;
}

/* ---------- Auth ---------- */
function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<"user" | "agent">("user");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const r = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "register" ? { name, password, kind } : { name, password }),
    });
    if (!r.ok) {
      setError(((await r.json().catch(() => ({}))) as { error?: string }).error || "failed");
      return;
    }
    onDone();
  };

  return (
    <div className="screen">
      <form className="auth card" onSubmit={submit}>
        <h1>pinet</h1>
        <div className="seg">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>log in</button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>register</button>
        </div>
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {mode === "register" && (
          <div className="seg">
            <button type="button" className={kind === "user" ? "on" : ""} onClick={() => setKind("user")}>human</button>
            <button type="button" className={kind === "agent" ? "on" : ""} onClick={() => setKind("agent")}>agent</button>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary">{mode === "login" ? "log in" : "register"}</button>
      </form>
    </div>
  );
}

/* ---------- Projects ---------- */
function Projects({ me, onPick, onLogout }: { me: Me; onPick: (p: string) => void; onLogout: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [nu, setNu] = useState("");
  const load = async () => {
    const r = await fetch("/api/projects");
    if (r.ok) setNames((await r.json()).projects.map((p: { name: string }) => p.name));
  };
  useEffect(() => { load(); }, []);
  const create = async () => {
    if (!nu.trim()) return;
    await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nu.trim() }) });
    setNu("");
    load();
  };
  const enter = (n: string) => { localStorage.setItem("pinet.project", n); onPick(n); };

  return (
    <div className="screen">
      <div className="card wide">
        <div className="topbar">
          <h1>projects</h1>
          <div className="who">{me.name} · {me.kind} <button className="link" onClick={onLogout}>log out</button></div>
        </div>
        <div className="proj-grid">
          {names.map((n) => (
            <button key={n} className="proj-card" onClick={() => enter(n)}>{n}</button>
          ))}
          {names.length === 0 && <div className="muted">no projects yet — create one</div>}
        </div>
        <div className="row">
          <input placeholder="new project name" value={nu} onChange={(e) => setNu(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          <button className="primary" onClick={create}>create</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Board ---------- */
function Board({ me, project, onLeave, onLogout }: { me: Me; project: string; onLeave: () => void; onLogout: () => void }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const load = async () => {
    const r = await fetch(`/api/projects/${encodeURIComponent(project)}/issues`);
    if (r.ok) setIssues((await r.json()).issues);
  };
  useEffect(() => { load(); }, [project]);

  const add = async () => {
    if (!draft.trim()) return;
    await fetch(`/api/projects/${encodeURIComponent(project)}/issues`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: draft }),
    });
    setDraft("");
    load();
  };
  const move = async (it: Issue, to: string) => {
    await fetch(`/api/projects/${encodeURIComponent(project)}/issues/${it.slug}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: to }),
    });
    load();
  };
  const saveEdit = async () => {
    if (editing) {
      await fetch(`/api/projects/${encodeURIComponent(project)}/issues/${editing}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: editText }),
      });
      setEditing(null);
      load();
    }
  };
  const del = async (slug: string) => {
    await fetch(`/api/projects/${encodeURIComponent(project)}/issues/${slug}`, { method: "DELETE" });
    load();
  };

  const idx = (col: string) => ORDER.indexOf(col);

  return (
    <div className="board-screen">
      <div className="topbar">
        <button className="link" onClick={onLeave}>← projects</button>
        <h1>{project}</h1>
        <div className="who">{me.name} · {me.kind} <button className="link" onClick={onLogout}>log out</button></div>
      </div>
      <div className="newcard row">
        <input placeholder="add a card…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="primary" onClick={add}>add</button>
      </div>
      <div className="board">
        {COLS.map((c) => (
          <div className="col" key={c.col}>
            <div className="col-h"><span>{c.label}</span><span className="muted">{issues.filter((i) => i.column === c.col).length}</span></div>
            {issues.filter((i) => i.column === c.col).map((it) => (
              <div className="card2" key={it.slug}>
                {editing === it.slug ? (
                  <textarea autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={saveEdit} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } }} />
                ) : (
                  <div className="card2-text" onClick={() => { setEditing(it.slug); setEditText(it.text); }}>{it.text}</div>
                )}
                <div className="card2-meta muted">{it.from} · {it.date}</div>
                <div className="card2-actions">
                  <button disabled={idx(it.column) === 0} onClick={() => move(it, COLS[idx(it.column) - 1].state)}>←</button>
                  <button disabled={idx(it.column) === ORDER.length - 1} onClick={() => move(it, COLS[idx(it.column) + 1].state)}>→</button>
                  <button className="del" onClick={() => del(it.slug)}>×</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
