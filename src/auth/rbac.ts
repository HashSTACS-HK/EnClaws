/**
 * Role-Based Access Control (RBAC) for multi-tenant gateway.
 */

import type { UserRole, Permission } from "../db/types.js";
import { PERMISSIONS } from "../db/types.js";

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: UserRole, permission: Permission): boolean {
  const allowedRoles = PERMISSIONS[permission];
  if (!allowedRoles) {return false;}
  return (allowedRoles as readonly string[]).includes(role);
}

/**
 * Assert that a role has a specific permission. Throws if not.
 */
export function assertPermission(role: UserRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new RbacError(
      `Permission denied: role '${role}' does not have '${permission}'`,
      permission,
      role,
    );
  }
}

/**
 * Get all permissions for a role.
 */
export function getPermissionsForRole(role: UserRole): Permission[] {
  return (Object.entries(PERMISSIONS) as [Permission, readonly UserRole[]][])
    .filter(([_, roles]) => roles.includes(role))
    .map(([perm]) => perm);
}

/**
 * Map multi-tenant RBAC roles to existing gateway scopes.
 * This bridges the new RBAC system with the existing operator scope system.
 */
export function mapRoleToGatewayScopes(role: UserRole): string[] {
  switch (role) {
    case "platform-admin":
      return [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ];
    case "owner":
      return [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ];
    case "admin":
      return [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
      ];
    case "member":
      return ["operator.read", "operator.write"];
    case "viewer":
      return ["operator.read"];
    default:
      return [];
  }
}

/**
 * Map a gateway RPC method to the required multi-tenant permission.
 */
export function mapMethodToPermission(method: string): Permission | null {
  // Agent methods
  if (method === "agents.list" || method === "agent.identity.get") {return "agent.list";}
  if (method === "agents.create") {return "agent.create";}
  if (method === "agents.update") {return "agent.update";}
  if (method === "agents.delete") {return "agent.delete";}

  // Session methods
  if (method === "sessions.list" || method === "sessions.preview") {return "session.list";}
  if (method === "sessions.reset" || method === "sessions.delete") {return "session.delete";}

  // Config methods
  if (method.startsWith("config.get")) {return "config.read";}
  if (method.startsWith("config.")) {return "config.write";}

  // Chat methods — general use permission
  if (method.startsWith("chat.")) {return "agent.use";}

  // Channel methods
  if (method === "channels.status") {return "channel.list";}
  if (method === "channels.logout") {return "channel.delete";}

  // Skill methods
  if (method === "skills.status") {return "skill.list";}
  if (method === "skills.update") {return "skill.update";}
  if (method === "skills.install") {return "skill.install";}

  // Platform methods
  if (method.startsWith("platform.")) {return "platform.overview";}

  // Default: allow if authenticated (no specific permission required)
  return null;
}

export class RbacError extends Error {
  constructor(
    message: string,
    public readonly permission: Permission,
    public readonly role: UserRole,
  ) {
    super(message);
    this.name = "RbacError";
  }
}
