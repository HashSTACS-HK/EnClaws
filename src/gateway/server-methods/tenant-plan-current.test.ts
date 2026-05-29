import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  isDbInitialized: vi.fn(() => true),
  getTenantById: vi.fn(async () => ({
    id: "t1",
    plan: "free",
    status: "active",
    quotas: { maxUsers: 10, maxAgents: 5, maxChannels: 5, maxTokensPerMonth: 1_000_000 },
  })),
  checkTenantQuota: vi.fn(async (_tid: string, _res: string) => ({
    allowed: true,
    current: 2,
    max: 10,
  })),
  getMonthlyTokenUsage: vi.fn(async () => 50000),
}));

vi.mock("../../db/index.js", () => ({ isDbInitialized: mocks.isDbInitialized }));
vi.mock("../../db/models/tenant.js", () => ({
  getTenantById: mocks.getTenantById,
  checkTenantQuota: mocks.checkTenantQuota,
  getMonthlyTokenUsage: mocks.getMonthlyTokenUsage,
  updateTenant: vi.fn(),
}));
vi.mock("../../db/models/audit-log.js", () => ({ createAuditLog: vi.fn() }));
vi.mock("../../db/models/user.js", () => ({
  createUser: vi.fn(),
  listUsers: vi.fn(async () => ({ users: [], total: 0 })),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserById: vi.fn(),
  findUserByEmail: vi.fn(),
}));
vi.mock("../../auth/password-policy.js", () => ({
  validatePasswordStrength: vi.fn(() => ({ ok: true })),
}));
vi.mock("../../auth/rbac.js", () => ({
  assertPermission: vi.fn(),
  RbacError: class RbacError extends Error {},
}));

const { tenantHandlers } = await import("./tenant-api.js");

function makeOwnerClient() {
  return {
    connect: { role: "operator", scopes: [] },
    tenant: { role: "owner", tenantId: "t1", userId: "u1" },
  };
}

function makeCall(
  method: string,
  params: Record<string, unknown> = {},
  client: unknown = makeOwnerClient(),
) {
  const respond = vi.fn();
  const handler = (tenantHandlers as Record<string, Function>)[method];
  const promise = handler({
    params,
    respond,
    client: client as never,
    context: {} as never,
    req: { type: "req" as const, id: "1", method },
    isWebchatConnect: () => false,
  });
  return { respond, promise };
}

describe("tenant.plan.current", () => {
  it("returns plan, status, quotas, and usage", async () => {
    mocks.checkTenantQuota
      .mockResolvedValueOnce({ allowed: true, current: 3, max: 10 }) // users
      .mockResolvedValueOnce({ allowed: true, current: 1, max: 5 }) // agents
      .mockResolvedValueOnce({ allowed: true, current: 2, max: 5 }); // channels

    const { respond, promise } = makeCall("tenant.plan.current");
    await promise;

    expect(respond).toHaveBeenCalledWith(true, {
      plan: "free",
      status: "active",
      quotas: { maxUsers: 10, maxAgents: 5, maxChannels: 5, maxTokensPerMonth: 1_000_000 },
      usage: {
        users: { current: 3, max: 10 },
        agents: { current: 1, max: 5 },
        channels: { current: 2, max: 5 },
        tokensThisMonth: { current: 50000, max: 1_000_000 },
      },
    });
  });
});
