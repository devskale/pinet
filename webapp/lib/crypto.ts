import { createHash } from "node:crypto";

/** sha256 hex — for hashing reset/invite tokens at rest (raw token shown once). */
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
