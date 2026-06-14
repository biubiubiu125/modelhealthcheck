import "server-only";

export type PostgresSslMode = "disable" | "require";

export interface PostgresSslResolution {
  mode: PostgresSslMode;
  ssl: false | {rejectUnauthorized: boolean};
}

const LOCAL_POSTGRES_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
  "check-cx-postgres",
  "modelhealthcheck-postgres",
]);

function normalizeSslMode(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function isLocalPostgresHost(hostname: string): boolean {
  return LOCAL_POSTGRES_HOSTS.has(hostname.toLowerCase());
}

function isSingleLabelHost(hostname: string): boolean {
  const normalized = hostname.trim();
  return Boolean(normalized) && !normalized.includes(".");
}

export function resolvePostgresSsl(connectionString: string): PostgresSslResolution {
  const url = new URL(connectionString);
  const sslMode = normalizeSslMode(url.searchParams.get("sslmode"));

  if (sslMode === "disable") {
    return {mode: "disable", ssl: false};
  }

  if (sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full") {
    return {mode: "require", ssl: {rejectUnauthorized: sslMode !== "require"}};
  }

  if (isLocalPostgresHost(url.hostname) || isSingleLabelHost(url.hostname)) {
    return {mode: "disable", ssl: false};
  }

  return {mode: "require", ssl: {rejectUnauthorized: false}};
}
