/**
 * Role names as the platform stores them.
 *
 * The `users.roles` column is JSON text written by hand and by seed scripts, so the
 * casing in the database has never been guaranteed. Every check therefore goes through
 * `hasRole` rather than `roles.includes(...)`: an exact-lowercase comparison silently
 * denied a genuine ADMIN the admin console (the role is stored `ADMIN`), and a silent
 * authorisation failure is far worse than a loud one.
 */
export const ROLES = ['CUSTOMER', 'MERCHANT', 'ADMIN', 'SUPPORT', 'COMPLIANCE', 'REVIEWER', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

export function hasRole(held: readonly string[] | null | undefined, role: string): boolean {
  const want = String(role ?? '').trim().toUpperCase();
  if (!want) return false;
  return (held ?? []).some((r) => String(r).trim().toUpperCase() === want);
}

export function hasAnyRole(held: readonly string[] | null | undefined, roles: readonly string[]): boolean {
  return roles.some((r) => hasRole(held, r));
}

/** Normalised for storage: one canonical shape so the column stops drifting. */
export function normalizeRoles(roles: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const r of roles) {
    const v = String(r ?? '').trim().toUpperCase();
    if (v) seen.add(v);
  }
  return [...seen];
}
