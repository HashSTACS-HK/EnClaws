/**
 * Standalone user quota error class.
 *
 * Lives in its own file to break a potential circular import: both
 * `db/models/user.ts` (PG) and `db/sqlite/models/user.ts` (SQLite) need
 * to throw the same class so upstream `instanceof` checks work, but they
 * already cross-import each other for the createUser/listUsers dispatch
 * pattern. Putting the class here avoids the cycle.
 */
export class UserQuotaExceededError extends Error {
  readonly resource = "users" as const;
  constructor(
    public readonly current: number,
    public readonly max: number,
  ) {
    super(`User quota reached (${current}/${max})`);
    this.name = "UserQuotaExceededError";
  }
}
