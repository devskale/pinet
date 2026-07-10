"use client";

import { useEffect, useState } from "react";

type Issue = {
  slug: string;
  state: string;
  from: string;
  to: string | null;
  date: string;
  module: string | null;
  task: string;
  context: string;
  column: string;
  comments?: { author: string; date: string; text: string }[];
};

const COLS = [
  { col: "backlog", label: "Backlog" },
  { col: "active", label: "Active" },
  { col: "review", label: "Review" },
  { col: "archive", label: "Done" },
  { col: "cancelled", label: "Cancelled" },
];
const STATES = ["OPEN", "WIP", "FOR_REVIEW", "DONE", "CANCELLED"] as const;

export default function Board({ me }: { me: { handle: string } | null }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [slug, setSlug] = useState("");
  const [to, setTo] = useState("");
  const [task, setTask] = useState("");
  const [mod, setMod] = useState("");

  const load = async () => {
    const r = await fetch("/api/board");
    if (r.ok) setIssues((await r.json()).issues);
  };
  useEffect(() => {
    if (me) load();
  }, [me]);

  const create = async () => {
    if (!slug || !task) return;
    await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, to, task, module: mod || undefined }),
    });
    setSlug("");
    setTo("");
    setTask("");
    setMod("");
    load();
  };
  const move = async (s: string, state: string) => {
    await fetch(`/api/issues/${encodeURIComponent(s)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    load();
  };

  if (!me) return null;

  return (
    <>
      <h2>Board · new issue</h2>
      <div className="card">
        <div className="row">
          <input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ flex: "0 0 160px", width: "auto" }} />
          <input placeholder="to (e.g. mac@klark0)" value={to} onChange={(e) => setTo(e.target.value)} style={{ flex: "0 0 190px", width: "auto" }} />
          <input placeholder="module (klark0 / python-utils)" value={mod} onChange={(e) => setMod(e.target.value)} style={{ flex: "0 0 200px", width: "auto" }} />
        </div>
        <div className="row">
          <input placeholder="task" value={task} onChange={(e) => setTask(e.target.value)} />
          <button onClick={create}>create</button>
          <button className="ghost" onClick={load}>
            refresh
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Issues land in <code>backlog</code> (OPEN) addressed <code>from</code> you <code>to</code> the assignee.
        </p>
      </div>

      <h2>Board</h2>
      <div className="board">
        {COLS.map((c) => {
          const items = issues.filter((i) => i.column === c.col);
          return (
            <div key={c.col} className="col">
              <div className="col-head">
                <strong>{c.label}</strong> <span className="muted">{items.length}</span>
              </div>
              {items.map((i) => (
                <div key={i.slug} className="card card-sm">
                  <div className="slug">{i.slug}</div>
                  <div className="muted meta">
                    {i.from} → {i.to || "–"}
                    {i.module ? ` · ${i.module}` : ""}
                    {(i.comments?.length ?? 0) > 0 ? ` · 💬 ${i.comments?.length ?? 0}` : ""}
                  </div>
                  <div className="task">{i.task}</div>
                  <select defaultValue={i.state} onChange={(e) => move(i.slug, e.target.value)}>
                    {STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {items.length === 0 && <div className="muted empty">—</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}
