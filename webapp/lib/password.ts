/** Password policy: length only (modern guidance — no mandatory complexity rules). */
export function passwordError(pw: string): string | null {
  if (!pw) return "password required";
  if (pw.length < 8) return "password must be at least 8 characters";
  if (pw.length > 1024) return "password too long";
  return null;
}
