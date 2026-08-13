/**
 * Centralised, typed environment configuration.
 *
 * Loaded once at startup so that misconfiguration crashes the process
 * immediately rather than surfacing as a confusing failure inside a
 * request handler under load. Everywhere downstream, config values are
 * already parsed and correctly typed.
 */

export interface AppConfig {
  port: number;
  databaseUrl: string;
  authEnabled: boolean;
  loadgenApiKey: string | null;
  retentionDays: number;
  rollupEnabled: boolean;
}

/**
 * Only the exact string "true" enables a flag. Anything ambiguous
 * resolves to the fallback. This matters for AUTH_ENABLED: the spec
 * requires a bare `docker compose up` to produce an open service, so
 * unclear input must fail toward the safe default rather than
 * accidentally locking out the load generator.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value.toLowerCase() === "true";
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid environment variable ${name}: "${value}" is not a positive integer`);
  }
  return parsed;
}

/**
 * Takes the environment as a parameter rather than reading the global
 * directly, so tests can supply their own without mutating process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required but was not set");
  }

  const apiKey = env.LOADGEN_API_KEY;

  return {
    port: parsePositiveInt(env.PORT, 8080, "PORT"),
    databaseUrl,
    authEnabled: parseBoolean(env.AUTH_ENABLED, false),
    // Normalise unset and empty to a single absent value, so consumers
    // handle one case instead of three.
    loadgenApiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : null,
    retentionDays: parsePositiveInt(env.RETENTION_DAYS, 30, "RETENTION_DAYS"),
    // Pre-aggregation is background work on the database. It is
    // configurable so its cost can be measured against environments with
    // different storage characteristics.
    rollupEnabled: parseBoolean(env.ROLLUP_ENABLED, true),
  };
}
