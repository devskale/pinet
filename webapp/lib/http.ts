/** Tiny response helpers to keep route handlers terse. */
export const err = (message: string, status = 400) => Response.json({ error: message }, { status });
export const ok = (body: unknown) => Response.json(body);
