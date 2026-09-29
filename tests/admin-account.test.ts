import { describe, expect, it } from "vitest";

import * as adminAccount from "../scripts/admin-account.mjs";

interface ResolvedAdmin {
  email: string;
  displayName: string;
  password: string;
  canCreate: boolean;
}

const resolveAdminAccount = adminAccount.resolveAdminAccount as (
  env?: Record<string, string | undefined>,
) => ResolvedAdmin;

describe("seeded admin account", () => {
  it("resolves ADMIN_EMAIL with the documented default", () => {
    const admin = resolveAdminAccount({});
    expect(admin.email).toBe("zakaria@nrapken.dev");
    expect(admin.email).toBe(adminAccount.DEFAULT_ADMIN_EMAIL);
    expect(admin.displayName).toBe("Zakaria");
  });

  it("defaults display name independently of a custom email", () => {
    const admin = resolveAdminAccount({ ADMIN_EMAIL: "owner@example.com" });
    expect(admin.email).toBe("owner@example.com");
    expect(admin.displayName).toBe("Zakaria");
  });

  it("skips creation when ADMIN_PASSWORD is absent or blank", () => {
    for (const env of [{}, { ADMIN_PASSWORD: "" }, { ADMIN_PASSWORD: "   " }]) {
      const admin = resolveAdminAccount(env);
      expect(admin.canCreate).toBe(false);
      expect(admin.password).toBe(env.ADMIN_PASSWORD ?? "");
    }
  });

  it("enables creation when ADMIN_PASSWORD is present", () => {
    const admin = resolveAdminAccount({
      ADMIN_EMAIL: "  Owner@Example.com ",
      ADMIN_DISPLAY_NAME: " Owner ",
      ADMIN_PASSWORD: "s3cret-pass",
    });
    expect(admin.email).toBe("owner@example.com");
    expect(admin.displayName).toBe("Owner");
    expect(admin.canCreate).toBe(true);
    expect(admin.password).toBe("s3cret-pass");
  });

  it("lists both legacy demo accounts for migration", () => {
    expect(adminAccount.LEGACY_DEMO_EMAILS).toContain("trader@marketpulse.dev");
    expect(adminAccount.LEGACY_DEMO_EMAILS).toContain("demo@marketpulse.dev");
  });
});
