import "server-only";

import {readFile} from "node:fs/promises";
import path from "node:path";

import {Client} from "pg";

import {resolvePostgresSsl} from "@/lib/storage/postgres-ssl";
import {createAdminClient} from "@/lib/supabase/admin";
import {resolveSupabaseDirectDbUrl} from "@/lib/supabase/config";
import {getErrorMessage, logError} from "@/lib/utils";

export interface RuntimeMigrationCheck {
  id: string;
  label: string;
  relation: string;
  fileName: string;
  status: "healthy" | "pending" | "blocked";
  detail: string;
  hint?: string;
}

export interface RuntimeMigrationInspection {
  autoMigrateEnabled: boolean;
  connectionSource: string | null;
  checks: RuntimeMigrationCheck[];
}

export interface RuntimeMigrationExecutionResult {
  appliedCount: number;
  appliedItems: string[];
  blockedReason: string | null;
  connectionSource: string | null;
}

interface RuntimeMigrationDefinition {
  id: string;
  label: string;
  relation: string;
  probeColumns: string;
  fileName: string;
}

interface MigrationConnectionState {
  connectionString: string | null;
  source: string | null;
}

interface RelationProbeResult {
  exists: boolean;
  blockedReason: string | null;
}

const RUNTIME_MIGRATIONS: RuntimeMigrationDefinition[] = [
  {
    id: "admin-users",
    label: "管理员账户表",
    relation: "admin_users",
    probeColumns: "id",
    fileName: "20260317121000_add_admin_users.sql",
  },
  {
    id: "site-settings",
    label: "站点设置表",
    relation: "site_settings",
    probeColumns: "singleton_key",
    fileName: "20260317125500_add_site_settings.sql",
  },
  {
    id: "site-settings-admin-entry-path",
    label: "后台入口路径字段",
    relation: "site_settings",
    probeColumns: "admin_entry_path",
    fileName: "20260614000000_add_admin_entry_path.sql",
  },
  {
    id: "site-settings-telegram-notification-name",
    label: "Telegram 通知显示名称字段",
    relation: "site_settings",
    probeColumns: "telegram_notification_name",
    fileName: "20260614001000_add_telegram_alert_states.sql",
  },
  {
    id: "telegram-alert-states",
    label: "Telegram 告警状态表",
    relation: "telegram_alert_states",
    probeColumns: "notification_key",
    fileName: "20260614001000_add_telegram_alert_states.sql",
  },
  {
    id: "telegram-push-config",
    label: "Telegram 推送配置表",
    relation: "telegram_push_config",
    probeColumns: "singleton_key",
    fileName: "20260614002000_add_telegram_push.sql",
  },
  {
    id: "telegram-push-records",
    label: "Telegram 推送记录表",
    relation: "telegram_push_records",
    probeColumns: "id, notification_key, event_type",
    fileName: "20260614002000_add_telegram_push.sql",
  },
];

const PG_RETRY_DELAYS_MS = [0, 1200, 2500];
const REST_REPROBE_DELAYS_MS = [0, 600, 1500, 3000];

let latestInspectionCache:
  | {
      idsKey: string;
      value: RuntimeMigrationInspection;
      expiresAt: number;
    }
  | null = null;

const inFlightEnsurePromises = new Map<string, Promise<RuntimeMigrationExecutionResult>>();

function getRuntimeMigrationErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }

  return getErrorMessage(error);
}

function getIdsKey(ids?: string[], input?: {allowDraft?: boolean}): string {
  const scope = input?.allowDraft ? "draft" : "active";
  const idsKey = ids && ids.length > 0 ? [...ids].sort().join(",") : "all";
  return `${scope}:${idsKey}`;
}

function getMigrationDefinitions(ids?: string[]): RuntimeMigrationDefinition[] {
  if (!ids || ids.length === 0) {
    return [...RUNTIME_MIGRATIONS];
  }

  const wanted = new Set(ids);
  return RUNTIME_MIGRATIONS.filter((item) => wanted.has(item.id));
}

function getUniqueMigrationFiles(checks: RuntimeMigrationCheck[]): string[] {
  return Array.from(new Set(checks.map((check) => check.fileName)));
}

