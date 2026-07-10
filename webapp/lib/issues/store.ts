import fs from "node:fs";
import path from "node:path";
import { ALL_COLUMNS, STATE_COLUMN, VALID_STATES } from "./constants";
import { parseComments, parseFrontmatter, section, serialize, type Comment, type Issue } from "./frontmatter";

const DATA_DIR = path.join(process.cwd(), "data");

function issuesRoot(projectName: string) {
  return path.join(DATA_DIR, projectName, "issues");
}
function ensureColumns(projectName: string) {
  for (const col of ALL_COLUMNS) fs.mkdirSync(path.join(issuesRoot(projectName), col), { recursive: true });
}

function readIssue(filePath: string, column: string): Issue {
  const text = fs.readFileSync(filePath, "utf8");
  const { fm, body } = parseFrontmatter(text);
  return {
    slug: path.basename(filePath, ".md"),
    state: fm.state || "OPEN",
    from: fm.from || "",
    to: fm.to ?? null,
    date: fm.date || "",
    module: fm.module ?? null,
    task: section(body, "Task"),
    context: section(body, "Context"),
    comments: parseComments(body),
    column,
    path: path.relative(DATA_DIR, filePath),
  };
}

export function listIssues(projectName: string, filter?: (i: Issue) => boolean): Issue[] {
  ensureColumns(projectName);
  const out: Issue[] = [];
  for (const col of ALL_COLUMNS) {
    const dir = path.join(issuesRoot(projectName), col);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      try {
        const i = readIssue(path.join(dir, f), col);
        if (!filter || filter(i)) out.push(i);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

export function findIssue(projectName: string, slug: string): Issue | undefined {
  for (const col of ALL_COLUMNS) {
    const p = path.join(issuesRoot(projectName), col, `${slug}.md`);
    if (fs.existsSync(p)) return readIssue(p, col);
  }
  return undefined;
}

export function createIssue(
  projectName: string,
  opts: { slug: string; from: string; to?: string | null; task: string; context?: string; module?: string | null },
): Issue {
  ensureColumns(projectName);
  const file = path.join(issuesRoot(projectName), "backlog", `${opts.slug}.md`);
  if (fs.existsSync(file)) throw new Error(`issue '${opts.slug}' already exists`);
  fs.writeFileSync(
    file,
    serialize({
      state: "OPEN",
      from: opts.from,
      to: opts.to ?? null,
      date: new Date().toISOString().slice(0, 10),
      module: opts.module ?? null,
      task: opts.task,
      context: opts.context || "",
      comments: [],
    }),
  );
  return readIssue(file, "backlog");
}

export function moveIssue(projectName: string, slug: string, newState: string): Issue {
  if (!VALID_STATES.has(newState)) throw new Error(`invalid state '${newState}'`);
  const issue = findIssue(projectName, slug);
  if (!issue) throw new Error(`issue '${slug}' not found`);
  const newCol = STATE_COLUMN[newState];
  if (issue.column === newCol && issue.state === newState) return issue;

  const src = path.join(DATA_DIR, issue.path);
  const dst = path.join(issuesRoot(projectName), newCol, `${slug}.md`);
  const { fm, body } = parseFrontmatter(fs.readFileSync(src, "utf8"));
  fs.writeFileSync(
    dst,
    serialize({
      state: newState,
      from: fm.from || issue.from,
      to: fm.to ?? issue.to,
      date: fm.date || issue.date,
      module: fm.module ?? issue.module,
      task: section(body, "Task"),
      context: section(body, "Context"),
      comments: parseComments(body), // preserved across moves
    }),
  );
  if (src !== dst) fs.unlinkSync(src);
  return readIssue(dst, newCol);
}

export function addComment(projectName: string, slug: string, author: string, text: string): Issue {
  const issue = findIssue(projectName, slug);
  if (!issue) throw new Error(`issue '${slug}' not found`);
  const comment: Comment = {
    author,
    date: new Date().toISOString().slice(0, 16).replace("T", " "),
    text,
  };
  const file = path.join(DATA_DIR, issue.path);
  fs.writeFileSync(
    file,
    serialize({
      state: issue.state,
      from: issue.from,
      to: issue.to,
      date: issue.date,
      module: issue.module,
      task: issue.task,
      context: issue.context,
      comments: [...issue.comments, comment],
    }),
  );
  return readIssue(file, issue.column);
}
