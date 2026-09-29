// Pure, dependency-free helpers that decide which single account the seed
// creates. Kept out of `seed.mjs` so both the release-time seed and the unit
// suite can import it without running the seeder.

/** Default email of the single seeded owner account. */
export const DEFAULT_ADMIN_EMAIL = "zakaria@nrapken.dev";

/** Default display name of the single seeded owner account. */
export const DEFAULT_ADMIN_DISPLAY_NAME = "Zakaria";

/**
 * Accounts created by earlier versions of the seed. On every run the seeder
 * moves their watchlists/alert rules to the admin account and removes them.
 */
export const LEGACY_DEMO_EMAILS = ["trader@marketpulse.dev", "demo@marketpulse.dev"];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the admin account from the environment. A password is never
 * defaulted or generated: when `ADMIN_PASSWORD` is absent the account is not
 * created (`canCreate: false`) and the seeder skips it while still seeding the
 * market dataset.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ email: string, displayName: string, password: string, canCreate: boolean }}
 */
export function resolveAdminAccount(env = {}) {
  const email = (nonEmpty(env.ADMIN_EMAIL) ?? DEFAULT_ADMIN_EMAIL).toLowerCase();
  const displayName = nonEmpty(env.ADMIN_DISPLAY_NAME) ?? DEFAULT_ADMIN_DISPLAY_NAME;
  const password = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  return {
    email,
    displayName,
    password,
    // A blank/whitespace-only password counts as absent. Real passwords are
    // never trimmed.
    canCreate: password.trim().length > 0,
  };
}