function getMigrationConnectionState(input?: {allowDraft?: boolean}): MigrationConnectionState {
  const managedOrEnvSupabaseDb = resolveSupabaseDirectDbUrl({allowDraft: input?.allowDraft});
  if (managedOrEnvSupabaseDb) {
    return managedOrEnvSupabaseDb;
  }

  const candidates = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["POSTGRES_URL", process.env.POSTGRES_URL],
    ["POSTGRES_PRISMA_URL", process.env.POSTGRES_PRISMA_URL],
  ] as const;

  for (const [name, value] of candidates) {
    const trimmed = value?.trim();
    if (trimmed) {
      return {
        connectionString: trimmed,
        source: name,
      };
    }
  }

  return {
    connectionString: null,
    source: null,
  };
}

function isSchemaLikeError(message: string): boolean {
  return /does not exist|relation|column|schema|cache lookup failed|invalid schema/i.test(message);
}

function isRetryablePgError(message: string): boolean {
  return /Connection terminated unexpectedly|timeout|ECONNRESET|ENOTFOUND|server closed the connection unexpectedly|connect timeout/i.test(
    message
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runWithPgRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;

  for (const delay of PG_RETRY_DELAYS_MS) {
    if (delay > 0) {
      await sleep(delay);
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = getRuntimeMigrationErrorMessage(error);
      if (!isRetryablePgError(message)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(getRuntimeMigrationErrorMessage(lastError));
}

async function probeRelation(
  definition: RuntimeMigrationDefinition,
  input?: {allowDraft?: boolean}
): Promise<{
  exists: boolean;
  blockedReason: string | null;
}> {
  try {
    const supabase = createAdminClient({allowDraft: input?.allowDraft});
    const {error} = await supabase
      .from(definition.relation)
      .select(definition.probeColumns)
      .limit(1);

    if (!error) {
      return {exists: true, blockedReason: null};
    }

    const message = getRuntimeMigrationErrorMessage(error);
    if (isSchemaLikeError(message)) {
      return {exists: false, blockedReason: null};
    }

    return {
      exists: false,
      blockedReason: `${definition.relation} 探测失败：${message}`,
    };
  } catch (error) {
    return {
      exists: false,
      blockedReason: `${definition.relation} 探测异常：${getRuntimeMigrationErrorMessage(error)}`,
    };
  }
}

async function probeRelationsViaPg(
  definitions: RuntimeMigrationDefinition[],
  connectionString: string
): Promise<Map<string, RelationProbeResult>> {
  const results = new Map<string, RelationProbeResult>();

  try {
    await runWithPgRetry(async () => {
      const client = buildPgClient(connectionString);
      try {
        await client.connect();

        for (const definition of definitions) {
          const columnsResult = await client.query<{column_name: string}>(
            `
              select column_name
              from information_schema.columns
              where table_schema = 'public' and table_name = $1
            `,
            [definition.relation]
          );

          if (columnsResult.rows.length === 0) {
            results.set(definition.id, {
              exists: false,
              blockedReason: null,
            });
            continue;
          }

          const requiredColumns = definition.probeColumns
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
          const availableColumns = new Set(columnsResult.rows.map((item) => item.column_name));
          const missingColumns = requiredColumns.filter((item) => !availableColumns.has(item));

          results.set(definition.id, {
            exists: missingColumns.length === 0,
            blockedReason:
              missingColumns.length > 0
                ? `${definition.relation} 已存在，但缺少必要列：${missingColumns.join(", ")}`
                : null,
          });
        }
      } finally {
        try {
          await client.end();
        } catch {
        }
      }
    });

    return results;
  } catch (error) {
    const detail = `数据库直连探测失败：${getRuntimeMigrationErrorMessage(error)}`;
    for (const definition of definitions) {
      results.set(definition.id, {
        exists: false,
        blockedReason: detail,
      });
    }
    return results;
  }
}

async function waitForRestRelations(
  definitions: RuntimeMigrationDefinition[],
  input?: {allowDraft?: boolean}
): Promise<Map<string, RelationProbeResult>> {
  const latest = new Map<string, RelationProbeResult>();

  for (const delay of REST_REPROBE_DELAYS_MS) {
    if (delay > 0) {
      await sleep(delay);
    }

    let allHealthy = true;

    for (const definition of definitions) {
      const probe = await probeRelation(definition, {allowDraft: input?.allowDraft});
      latest.set(definition.id, probe);
      if (!probe.exists) {
        allHealthy = false;
      }
    }

    if (allHealthy) {
      return latest;
    }
  }

  return latest;
}

function buildBlockedDetail(definition: RuntimeMigrationDefinition): string {
  return `${definition.relation} 缺失，且当前未配置可用于自动迁移的数据库直连连接串。请补充托管 Supabase DB URL，或在 .env 中填写 SUPABASE_DB_URL（以及 DATABASE_URL / POSTGRES_URL / POSTGRES_PRISMA_URL 之一），然后重试。`;
}

export function invalidateRuntimeMigrationCache(): void {
  latestInspectionCache = null;
}

export async function inspectRuntimeMigrations(
  ids?: string[],
  input?: {allowDraft?: boolean}
): Promise<RuntimeMigrationInspection> {
  const idsKey = getIdsKey(ids, input);
  if (
    latestInspectionCache &&
    latestInspectionCache.idsKey === idsKey &&
    latestInspectionCache.expiresAt > Date.now()
  ) {
    return latestInspectionCache.value;
  }

  const definitions = getMigrationDefinitions(ids);
  const connectionState = getMigrationConnectionState({allowDraft: input?.allowDraft});
  const pgProbeResults = connectionState.connectionString
    ? await probeRelationsViaPg(definitions, connectionState.connectionString)
    : null;
  const checks = await Promise.all(
    definitions.map(async (definition) => {
      const pgProbe = pgProbeResults?.get(definition.id) ?? null;
      const probe =
        pgProbe && pgProbe.blockedReason
          ? (() => pgProbe)()
          : pgProbe ?? (await probeRelation(definition, {allowDraft: input?.allowDraft}));

      const finalProbe =
        pgProbe && pgProbe.blockedReason
          ? await (async () => {
              const restProbe = await probeRelation(definition, {allowDraft: input?.allowDraft});
              if (restProbe.exists || !restProbe.blockedReason) {
                return restProbe;
              }

              return {
                exists: false,
                blockedReason: `${pgProbe.blockedReason}；REST 回退探测也失败：${restProbe.blockedReason}`,
              } satisfies RelationProbeResult;
            })()
          : probe;

      if (finalProbe.exists) {
        return {
          id: definition.id,
          label: definition.label,
          relation: definition.relation,
          fileName: definition.fileName,
          status: "healthy",
          detail: `${definition.relation} 已存在，无需自动迁移。`,
        } satisfies RuntimeMigrationCheck;
      }

      if (finalProbe.blockedReason) {
        return {
          id: definition.id,
          label: definition.label,
          relation: definition.relation,
          fileName: definition.fileName,
          status: "blocked",
          detail: finalProbe.blockedReason,
          hint: connectionState.connectionString
            ? `已检测到 ${connectionState.source}，但当前数据库直连预检查未通过；请先检查连接串、数据库密码、网络连通性和 SSL 要求。`
            : "请配置托管 Supabase DB URL（推荐）或 DATABASE_URL / POSTGRES_URL，让项目具备直连 Postgres 执行 migration 的能力。",
        } satisfies RuntimeMigrationCheck;
      }

      return {
        id: definition.id,
        label: definition.label,
        relation: definition.relation,
        fileName: definition.fileName,
        status: connectionState.connectionString ? "pending" : "blocked",
        detail: connectionState.connectionString
          ? `${definition.relation} 缺失，已具备自动迁移前置连接，可直接补齐。`
          : buildBlockedDetail(definition),
        hint: connectionState.connectionString
          ? `将执行 supabase/migrations/${definition.fileName}`
          : "自动迁移需要直连数据库连接串；仅凭 Supabase REST URL 和 service-role key 无法执行 DDL。建议补充托管 Supabase DB URL 或 SUPABASE_DB_URL 后重试。",
      } satisfies RuntimeMigrationCheck;
    })
  );

  const result = {
    autoMigrateEnabled: Boolean(connectionState.connectionString),
    connectionSource: connectionState.source,
    checks,
  } satisfies RuntimeMigrationInspection;

  latestInspectionCache = {
    idsKey,
    value: result,
    expiresAt: Date.now() + 30_000,
  };

  return result;
}

function buildPgClient(connectionString: string): Client {
  const ssl = resolvePostgresSsl(connectionString);

  return new Client({
    connectionString,
    ssl: ssl.ssl,
  });
}

async function readMigrationSql(fileName: string): Promise<string> {
  const absolutePath = path.join(process.cwd(), "supabase", "migrations", fileName);
  return readFile(absolutePath, "utf8");
}

export async function ensureRuntimeMigrations(input?: {
  ids?: string[];
  force?: boolean;
  allowDraft?: boolean;
}): Promise<RuntimeMigrationExecutionResult> {
  const idsKey = getIdsKey(input?.ids, {allowDraft: input?.allowDraft});

  if (!input?.force) {
    const inFlightPromise = inFlightEnsurePromises.get(idsKey);
    if (inFlightPromise) {
      return inFlightPromise;
    }
  }

  const runner = async (): Promise<RuntimeMigrationExecutionResult> => {
    const inspection = await inspectRuntimeMigrations(input?.ids, {
      allowDraft: input?.allowDraft,
    });
    const pendingChecks = inspection.checks.filter((item) => item.status === "pending");
    const blockedCheck = inspection.checks.find((item) => item.status === "blocked");
    const pendingDefinitions = getMigrationDefinitions(pendingChecks.map((item) => item.id));

    if (blockedCheck) {
      return {
        appliedCount: 0,
        appliedItems: [],
        blockedReason: blockedCheck.detail,
        connectionSource: inspection.connectionSource,
      };
    }

    if (pendingChecks.length === 0) {
      return {
        appliedCount: 0,
        appliedItems: [],
        blockedReason: null,
        connectionSource: inspection.connectionSource,
      };
    }

    const connectionState = getMigrationConnectionState({allowDraft: input?.allowDraft});
    if (!connectionState.connectionString) {
      return {
        appliedCount: 0,
        appliedItems: [],
        blockedReason:
          "未配置托管 Supabase DB URL、SUPABASE_DB_URL、DATABASE_URL 或 POSTGRES_URL，项目无法自动执行数据库结构迁移。",
        connectionSource: null,
      };
    }

    const connectionString = connectionState.connectionString;

    const appliedItems: string[] = [];

    await runWithPgRetry(async () => {
      const client = buildPgClient(connectionString);

      try {
        await client.connect();

        for (const fileName of getUniqueMigrationFiles(pendingChecks)) {
          const sql = await readMigrationSql(fileName);

          try {
            await client.query("BEGIN");
            await client.query(sql);
            await client.query("COMMIT");
            appliedItems.push(`已执行 ${fileName}`);
          } catch (error) {
            await client.query("ROLLBACK");
            throw new Error(`执行 ${fileName} 失败：${getRuntimeMigrationErrorMessage(error)}`);
          }
        }

        await client.query("NOTIFY pgrst, 'reload schema'");
      } finally {
        await client.end();
      }
    });

    invalidateRuntimeMigrationCache();

    const restProbeResults = await waitForRestRelations(pendingDefinitions, {
      allowDraft: input?.allowDraft,
    });
    const remainingPending = pendingDefinitions.filter((definition) => {
      const probe = restProbeResults.get(definition.id);
      return !probe?.exists;
    });
    if (remainingPending.length > 0) {
      const details = remainingPending
        .map((definition) => {
          const probe = restProbeResults.get(definition.id);
          return `${definition.relation}：${probe?.blockedReason ?? "PostgREST schema cache 尚未刷新"}`;
        })
        .join("；");
      throw new Error(
        `自动迁移执行后 REST 侧仍有未就绪对象：${details}`
      );
    }

    await inspectRuntimeMigrations(input?.ids, {allowDraft: input?.allowDraft});

    return {
      appliedCount: appliedItems.length,
      appliedItems,
      blockedReason: null,
      connectionSource: connectionState.source,
    };
  };

  const promise = runner().catch((error) => {
    logError("ensure runtime migrations failed", error);
    throw error;
  });

  inFlightEnsurePromises.set(idsKey, promise);

  try {
    return await promise;
  } finally {
    inFlightEnsurePromises.delete(idsKey);
  }
}
