import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  isDbInitialized: vi.fn(() => true),
  listTenants: vi.fn(async () => ({ tenants: [], total: 0 })),
  getTenantById: vi.fn(async () => null),
  updateTenant: vi.fn(async () => null),
  getPlanQuotas: vi.fn(async () => ({
    maxUsers: 10,
    maxAgents: 5,
    maxChannels: 5,
    maxTokensPerMonth: 1_000_000,
  })),
  createAuditLog: vi.fn(async () => {}),
}));

vi.mock("../../db/index.js", () => ({ isDbInitialized: mocks.isDbInitialized }));
vi.mock("../../db/models/tenant.js", () => ({
  listTenants: mocks.listTenants,
  getTenantById: mocks.getTenantById,
  updateTenant: mocks.updateTenant,
  getPlanQuotas: mocks.getPlanQuotas,
}));
vi.mock("../../db/models/audit-log.js", () => ({ createAuditLog: mocks.createAuditLog }));

const { platformTenantsHandlers } = await import("./platform-tenants-api.js");

// ── helpers ──────────────────────────────────────────────────────────

function makeAdminClient() {
  return {
    connect: { role: "operator", scopes: ["operator.admin"] },
    tenant: { role: "platform-admin", tenantId: "platform", userId: "admin-1" },
  };
}

function makeCall(
  method: keyof typeof platformTenantsHandlers,
  params: Record<string, unknown> = {},
  client: unknown = makeAdminClient(),
) {
  const respond = vi.fn();
  const handler = platformTenantsHandlers[method];
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

// ── tests ─────────────────────────────────────────────────────────────

describe("platform.tenants.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDbInitialized.mockReturnValue(true);
  });

  it("rejects non-platform-admin", async () => {
    const client = {
      connect: { role: "operator" },
      tenant: { role: "owner", tenantId: "t1", userId: "u1" },
    };
    const { respond, promise } = makeCall("platform.tenants.list", {}, client);
    await promise;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("Platform admin") }),
    );
  });

  it("returns tenant list", async () => {
    const tenant = {
      id: "t1",
      name: "Acme",
      plan: "free",
      status: "active",
      quotas: {},
      createdAt: new Date(),
    };
    mocks.listTenants.mockResolvedValueOnce({ tenants: [tenant], total: 1 });
    const { respond, promise } = makeCall("platform.tenants.list", { limit: 10 });
    await promise;
    expect(respond).toHaveBeenCalledWith(true, { tenants: [tenant], total: 1 });
    expect(mocks.listTenants).toHaveBeenCalledWith({ status: undefined, limit: 10, offset: 0 });
  });
});

describe("platform.tenants.get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDbInitialized.mockReturnValue(true);
  });

  it("returns 404 when tenant not found", async () => {
    mocks.getTenantById.mockResolvedValueOnce(null);
    const { respond, promise } = makeCall("platform.tenants.get", { tenantId: "missing" });
    await promise;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Tenant not found" }),
    );
  });

  it("returns tenant", async () => {
    const tenant = {
      id: "t1",
      name: "Acme",
      plan: "free",
      status: "active",
      quotas: {},
      createdAt: new Date(),
    };
    mocks.getTenantById.mockResolvedValueOnce(tenant);
    const { respond, promise } = makeCall("platform.tenants.get", { tenantId: "t1" });
    await promise;
    expect(respond).toHaveBeenCalledWith(true, tenant);
  });
});

describe("platform.tenants.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDbInitialized.mockReturnValue(true);
  });

  it("merges plan defaults with custom quotas", async () => {
    const updatedTenant = {
      id: "t1",
      plan: "pro",
      quotas: { maxUsers: 50, maxAgents: 20, maxChannels: 20, maxTokensPerMonth: 99 },
      status: "active",
    };
    mocks.updateTenant.mockResolvedValueOnce(updatedTenant);
    const { respond, promise } = makeCall("platform.tenants.update", {
      tenantId: "t1",
      plan: "pro",
      quotas: { maxTokensPerMonth: 99 },
    });
    await promise;
    expect(mocks.getPlanQuotas).toHaveBeenCalledWith("pro");
    expect(mocks.updateTenant).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        plan: "pro",
        quotas: expect.objectContaining({ maxTokensPerMonth: 99 }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, updatedTenant);
  });

  it("writes audit log on success", async () => {
    const tenant = { id: "t1", plan: "pro", quotas: {}, status: "active" };
    mocks.updateTenant.mockResolvedValueOnce(tenant);
    const { promise } = makeCall("platform.tenants.update", { tenantId: "t1", plan: "pro" });
    await promise;
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.tenant.update" }),
    );
  });
});

describe("platform.tenants.suspend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDbInitialized.mockReturnValue(true);
  });

  it("sets status to suspended", async () => {
    mocks.updateTenant.mockResolvedValueOnce({ id: "t1", status: "suspended" });
    const { respond, promise } = makeCall("platform.tenants.suspend", { tenantId: "t1" });
    await promise;
    expect(mocks.updateTenant).toHaveBeenCalledWith("t1", { status: "suspended" });
    expect(respond).toHaveBeenCalledWith(true, { id: "t1", status: "suspended" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.tenant.suspend" }),
    );
  });
});

describe("platform.tenants.unsuspend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDbInitialized.mockReturnValue(true);
  });

  it("sets status to active", async () => {
    mocks.updateTenant.mockResolvedValueOnce({ id: "t1", status: "active" });
    const { respond, promise } = makeCall("platform.tenants.unsuspend", { tenantId: "t1" });
    await promise;
    expect(mocks.updateTenant).toHaveBeenCalledWith("t1", { status: "active" });
    expect(respond).toHaveBeenCalledWith(true, { id: "t1", status: "active" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.tenant.unsuspend" }),
    );
  });
});
