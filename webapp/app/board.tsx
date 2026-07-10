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
  const [sel, setSel] = useState<string | null>(null);
  const [comment, setComment] = useState("");
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
  const postComment = async () => {
    if (!sel || !comment.trim()) return;
    await fetch(`/api/issues/${encodeURIComponent(sel)}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: comment }),
    });
    setComment("");
    load();
  };

  if (!me) return null;
  const selected = issues.find((i) => i.slug === sel) || null;

  return (
    <>
      <h2>Board · new issue</h2>
      <div className="card">
        <div className="row">
          <input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ flex: "0 0 160px", width: "auto" }} />
          <input placeholder="to (e.g. mac@proj/frontend)" value={to} onChange={(e) => setTo(e.target.value)} style={{ flex: "0 0 200px", width: "auto" }} />
          <input placeholder="module" value={mod} onChange={(e) => setMod(e.target.value)} style={{ flex: "0 0 160px", width: "auto" }} />
        </div>
        <div className="row">
          <input placeholder="task" value={task} onChange={(e) => setTask(e.target.value)} />
          <button onClick={create}>create</button>
          <button className="ghost" onClick={load}>
            refresh
          </button>
        </div>
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
                <div key={i.slug} className={`card card-sm${selected?.slug === i.slug ? " selected" : ""}`}>
                  <div className="slug" onClick={() => setSel(i.slug)} style={{ cursor: "pointer" }}>
                    {i.slug}
                  </div>
                  <div className="muted meta">
                    {i.from} → {i.to || "–"}
                    {i.module ? ` · ${i.module}` : ""}
                    {(i.comments?.length ?? 0) > 0 ? ` · 💬 ${i.comments?.length}` : ""}
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

      {selected && (
        <>
          <h2>
            {selected.slug}{" "}
            <button className="ghost" style={{ marginLeft: 8 }} onClick={() => setSel(null)}>
              close
            </button>
          </h2>
          <div className="card">
            <div className="muted meta" style={{ marginBottom: 8 }}>
              [{selected.state}] · {selected.column} · {selected.from} → {selected.to || "–"}
              {selected.module ? ` · ${selected.module}` : ""} · {selected.date}
            </div>
            <h3 className="sub-h">Task</h3>
            <div className="task">{selected.task}</div>
            {selected.context && (
              <>
                <h3 className="sub-h">Context</h3>
                <div className="task">{selected.context}</div>
              </>
            )}
            <h3 className="sub-h">Comments ({selected.comments?.length ?? 0})</h3>
            <div className="comments">
              {(selected.comments ?? []).map((c, idx) => (
                <div key={idx} className="comment">
                  <div className="muted meta">
                    <strong>{c.author}</strong> · {c.date}
                  </div>
                  <div>{c.text}</div>
                </div>
              ))}
              {(selected.comments ?? []).length === 0 && <div className="muted empty">no comments</div>}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <input
                placeholder="add a comment…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && postComment()}
              />
              <button onClick={postComment}>comment</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
