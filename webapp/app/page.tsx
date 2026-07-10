"use client";

import { useCallback, useEffect, useState } from "react";

type Me = { name: string; kind: "user" | "agent" };
type Issue = { slug: string; state: string; from: string; date: string; text: string; column: string };
type Member = { name: string; kind: "user" | "agent"; role: string };

const COLS = [
  { col: "backlog", label: "Backlog", state: "OPEN" },
  { col: "active", label: "In Progress", state: "WIP" },
  { col: "review", label: "Review", state: "FOR_REVIEW" },
  { col: "archive", label: "Done", state: "DONE" },
];
const ORDER = COLS.map((c) => c.col);
const ROLES = ["admin", "member"];

export default function Page() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [project, setProject] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    const r = await fetch("/api/auth/me");
    setMe(r.ok ? (await r.json()).user : null);
    setReady(true);
  }, []);
  useEffect(() => { refreshMe(); }, [refreshMe]);

  // accept an invite link (#invite=token) once logged in
  useEffect(() => {
    const m = window.location.hash.match(/invite=([a-f0-9]+)/);
    if (me && m) {
      fetch(`/api/invites/${m[1]}/accept`, { method: "POST" }).then(() => {
        history.replaceState(null, "", window.location.pathname);
        setProject(null);
      });
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
  if (!project) return <Projects me={me} onPick={(p) => { localStorage.setItem("pinet.project", p); setProject(p); }} onLogout={logout} />;
  return (
    <Board
      me={me}
      project={project}
      onLeave={() => { localStorage.removeItem("pinet.project"); setProject(null); }}
      onLogout={logout}
    />
  );
}

/* ---------- Auth (login / register / reset) ---------- */
function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<"user" | "agent">("user");
  const [token, setToken] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(""); setBusy(true);
    try {
      if (mode === "login" || mode === "register") {
        const body = mode === "register" ? { name, password, kind } : { name, password };
        const r = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        setMsg(r.ok ? "" : ((await r.json()).error || "failed"));
        if (r.ok) onDone();
      } else {
        if (!token) {
          const r = await fetch("/api/auth/reset/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
          const j = await r.json();
          setToken(j.reset_token || "");
          setMsg(j.reset_token ? "token generated — set a new password" : "if the account exists, a token was issued");
        } else {
          const r = await fetch("/api/auth/reset/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, next }) });
          setMsg(r.ok ? "password reset — log in" : ((await r.json()).error || "failed"));
          if (r.ok) { setMode("login"); setToken(""); setNext(""); }
        }
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="screen">
      <form className="auth card" onSubmit={submit}>
        <h1>pinet</h1>
        <div className="seg">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>log in</button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>register</button>
          <button type="button" className={mode === "reset" ? "on" : ""} onClick={() => setMode("reset")}>reset</button>
        </div>
        {mode !== "login" && mode !== "register" ? (
          <>
            <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            {token ? (
              <>
                <input placeholder="reset token" value={token} onChange={(e) => setToken(e.target.value)} />
                <input type="password" placeholder="new password" value={next} onChange={(e) => setNext(e.target.value)} />
              </>
            ) : null}
          </>
        ) : (
          <>
            <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <input type="password" placeholder="password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} />
            {mode === "register" && (
              <div className="seg">
                <button type="button" className={kind === "user" ? "on" : ""} onClick={() => setKind("user")}>human</button>
                <button type="button" className={kind === "agent" ? "on" : ""} onClick={() => setKind("agent")}>agent</button>
              </div>
            )}
          </>
        )}
        {msg && <div className={msg.includes("reset —") || msg.includes("generated") || msg.includes("issued") ? "muted" : "error"}>{msg}</div>}
        <button type="submit" className="primary" disabled={busy}>{mode === "reset" ? (token ? "set new password" : "get reset token") : mode}</button>
      </form>
    </div>
  );
}

/* ---------- Projects ---------- */
function Projects({ me, onPick, onLogout }: { me: Me; onPick: (p: string) => void; onLogout: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [nu, setNu] = useState("");
  const load = async () => { const r = await fetch("/api/projects"); if (r.ok) setNames((await r.json()).projects.map((p: { name: string }) => p.name)); };
  useEffect(() => { load(); }, []);
  const create = async () => {
    if (!nu.trim()) return;
    await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nu.trim() }) });
    setNu(""); load();
  };
  return (
    <div className="screen">
      <div className="card wide">
        <div className="topbar"><h1>projects</h1><div className="who">{me.name} · {me.kind} <button className="link" onClick={onLogout}>log out</button></div></div>
        <div className="proj-grid">
          {names.map((n) => <button key={n} className="proj-card" onClick={() => onPick(n)}>{n}</button>)}
          {names.length === 0 && <div className="muted">no projects yet — create one, then add members</div>}
        </div>
        <div className="row"><input placeholder="new project name" value={nu} onChange={(e) => setNu(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} /><button className="primary" onClick={create}>create</button></div>
      </div>
    </div>
  );
}

/* ---------- Board + members + account ---------- */
function Board({ me, project, onLeave, onLogout }: { me: Me; project: string; onLeave: () => void; onLogout: () => void }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [panel, setPanel] = useState<null | "members" | "account">(null);

  const P = encodeURIComponent(project);
  const load = async () => { const r = await fetch(`/api/projects/${P}/issues`); if (r.ok) setIssues((await r.json()).issues); };
  useEffect(() => { load(); }, [project]);

  const add = async () => { if (!draft.trim()) return; await fetch(`/api/projects/${P}/issues`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: draft }) }); setDraft(""); load(); };
  const move = async (it: Issue, to: string) => { await fetch(`/api/projects/${P}/issues/${it.slug}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: to }) }); load(); };
  const saveEdit = async () => { if (editing) { await fetch(`/api/projects/${P}/issues/${editing}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: editText }) }); setEditing(null); load(); } };
  const del = async (slug: string) => { await fetch(`/api/projects/${P}/issues/${slug}`, { method: "DELETE" }); load(); };
  const idx = (col: string) => ORDER.indexOf(col);

  return (
    <div className="board-screen">
      <div className="topbar">
        <button className="link" onClick={onLeave}>← projects</button>
        <h1>{project}</h1>
        <button className="link" onClick={() => setPanel(panel === "members" ? null : "members")}>members</button>
        <button className="link" onClick={() => setPanel(panel === "account" ? null : "account")}>account</button>
        <div className="who">{me.name}</div>
      </div>

      {panel === "members" && <Members project={project} me={me} />}
      {panel === "account" && <Account onLogout={onLogout} />}

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

function Members({ project, me }: { project: string; me: Me }) {
  const P = encodeURIComponent(project);
  const [members, setMembers] = useState<Member[]>([]);
  const [addName, setAddName] = useState("");
  const [addRole, setAddRole] = useState("member");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inst, setInst] = useState<{ name: string; text: string } | null>(null);
  const [err, setErr] = useState("");
  const load = async () => { const r = await fetch(`/api/projects/${P}/members`); if (r.ok) setMembers((await r.json()).members); };
  useEffect(() => { load(); }, [project]);
  const meRole = members.find((m) => m.name === me.name)?.role;
  const manager = meRole === "owner" || meRole === "admin";

  const add = async () => {
    setErr("");
    const r = await fetch(`/api/projects/${P}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: addName, role: addRole }) });
    if (!r.ok) setErr(((await r.json()).error));
    else { setAddName(""); load(); }
  };
  const setRole = async (name: string, role: string) => { await fetch(`/api/projects/${P}/members/${encodeURIComponent(name)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) }); load(); };
  const remove = async (name: string) => { await fetch(`/api/projects/${P}/members/${encodeURIComponent(name)}`, { method: "DELETE" }); load(); };
  const invite = async () => { const r = await fetch(`/api/projects/${P}/invites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "member" }) }); const j = await r.json(); setInviteUrl(`${location.origin}/#invite=${j.token}`); };
  const copyInst = async (m: Member) => {
    const snippet = `# pinet agent "${m.name}" — project "${project}" @ ${location.origin}
# replace «password» with the agent's password, then paste into the agent
export PINET_URL=${location.origin}
PROJ=${project}
TOK=\$(curl -s -X POST \$PINET_URL/api/auth/login -H 'Content-Type: application/json' -d '{"name":"${m.name}","password":"«password»"}' | sed -E 's/.*"token":"([^"]+)".*/\\1/')
G(){ curl -s -H "Authorization: Bearer \$TOK" \$PINET_URL\$1; }
PP(){ curl -s -X \${2:-POST} -H "Authorization: Bearer \$TOK" -H 'Content-Type: application/json' \$PINET_URL\$1 -d "\$3"; }
# read board:   G /api/projects/\$PROJ/issues
# add card:     PP /api/projects/\$PROJ/issues POST '{"text":"…"}'
# move card:    PP /api/projects/\$PROJ/issues/SLUG PATCH '{"state":"WIP"}'   # OPEN WIP FOR_REVIEW DONE
# delete card:  curl -s -X DELETE -H "Authorization: Bearer \$TOK" \$PINET_URL/api/projects/\$PROJ/issues/SLUG`;
    setInst({ name: m.name, text: snippet });
    try { await navigator.clipboard.writeText(snippet); } catch { /* clipboard blocked — textarea below for manual copy */ }
  };

  return (
    <div className="card panel">
      <div className="members">
        {members.map((m) => (
          <div className="member-wrap" key={m.name}>
            <div className="member">
              <span className="m-name">{m.name}</span>
              <span className={"role " + m.role}>{m.role}</span>
              <span className="muted kind">{m.kind}</span>
              {m.kind === "agent" && <button className="link" onClick={() => copyInst(m)}>copy</button>}
              {manager && m.role !== "owner" && (
                <>
                  <select value={m.role} onChange={(e) => setRole(m.name, e.target.value)}>{["member", "admin"].map((r) => <option key={r} value={r}>{r}</option>)}</select>
                  <button className="link" onClick={() => remove(m.name)}>remove</button>
                </>
              )}
            </div>
            {inst?.name === m.name && <textarea className="inst" readOnly value={inst.text} onFocus={(e) => e.target.select()} />}
          </div>
        ))}
      </div>
      {manager ? (
        <>
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="add existing user/agent by name" value={addName} onChange={(e) => setAddName(e.target.value)} />
            <select value={addRole} onChange={(e) => setAddRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
            <button className="primary" onClick={add}>add</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={invite}>create invite link</button>
            {inviteUrl && <input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />}
          </div>
        </>
      ) : (
        <div className="muted" style={{ marginTop: 8 }}>ask an owner/admin to add members</div>
      )}
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function Account({ onLogout }: { onLogout: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  const change = async () => {
    const r = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current: cur, next }) });
    setMsg(r.ok ? "password changed" : ((await r.json()).error || "failed"));
    if (r.ok) { setCur(""); setNext(""); }
  };
  return (
    <div className="card panel">
      <div className="row"><input type="password" placeholder="current password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
      <div className="row" style={{ marginTop: 6 }}><input type="password" placeholder="new password (min 8)" value={next} onChange={(e) => setNext(e.target.value)} /></div>
      <div className="row" style={{ marginTop: 8 }}><button className="primary" onClick={change}>change password</button><div className={msg === "password changed" ? "muted" : "error"}>{msg}</div></div>
      <div className="row" style={{ marginTop: 10 }}><button className="link" onClick={onLogout}>log out</button></div>
    </div>
  );
}
