/**
 * Password hashing using bcrypt.
 *
 * The frontend SHA-256 hashes passwords before sending them over the
 * wire (see `hashPasswordForTransport` in auth-store.ts).  This means
 * passwords stored in the DB are `bcrypt(SHA-256(plaintext))`.
 *
 * Server-side code that generates passwords (CLI reset, ENV trigger,
 * admin reset) must also pre-hash with SHA-256 before bcrypt so that
 * the stored hash matches what the frontend will send during login.
 */

import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

/**
 * SHA-256 hash a plaintext password — mirrors the frontend's
 * `hashPasswordForTransport()`.  Returns lowercase hex.
 */
export function sha256Hex(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

/**
 * Hash a password for storage: SHA-256 first (transport prehash),
 * then bcrypt.  This is the canonical storage format.
 */
export async function hashPassword(password: string): Promise<string> {
  // If the input is already a 64-char hex (pre-hashed by frontend),
  // bcrypt it directly.  Otherwise, SHA-256 first then bcrypt.
  const toHash = /^[0-9a-f]{64}$/.test(password) ? password : sha256Hex(password);
  return bcrypt.hash(toHash, SALT_ROUNDS);
}

/**
 * Verify a password against a stored bcrypt hash.
 * The `password` param may be either:
 *   - a 64-char SHA-256 hex (from the frontend)
 *   - plaintext (from tests or non-browser clients)
 * We try the value as-is first; for non-hex inputs we also try the
 * SHA-256 to support both paths.
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  // If it's already a SHA-256 hex (from frontend), compare directly
  if (/^[0-9a-f]{64}$/.test(password)) {
    return bcrypt.compare(password, hash);
  }
  // Plaintext: try SHA-256(plaintext) first (matches frontend-registered passwords),
  // then fall back to raw plaintext (matches legacy/test passwords)
  if (await bcrypt.compare(sha256Hex(password), hash)) {return true;}
  return bcrypt.compare(password, hash);
}
