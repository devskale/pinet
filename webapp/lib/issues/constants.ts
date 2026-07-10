// state <-> column is 1:1 (kontext.one model)
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
export const LIVE_COLUMNS = ["backlog", "active", "review"];
export const ALL_COLUMNS = ["backlog", "active", "review", "archive", "cancelled"];
export const VALID_STATES = new Set(Object.keys(STATE_COLUMN));
