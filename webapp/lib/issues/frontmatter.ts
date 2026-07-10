/** The mutable, serializable payload of an issue (frontmatter + body). */
export interface IssueData {
  state: string;
  from: string;
  to: string | null;
  date: string;
  module: string | null;
  task: string;
  context: string;
}

/** An issue as read from disk (payload + location metadata). */
export interface Issue extends IssueData {
  slug: string;
  column: string;
  path: string; // relative to DATA_DIR
}

/** Parse a `---\nkey: value\n---\nbody` file into frontmatter map + body. */
export function parseFrontmatter(text: string): { fm: Record<string, string | null>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text.trim() };
  const fm: Record<string, string | null> = {};
  for (const line of (m[1] || "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      fm[line.slice(0, i).trim()] = v === "" ? null : v;
    }
  }
  return { fm, body: (m[2] || "").trim() };
}

/** Extract a `## Header` section's contents from a markdown body. */
export function section(body: string, header: string): string {
  const re = new RegExp(`## ${header}\\s*\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`);
  return (body.match(re)?.[1] || "").trim();
}

/** Serialize issue data back to the on-disk markdown format. */
export function serialize(i: IssueData): string {
  const lines = ["---", `state: ${i.state}`, `from: ${i.from}`];
  if (i.to) lines.push(`to: ${i.to}`);
  lines.push(`date: ${i.date}`);
  if (i.module) lines.push(`module: ${i.module}`);
  lines.push("---");
  return `${lines.join("\n")}\n\n## Task\n${i.task}\n\n## Context\n${i.context}\n`;
}
