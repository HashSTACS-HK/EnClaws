export class UserSuspendedError extends Error {
  constructor(
    public readonly userId: string,
    public readonly status: string,
  ) {
    super(`User ${userId} is ${status}`);
    this.name = "UserSuspendedError";
  }
}
