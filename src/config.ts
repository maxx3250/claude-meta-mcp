/**
 * Environment configuration loader.
 *
 * Reads required variables from process.env, validates them, and exposes a
 * single typed `config` object for the rest of the codebase.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function optionalInt(name: string): number | undefined {
  const value = process.env[name];
  if (!value || value.trim() === "") return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (cents), got "${value}"`);
  }
  return n;
}

export const config = {
  port: parseInt(optional("PORT", "3210"), 10),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",
  meta: {
    accessToken: required("META_ACCESS_TOKEN"),
    apiVersion: optional("META_API_VERSION", "v26.0"),
  },
  /**
   * Bearer token a client must present in the Authorization header when
   * calling /mcp. In v0.1 (single-tenant), this is a single shared secret.
   * v0.2 will replace this with proper OAuth 2.1 + DCR.
   */
  authToken: required("AUTH_TOKEN"),
  publicUrl: optional("PUBLIC_URL", "http://localhost:3210"),
  /**
   * Hard budget caps in account-currency cents. Undefined = no cap. Enforced
   * server-side on create_campaign / create_adset / update_campaign /
   * update_adset — a conversation cannot override them.
   */
  limits: {
    maxDailyBudgetCents: optionalInt("MAX_DAILY_BUDGET_CENTS"),
    maxLifetimeBudgetCents: optionalInt("MAX_LIFETIME_BUDGET_CENTS"),
  },
} as const;

export type Config = typeof config;
