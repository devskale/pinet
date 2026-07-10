import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");

export const STATE_COLUMN: Record<string, string> = {
  OPEN: "backlog",
  WIP: "active",
  FOR_REVIEW: "review",
  DONE: "archive",
  CANCELLED: "cancelled",
};
export const COLUMN_STATE: Record<string, string> = {
  backlog: "OPEN",
  active: "WIP",
  review: "FOR_REVIEW",
  archive: "DONE",
  cancelled: "CANCELLED",
};
export const COLUMNS = ["backlog", "active", "review", "archive", "cancelled"];
export const VALID_STATES = new Set(Object.keys(STATE_COLUMN));

export interface Issue {
  slug: string;
  state: string;
  from: string;
  date: string;
  text: string;
  column: string;
}

function dirFor(project: string) {
  return path.join(DATA_DIR, project, "issues");
}
function ensureColumns(project: string) {
  for (const c of COLUMNS) fs.mkdirSync(path.join(dirFor(project), c), { recursive: true });
}
function slugify(text: string): string {
  const base =
    text
      .toLowerCase()
      .split("\n")[0]
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "card";
  return base;
}

function parse(text: string): { state: string; from: string; date: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { state: "OPEN", from: "", date: "", body: text.trim() };
  const fm: Record<string, string> = {};
  for (const line of (m[1] || "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { state: fm.state || "OPEN", from: fm.from || "", date: fm.date || "", body: (m[2] || "").trim() };
}
function serialize(i: { state: string; from: string; date: string; text: string }): string {
  return `---\nstate: ${i.state}\nfrom: ${i.from}\ndate: ${i.date}\n---\n${i.text}\n`;
}
function read(file: string, column: string): Issue {
  const p = parse(fs.readFileSync(file, "utf8"));
  return { slug: path.basename(file, ".md"), state: p.state, from: p.from, date: p.date, text: p.body, column };
}

export function list(project: string): Issue[] {
  ensureColumns(project);
  const out: Issue[] = [];
  for (const col of COLUMNS) {
    const d = path.join(dirFor(project), col);
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md")).sort()) {
      try {
        out.push(read(path.join(d, f), col));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}
export function find(project: string, slug: string): Issue | undefined {
  for (const col of COLUMNS) {
    const f = path.join(dirFor(project), col, `${slug}.md`);
    if (fs.existsSync(f)) return read(f, col);
  }
  return undefined;
}
export function create(project: string, from: string, text: string): Issue {
  ensureColumns(project);
  let slug = slugify(text);
  let n = 1;
  while (fs.existsSync(path.join(dirFor(project), "backlog", `${slug}.md`))) slug = `${slugify(text)}-${++n}`;
  const file = path.join(dirFor(project), "backlog", `${slug}.md`);
  fs.writeFileSync(
    file,
    serialize({ state: "OPEN", from, date: new Date().toISOString().slice(0, 10), text: text.trim() }),
  );
  return read(file, "backlog");
}
export function move(project: string, slug: string, state: string): Issue {
  if (!VALID_STATES.has(state)) throw new Error(`invalid state '${state}'`);
  const it = find(project, slug);
  if (!it) throw new Error(`issue '${slug}' not found`);
  const newCol = STATE_COLUMN[state];
  if (it.column === newCol && it.state === state) return it;
  const src = path.join(dirFor(project), it.column, `${slug}.md`);
  const dst = path.join(dirFor(project), newCol, `${slug}.md`);
  fs.writeFileSync(dst, serialize({ state, from: it.from, date: it.date, text: it.text }));
  if (src !== dst) fs.unlinkSync(src);
  return read(dst, newCol);
}
export function setText(project: string, slug: string, text: string): Issue {
  const it = find(project, slug);
  if (!it) throw new Error(`issue '${slug}' not found`);
  const file = path.join(dirFor(project), it.column, `${slug}.md`);
  fs.writeFileSync(file, serialize({ state: it.state, from: it.from, date: it.date, text: text.trim() }));
  return read(file, it.column);
}
export function remove(project: string, slug: string): void {
  const it = find(project, slug);
  if (!it) throw new Error(`issue '${slug}' not found`);
  fs.unlinkSync(path.join(dirFor(project), it.column, `${slug}.md`));
}
