import "server-only";

import type {PostgrestError} from "@supabase/supabase-js";

import {createAdminClient} from "@/lib/supabase/admin";
import {ensureRuntimeMigrations} from "@/lib/supabase/runtime-migrations";
import type {AvailabilityStats} from "@/lib/types/database";
import {getErrorMessage} from "@/lib/utils";

import type {
  CheckConfigMutationInput,
  ControlPlaneStorage,
  NotificationMutationInput,
  RequestTemplateMutationInput,
  RuntimeHistoryQueryOptions,
  SiteSettingsMutationInput,
  StorageCapabilities,
  TelegramAlertStateMutationInput,
  TelegramPushConfigMutationInput,
  TelegramPushRecordMutationInput,
  TelegramPushRecordStatusUpdateInput,
} from "./types";
import {
  createStorageId,
  getDefaultRequestTemplateRows,
  mapAdminUserRecord,
  mapAvailabilityStatsRow,
  mapCheckConfigRow,
  mapHistorySnapshotRow,
  mapNotificationRow,
  mapRequestTemplateRow,
  mapSiteSettingsRow,
  mapTelegramAlertStateRow,
  mapTelegramPushConfigRow,
  mapTelegramPushRecordRow,
} from "./shared";

const capabilities: StorageCapabilities = {
  provider: "supabase",
  adminAuth: true,
  siteSettings: true,
  controlPlaneCrud: true,
  requestTemplates: true,
  notifications: true,
  historySnapshots: true,
  availabilityStats: true,
  pollerLease: true,
  runtimeMigrations: true,
  supabaseDiagnostics: true,
  autoProvisionControlPlane: false,
};

const DEFAULT_HISTORY_LIMIT = 60;
const RPC_RECENT_HISTORY = "get_recent_check_history";
const RPC_PRUNE_HISTORY = "prune_check_history";
const LEGACY_TEMPLATES_WARNING =
  "请求模板表尚未初始化，当前回退到内置默认模板。请补齐最新 Supabase schema / migration。";
const TELEGRAM_PUSH_RECORD_COLUMNS =
  "id, project_name, title, content, chat_id, notification_key, event_type, status, push_count, failure_reason, last_pushed_at, created_at, updated_at";
const LEGACY_TELEGRAM_PUSH_RECORD_COLUMNS =
  "id, project_name, title, content, chat_id, status, push_count, failure_reason, last_pushed_at, created_at, updated_at";
const TELEGRAM_ALERT_STATE_COLUMNS =
  "notification_key, config_id, model, state, failure_count, success_count, last_status, last_message, failure_started_at, last_failure_at, last_success_at, last_notified_at, created_at, updated_at";
const SUPABASE_PAGE_SIZE = 1000;

interface CheckConfigSelectProfile {
  columns: string;
  supportsUpdatedAtOrder: boolean;
  supportsCreatedAtOrder: boolean;
}

const CHECK_CONFIG_SELECT_PROFILES: CheckConfigSelectProfile[] = [
  {
    columns:
      "id, name, type, model, endpoint, api_key, enabled, is_maintenance, template_id, request_header, metadata, group_name, created_at, updated_at",
    supportsUpdatedAtOrder: true,
    supportsCreatedAtOrder: true,
  },
  {
    columns:
      "id, name, type, model, endpoint, api_key, enabled, is_maintenance, request_header, metadata, created_at, updated_at",
    supportsUpdatedAtOrder: true,
    supportsCreatedAtOrder: true,
  },
  {
    columns: "id, name, type, model, endpoint, api_key, enabled, is_maintenance, created_at, updated_at",
    supportsUpdatedAtOrder: true,
    supportsCreatedAtOrder: true,
  },
  {
    columns: "id, name, type, model, endpoint, api_key, enabled, is_maintenance, created_at",
    supportsUpdatedAtOrder: false,
    supportsCreatedAtOrder: true,
  },
  {
    columns: "id, name, type, model, endpoint, api_key, enabled, is_maintenance",
    supportsUpdatedAtOrder: false,
    supportsCreatedAtOrder: false,
  },
];

function wrapStorageError(action: string, error: unknown): never {
  throw new Error(`${action}失败：${getErrorMessage(error)}`);
}

function isSchemaLikeError(error: PostgrestError | null): boolean {
  if (!error) {
    return false;
  }

  return /does not exist|relation|column|schema|invalid schema|cache lookup failed|schema cache|Could not find/i.test(
    getErrorMessage(error)
  );
}

function buildAvailabilityStatsFromHistoryRows(
  rows: Array<Record<string, unknown>>
): AvailabilityStats[] {
  const periods = [
    {label: "7d" as const, cutoffMs: Date.now() - 7 * 24 * 60 * 60 * 1000},
    {label: "15d" as const, cutoffMs: Date.now() - 15 * 24 * 60 * 60 * 1000},
    {label: "30d" as const, cutoffMs: Date.now() - 30 * 24 * 60 * 60 * 1000},
  ];

  const aggregates = new Map<
    string,
    Record<AvailabilityStats["period"], {total_checks: number; operational_count: number}>
  >();

  for (const row of rows) {
    const configId = typeof row.config_id === "string" ? row.config_id : "";
    if (!configId) {
      continue;
    }

    const checkedAtSource = row.checked_at;
    const checkedAtValue =
      checkedAtSource instanceof Date
        ? checkedAtSource.getTime()
        : Date.parse(String(checkedAtSource ?? ""));

    if (!Number.isFinite(checkedAtValue)) {
      continue;
    }

    const status = typeof row.status === "string" ? row.status : "";
    const entry =
      aggregates.get(configId) ?? {
        "7d": {total_checks: 0, operational_count: 0},
        "15d": {total_checks: 0, operational_count: 0},
        "30d": {total_checks: 0, operational_count: 0},
      };

    for (const period of periods) {
      if (checkedAtValue > period.cutoffMs) {
        entry[period.label].total_checks += 1;
        if (status === "operational") {
          entry[period.label].operational_count += 1;
        }
      }
    }

    aggregates.set(configId, entry);
  }

  return [...aggregates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([configId, stats]) =>
      periods.flatMap((period) => {
        const aggregate = stats[period.label];
        if (aggregate.total_checks === 0) {
          return [];
        }

        return [
          {
            config_id: configId,
            period: period.label,
            total_checks: aggregate.total_checks,
            operational_count: aggregate.operational_count,
            availability_pct:
              aggregate.total_checks === 0
                ? null
                : Math.round(
                    (10000 * aggregate.operational_count) / aggregate.total_checks
                  ) / 100,
          },
        ];
      })
    );
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

export function createSupabaseControlPlaneStorage(input?: {allowDraft?: boolean}): ControlPlaneStorage {
  const allowDraft = input?.allowDraft;
  let readyPromise: Promise<void> | null = null;
  let telegramStorageMigrationPromise: Promise<void> | null = null;
  let requestTemplatesRelationAvailable: boolean | null = null;
  let availabilityStatsViewAvailable: boolean | null = null;
  let checkConfigSelectProfileIndex = 0;

  async function ensureReady(): Promise<void> {
    if (readyPromise) {
      return readyPromise;
    }

    readyPromise = (async () => {
      const client = createAdminClient({allowDraft});
      const {error} = await client
        .from("check_request_templates")
        .upsert(
          getDefaultRequestTemplateRows().map((template) => ({
            id: template.id,
            name: template.name,
            type: template.type,
            request_header: template.request_header,
            metadata: template.metadata,
          })),
          {onConflict: "id", ignoreDuplicates: true}
        );

      if (error) {
        if (isSchemaLikeError(error)) {
          requestTemplatesRelationAvailable = false;
          console.warn(`[check-cx] ${LEGACY_TEMPLATES_WARNING}`);
          return;
        }

        wrapStorageError("初始化默认请求模板", error);
      }

      requestTemplatesRelationAvailable = true;
    })().catch((error) => {
      readyPromise = null;
      throw error;
    });

    return readyPromise;
  }

  function normalizeIds(ids?: Iterable<string> | null): string[] | null {
    if (!ids) {
      return null;
    }

    const normalized = Array.from(ids).filter(Boolean);
    return normalized.length > 0 ? normalized : [];
  }

  function isMissingFunctionError(error: PostgrestError | null): boolean {
    if (!error) {
      return false;
    }

    const message = getErrorMessage(error);
    return message.includes(RPC_RECENT_HISTORY) || message.includes(RPC_PRUNE_HISTORY);
  }

  function isMissingSiteSettingsColumnError(error: PostgrestError | null): boolean {
    if (!error) {
      return false;
    }

    const message = getErrorMessage(error);
    return (
      message.includes("site_icon_url") ||
      message.includes("admin_entry_path") ||
      message.includes("telegram_notification_name")
    );
  }

  async function ensureTelegramStorageReady(): Promise<void> {
    if (!telegramStorageMigrationPromise) {
      telegramStorageMigrationPromise = ensureRuntimeMigrations({
        ids: ["telegram-alert-states", "telegram-push-config", "telegram-push-records"],
        allowDraft,
      })
        .then((result) => {
          if (result.blockedReason) {
            throw new Error(result.blockedReason);
          }
        })
        .catch((error) => {
          telegramStorageMigrationPromise = null;
          throw error;
        });
    }

    return telegramStorageMigrationPromise;
  }

  function isMissingTelegramPushRecordColumnError(error: PostgrestError | null): boolean {
    if (!error) {
      return false;
    }

    const message = getErrorMessage(error);
    return message.includes("notification_key") || message.includes("event_type");
  }

  async function selectCheckConfigList(input?: {enabledOnly?: boolean}) {
    const client = createAdminClient({allowDraft});
    let lastSchemaError: PostgrestError | null = null;

    for (
      let profileIndex = checkConfigSelectProfileIndex;
      profileIndex < CHECK_CONFIG_SELECT_PROFILES.length;
      profileIndex += 1
    ) {
      const profile = CHECK_CONFIG_SELECT_PROFILES[profileIndex];
      let query = client.from("check_configs").select(profile.columns);

      if (input?.enabledOnly) {
        query = query.eq("enabled", true);
      }

      if (profile.supportsUpdatedAtOrder) {
        query = query.order("updated_at", {ascending: false});
      }
      if (profile.supportsCreatedAtOrder) {
        query = query.order("created_at", {ascending: false});
      }

      const {data, error} = await query;
      if (!error) {
        checkConfigSelectProfileIndex = profileIndex;
        const rows = ((data as unknown as Array<Record<string, unknown>> | null) ?? []).map((row) =>
          mapCheckConfigRow(row)
        );
        return rows;
      }

      if (!isSchemaLikeError(error)) {
        wrapStorageError("读取检测配置", error);
      }

      lastSchemaError = error;
    }

    wrapStorageError("读取检测配置", lastSchemaError);
  }

  async function selectCheckConfigById(id: string) {
    const client = createAdminClient({allowDraft});
    let lastSchemaError: PostgrestError | null = null;

    for (
      let profileIndex = checkConfigSelectProfileIndex;
      profileIndex < CHECK_CONFIG_SELECT_PROFILES.length;
      profileIndex += 1
    ) {
      const profile = CHECK_CONFIG_SELECT_PROFILES[profileIndex];
      const {data, error} = await client
        .from("check_configs")
        .select(profile.columns)
        .eq("id", id)
        .maybeSingle();

      if (!error) {
        checkConfigSelectProfileIndex = profileIndex;
        return data ? mapCheckConfigRow(data as unknown as Record<string, unknown>) : null;
      }

      if (!isSchemaLikeError(error)) {
        wrapStorageError("读取检测配置", error);
      }

      lastSchemaError = error;
    }

    wrapStorageError("读取检测配置", lastSchemaError);
  }

  async function fallbackListAvailabilityStats(normalizedIds: string[] | null) {
    const client = createAdminClient({allowDraft});
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const historyRows: Array<Record<string, unknown>> = [];
    const pageSize = 1000;

    for (let offset = 0; ; offset += pageSize) {
      let query = client
        .from("check_history")
        .select("config_id, status, checked_at")
        .gte("checked_at", cutoff30d)
        .order("checked_at", {ascending: false})
        .range(offset, offset + pageSize - 1);

      if (normalizedIds) {
        query = query.in("config_id", normalizedIds);
      }

      const {data, error} = await query;
      if (error) {
        wrapStorageError("读取可用性统计", error);
      }

      const page = (data as Array<Record<string, unknown>> | null) ?? [];
      historyRows.push(...page);
      if (page.length < pageSize) {
        break;
      }
    }

    return buildAvailabilityStatsFromHistoryRows(historyRows);
  }

  async function fallbackFetchHistoryRows(allowedIds: string[] | null, limitPerConfig?: number | null) {
    const client = createAdminClient({allowDraft});
    let query = client
      .from("check_history")
      .select(
        `
          id,
          config_id,
          status,
          latency_ms,
          ping_latency_ms,
          checked_at,
          message,
          check_configs (
            id,
            name,
            type,
            model,
            endpoint,
            group_name
          )
        `
      )
      .order("checked_at", {ascending: false});

    if (allowedIds) {
      query = query.in("config_id", allowedIds);
    }

    if (typeof limitPerConfig === "number") {
      query = query.limit(Math.max(limitPerConfig * Math.max(allowedIds?.length ?? 1, 1), limitPerConfig));
    }

    const {data, error} = await query;
    if (error) {
      wrapStorageError("读取历史快照", error);
    }

    return ((data as Array<Record<string, unknown>> | null) ?? []).flatMap((record) => {
      const configRows = record.check_configs;
      if (!configRows || !Array.isArray(configRows) || configRows.length === 0) {
        return [];
      }

      const config = configRows[0] as Record<string, unknown>;
      return [
        mapHistorySnapshotRow({
          id: record.id,
          config_id: record.config_id,
          status: record.status,
          latency_ms: record.latency_ms,
          ping_latency_ms: record.ping_latency_ms,
          checked_at: record.checked_at,
          message: record.message,
          name: config.name,
          type: config.type,
          model: config.model,
          endpoint: config.endpoint,
          group_name: config.group_name,
        }),
      ];
    });
  }

  async function fetchHistoryRows(options?: RuntimeHistoryQueryOptions) {
    await ensureReady();

    const normalizedIds = normalizeIds(options?.allowedIds);
    if (Array.isArray(normalizedIds) && normalizedIds.length === 0) {
      return [];
    }

    const client = createAdminClient({allowDraft});
    const limitPerConfig = options?.limitPerConfig ?? DEFAULT_HISTORY_LIMIT;

    if (limitPerConfig === null) {
      return fallbackFetchHistoryRows(normalizedIds, null);
    }

    const {data, error} = await client.rpc(RPC_RECENT_HISTORY, {
      limit_per_config: limitPerConfig,
      target_config_ids: normalizedIds,
    });

    if (error) {
      if (isMissingFunctionError(error)) {
        return fallbackFetchHistoryRows(normalizedIds, limitPerConfig);
      }

      wrapStorageError("读取历史快照", error);
    }

    return ((data as Array<Record<string, unknown>> | null) ?? []).map(mapHistorySnapshotRow);
  }

  async function appendHistory(results: Array<{
    id: string;
    status: string;
    latencyMs: number | null;
    pingLatencyMs: number | null;
    checkedAt: string;
    message: string;
  }>) {
    await ensureReady();
    if (results.length === 0) {
      return;
    }

    const client = createAdminClient({allowDraft});
    const {error} = await client.from("check_history").insert(
      results.map((result) => ({
        config_id: result.id,
        status: result.status,
        latency_ms: result.latencyMs,
        ping_latency_ms: result.pingLatencyMs,
        checked_at: result.checkedAt,
        message: result.message,
      }))
    );

    if (error) {
      wrapStorageError("写入历史记录", error);
    }
  }

  async function pruneHistory(retentionDays: number) {
    await ensureReady();
    const client = createAdminClient({allowDraft});
    const {error} = await client.rpc(RPC_PRUNE_HISTORY, {
      retention_days: retentionDays,
    });

    if (!error) {
      return;
    }

    if (!isMissingFunctionError(error)) {
      wrapStorageError("清理历史记录", error);
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const {error: deleteError} = await client.from("check_history").delete().lt("checked_at", cutoff);
    if (deleteError) {
      wrapStorageError("清理历史记录", deleteError);
    }
  }

  async function replaceHistoryForConfigs(input: {
    configIds: Iterable<string>;
    rows: Awaited<ReturnType<typeof fetchHistoryRows>>;
  }) {
    await ensureReady();

    const normalizedIds = normalizeIds(input.configIds);
    if (!normalizedIds || normalizedIds.length === 0) {
      return;
    }

    const client = createAdminClient({allowDraft});
    for (const batch of chunkRows(normalizedIds, 200)) {
      const {error} = await client.from("check_history").delete().in("config_id", batch);
      if (error) {
        wrapStorageError("替换历史记录", error);
      }
    }

    for (const batch of chunkRows(input.rows, 500)) {
      if (batch.length === 0) {
        continue;
      }

      const {error} = await client.from("check_history").insert(
        batch.map((row) => ({
          config_id: row.config_id,
          status: row.status,
          latency_ms: row.latency_ms,
          ping_latency_ms: row.ping_latency_ms,
          checked_at: row.checked_at,
          message: row.message,
          created_at: row.checked_at,
        }))
      );

      if (error) {
        wrapStorageError("替换历史记录", error);
      }
    }
  }

  async function listAvailabilityStats(configIds?: Iterable<string> | null) {
    await ensureReady();

    const normalizedIds = normalizeIds(configIds);
    if (Array.isArray(normalizedIds) && normalizedIds.length === 0) {
      return [];
    }

    if (availabilityStatsViewAvailable === false) {
      return fallbackListAvailabilityStats(normalizedIds);
    }

    const client = createAdminClient({allowDraft});
    let query = client
      .from("availability_stats")
      .select("config_id, period, total_checks, operational_count, availability_pct")
      .order("config_id", {ascending: true})
      .order("period", {ascending: true});

    if (normalizedIds) {
      query = query.in("config_id", normalizedIds);
    }

    const {data, error} = await query;
    if (error) {
      if (isSchemaLikeError(error)) {
        availabilityStatsViewAvailable = false;
        return fallbackListAvailabilityStats(normalizedIds);
      }

      wrapStorageError("读取可用性统计", error);
    }

    availabilityStatsViewAvailable = true;

    return ((data as Array<Record<string, unknown>> | null) ?? []).map(mapAvailabilityStatsRow);
  }

  return {
    provider: "supabase",
    capabilities,
    ensureReady,
    runtime: {
      history: {
        fetchRows: fetchHistoryRows,
        append: appendHistory,
        prune: pruneHistory,
        replaceForConfigs: replaceHistoryForConfigs,
      },
      availability: {
        listStats: listAvailabilityStats,
      },
    },
    adminUsers: {
      async hasAny() {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client.from("admin_users").select("id").limit(1);

        if (error) {
          wrapStorageError("读取管理员账户", error);
        }

        return Boolean(data && data.length > 0);
      },
      async list() {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("admin_users")
          .select("id, username, password_hash, last_login_at, created_at, updated_at")
          .order("username", {ascending: true});

        if (error) {
          wrapStorageError("读取管理员账户列表", error);
        }

        return ((data as Array<Record<string, unknown>> | null) ?? []).map(mapAdminUserRecord);
      },
      async findByUsername(username) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("admin_users")
          .select("id, username, password_hash, last_login_at, created_at, updated_at")
          .eq("username", username)
          .maybeSingle();

        if (error) {
          wrapStorageError("读取管理员账户", error);
        }

        return data ? mapAdminUserRecord(data as Record<string, unknown>) : null;
      },
      async create(input) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("admin_users")
          .insert({
            username: input.username,
            password_hash: input.passwordHash,
            last_login_at: input.lastLoginAt ?? null,
          })
          .select("id, username, password_hash, last_login_at, created_at, updated_at")
          .single();

        if (error) {
          wrapStorageError("创建管理员账户", error);
        }

        return mapAdminUserRecord(data as Record<string, unknown>);
      },
      async replaceAll(records) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data: existingRows, error: existingError} = await client
          .from("admin_users")
          .select("id");

        if (existingError) {
          wrapStorageError("读取管理员账户列表", existingError);
        }

        const existingIds = ((existingRows as Array<{id: string}> | null) ?? []).map((row) => row.id);
        if (existingIds.length > 0) {
          const {error: deleteError} = await client.from("admin_users").delete().in("id", existingIds);
          if (deleteError) {
            wrapStorageError("清理管理员账户", deleteError);
          }
        }

        if (records.length === 0) {
          return;
        }

        const {error: insertError} = await client.from("admin_users").insert(
          records.map((record) => ({
            id: record.id,
            username: record.username,
            password_hash: record.password_hash,
            last_login_at: record.last_login_at ?? null,
            created_at: record.created_at ?? new Date().toISOString(),
            updated_at: record.updated_at ?? new Date().toISOString(),
          }))
        );

        if (insertError) {
          wrapStorageError("导入管理员账户", insertError);
        }
      },
      async updateLastLoginAt(id, lastLoginAt) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {error} = await client
          .from("admin_users")
          .update({last_login_at: lastLoginAt})
          .eq("id", id);

        if (error) {
          wrapStorageError("更新管理员登录时间", error);
        }
      },
    },
    siteSettings: {
      async getSingleton(singletonKey) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("site_settings")
          .select(
            "singleton_key, site_name, site_description, site_icon_url, hero_badge, hero_title_primary, hero_title_secondary, hero_description, footer_brand, admin_console_title, admin_console_description, admin_entry_path, telegram_notification_name, created_at, updated_at"
          )
          .eq("singleton_key", singletonKey)
          .maybeSingle();

        if (error) {
          if (isMissingSiteSettingsColumnError(error)) {
            const fallback = await client
              .from("site_settings")
              .select(
                "singleton_key, site_name, site_description, hero_badge, hero_title_primary, hero_title_secondary, hero_description, footer_brand, admin_console_title, admin_console_description, created_at, updated_at"
              )
              .eq("singleton_key", singletonKey)
              .maybeSingle();

            if (fallback.error) {
              wrapStorageError("读取站点设置", fallback.error);
            }

            return fallback.data ? mapSiteSettingsRow(fallback.data as Record<string, unknown>) : null;
          }

          wrapStorageError("读取站点设置", error);
        }

        return data ? mapSiteSettingsRow(data as Record<string, unknown>) : null;
      },
      async upsert(input: SiteSettingsMutationInput) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {error} = await client
          .from("site_settings")
          .upsert(input, {onConflict: "singleton_key"});

        if (error) {
          wrapStorageError("保存站点设置", error);
        }
      },
    },
    checkConfigs: {
      async list(input) {
        await ensureReady();
        return selectCheckConfigList({enabledOnly: input?.enabledOnly});
      },
      async getById(id) {
        await ensureReady();
        return selectCheckConfigById(id);
      },
      async upsert(input: CheckConfigMutationInput) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const payloadId = input.id ?? createStorageId();
        const payload = {
          id: payloadId,
          name: input.name,
          type: input.type,
          model: input.model,
          endpoint: input.endpoint,
          api_key: input.api_key,
          enabled: input.enabled,
          is_maintenance: input.is_maintenance,
          template_id: input.template_id ?? null,
          request_header: input.request_header ?? null,
          metadata: input.metadata ?? null,
          group_name: input.group_name ?? null,
        };

        let error: unknown = null;

        if (input.id) {
          const updateResult = await client
            .from("check_configs")
            .update({
              name: input.name,
              type: input.type,
              model: input.model,
              endpoint: input.endpoint,
              api_key: input.api_key,
              enabled: input.enabled,
              is_maintenance: input.is_maintenance,
              template_id: input.template_id ?? null,
              request_header: input.request_header ?? null,
              metadata: input.metadata ?? null,
              group_name: input.group_name ?? null,
            })
            .eq("id", input.id)
            .select("id");

          if (updateResult.error) {
            error = updateResult.error;
          } else if ((updateResult.data ?? []).length === 0) {
            const insertResult = await client.from("check_configs").insert(payload);
            error = insertResult.error;
          }
        } else {
          const insertResult = await client.from("check_configs").insert(payload);
          error = insertResult.error;
        }

        if (error) {
          wrapStorageError("保存检测配置", error);
        }
      },
      async delete(id) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {error} = await client.from("check_configs").delete().eq("id", id);

        if (error) {
          wrapStorageError("删除检测配置", error);
        }
      },
    },
    requestTemplates: {
      async list() {
        await ensureReady();

        if (requestTemplatesRelationAvailable === false) {
          return getDefaultRequestTemplateRows();
        }

        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("check_request_templates")
          .select("id, name, type, request_header, metadata, created_at, updated_at")
          .order("updated_at", {ascending: false})
          .order("created_at", {ascending: false});

        if (error) {
          if (isSchemaLikeError(error)) {
            requestTemplatesRelationAvailable = false;
            console.warn(`[check-cx] ${LEGACY_TEMPLATES_WARNING}`);
            return getDefaultRequestTemplateRows();
          }

          wrapStorageError("读取请求模板", error);
        }

        requestTemplatesRelationAvailable = true;

        return ((data as Array<Record<string, unknown>> | null) ?? []).map(mapRequestTemplateRow);
      },
      async upsert(input: RequestTemplateMutationInput) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const payloadId = input.id ?? createStorageId();
        const payload = {
          id: payloadId,
          name: input.name,
          type: input.type,
          request_header: input.request_header ?? null,
          metadata: input.metadata ?? null,
        };

        let error: unknown = null;

        if (input.id) {
          const updateResult = await client
            .from("check_request_templates")
            .update({
              name: input.name,
              type: input.type,
              request_header: input.request_header ?? null,
              metadata: input.metadata ?? null,
            })
            .eq("id", input.id)
            .select("id");

          if (updateResult.error) {
            error = updateResult.error;
          } else if ((updateResult.data ?? []).length === 0) {
            const insertResult = await client.from("check_request_templates").insert(payload);
            error = insertResult.error;
          }
        } else {
          const insertResult = await client.from("check_request_templates").insert(payload);
          error = insertResult.error;
        }

        if (error) {
          wrapStorageError("保存请求模板", error);
        }
      },
      async delete(id) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {error} = await client.from("check_request_templates").delete().eq("id", id);

        if (error) {
          wrapStorageError("删除请求模板", error);
        }
      },
    },
    notifications: {
      async list() {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("system_notifications")
          .select("id, message, is_active, level, created_at")
          .order("created_at", {ascending: false});

        if (error) {
          wrapStorageError("读取系统通知", error);
        }

        return ((data as Array<Record<string, unknown>> | null) ?? []).map(mapNotificationRow);
      },
      async listActive() {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("system_notifications")
          .select("id, message, is_active, level, created_at")
          .eq("is_active", true)
          .order("created_at", {ascending: false});

        if (error) {
          wrapStorageError("读取系统通知", error);
        }

        return ((data as Array<Record<string, unknown>> | null) ?? []).map(mapNotificationRow);
      },
      async upsert(input: NotificationMutationInput) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const payloadId = input.id ?? createStorageId();
        const payload = {
          id: payloadId,
          message: input.message,
          level: input.level,
          is_active: input.is_active,
        };

        let error: unknown = null;

        if (input.id) {
          const updateResult = await client
            .from("system_notifications")
            .update({
              message: input.message,
              level: input.level,
              is_active: input.is_active,
            })
            .eq("id", input.id)
            .select("id");

          if (updateResult.error) {
            error = updateResult.error;
          } else if ((updateResult.data ?? []).length === 0) {
            const insertResult = await client.from("system_notifications").insert(payload);
            error = insertResult.error;
          }
        } else {
          const insertResult = await client.from("system_notifications").insert(payload);
          error = insertResult.error;
        }

        if (error) {
          wrapStorageError("保存系统通知", error);
        }
      },
      async delete(id) {
        await ensureReady();
        const client = createAdminClient({allowDraft});
        const {error} = await client.from("system_notifications").delete().eq("id", id);

        if (error) {
          wrapStorageError("删除系统通知", error);
        }
      },
    },
    telegramAlertStates: {
      async list(input) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const limit = input?.limit === null ? null : Math.min(Math.max(input?.limit ?? 100, 1), 500);
        const firstTo = limit === null ? SUPABASE_PAGE_SIZE - 1 : limit - 1;

        const {data, error} = await client
          .from("telegram_alert_states")
          .select(TELEGRAM_ALERT_STATE_COLUMNS)
          .order("updated_at", {ascending: false})
          .range(0, firstTo);

        if (error) {
          wrapStorageError("读取 Telegram 告警状态列表", error);
        }

        const rows = [
          ...(((data as unknown as Array<Record<string, unknown>> | null) ?? [])),
        ];

        if (limit === null) {
          let currentPageRows = rows;
          let offset = currentPageRows.length;
          while (currentPageRows.length === SUPABASE_PAGE_SIZE) {
            const page = await client
              .from("telegram_alert_states")
              .select(TELEGRAM_ALERT_STATE_COLUMNS)
              .order("updated_at", {ascending: false})
              .range(offset, offset + SUPABASE_PAGE_SIZE - 1);

            if (page.error) {
              wrapStorageError("读取 Telegram 告警状态列表", page.error);
            }

            currentPageRows =
              ((page.data as unknown as Array<Record<string, unknown>> | null) ?? []);
            rows.push(...currentPageRows);
            offset += currentPageRows.length;
          }
        }

        return rows.map(mapTelegramAlertStateRow);
      },
      async get(notificationKey) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("telegram_alert_states")
          .select(TELEGRAM_ALERT_STATE_COLUMNS)
          .eq("notification_key", notificationKey)
          .maybeSingle();

        if (error) {
          wrapStorageError("读取 Telegram 告警状态", error);
        }

        return data ? mapTelegramAlertStateRow(data as Record<string, unknown>) : null;
      },
      async upsert(input: TelegramAlertStateMutationInput) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const payload = {
          notification_key: input.notification_key,
          config_id: input.config_id,
          model: input.model,
          state: input.state,
          failure_count: input.failure_count,
          success_count: input.success_count,
          last_status: input.last_status ?? null,
          last_message: input.last_message ?? null,
          failure_started_at: input.failure_started_at ?? null,
          last_failure_at: input.last_failure_at ?? null,
          last_success_at: input.last_success_at ?? null,
          last_notified_at: input.last_notified_at ?? null,
        };

        const {data, error} = await client
          .from("telegram_alert_states")
          .upsert(payload, {onConflict: "notification_key"})
          .select(TELEGRAM_ALERT_STATE_COLUMNS)
          .single();

        if (error) {
          wrapStorageError("保存 Telegram 告警状态", error);
        }

        return mapTelegramAlertStateRow(data as Record<string, unknown>);
      },
      async delete(notificationKey) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const {error} = await client
          .from("telegram_alert_states")
          .delete()
          .eq("notification_key", notificationKey);

        if (error) {
          wrapStorageError("删除 Telegram 告警状态", error);
        }
      },
    },
    telegramPushConfig: {
      async getSingleton(singletonKey) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("telegram_push_config")
          .select(
            "singleton_key, project_name, bot_token, chat_id, auto_push_enabled, created_at, updated_at"
          )
          .eq("singleton_key", singletonKey)
          .maybeSingle();

        if (error) {
          wrapStorageError("读取 Telegram 推送配置", error);
        }

        return data ? mapTelegramPushConfigRow(data as Record<string, unknown>) : null;
      },
      async upsert(input: TelegramPushConfigMutationInput) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const {data, error} = await client
          .from("telegram_push_config")
          .upsert(input, {onConflict: "singleton_key"})
          .select(
            "singleton_key, project_name, bot_token, chat_id, auto_push_enabled, created_at, updated_at"
          )
          .single();

        if (error) {
          wrapStorageError("保存 Telegram 推送配置", error);
        }

        return mapTelegramPushConfigRow(data as Record<string, unknown>);
      },
    },
    telegramPushRecords: {
      async list(input) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const limit = input?.limit === null ? null : Math.min(Math.max(input?.limit ?? 100, 1), 500);
        const fetchPage = async (from: number, to: number, columns: string) =>
          client
            .from("telegram_push_records")
            .select(columns)
            .order("created_at", {ascending: false})
            .range(from, to);

        const firstTo = limit === null ? SUPABASE_PAGE_SIZE - 1 : limit - 1;
        let {data, error} = await fetchPage(0, firstTo, TELEGRAM_PUSH_RECORD_COLUMNS);
        let columns = TELEGRAM_PUSH_RECORD_COLUMNS;
        let currentPageRows = ((data as unknown as Array<Record<string, unknown>> | null) ?? []);

        if (isMissingTelegramPushRecordColumnError(error)) {
          const legacyResult = await fetchPage(0, firstTo, LEGACY_TELEGRAM_PUSH_RECORD_COLUMNS);
          data = legacyResult.data;
          error = legacyResult.error;
          columns = LEGACY_TELEGRAM_PUSH_RECORD_COLUMNS;
          currentPageRows = ((data as unknown as Array<Record<string, unknown>> | null) ?? []);
        }

        if (error) {
          wrapStorageError("读取 Telegram 推送记录", error);
        }

        const rows = [...currentPageRows];

        if (limit === null) {
          let offset = rows.length;
          while (currentPageRows.length === SUPABASE_PAGE_SIZE) {
            const page = await fetchPage(offset, offset + SUPABASE_PAGE_SIZE - 1, columns);
            if (page.error) {
              wrapStorageError("读取 Telegram 推送记录", page.error);
            }
            currentPageRows = ((page.data as unknown as Array<Record<string, unknown>> | null) ?? []);
            rows.push(...currentPageRows);
            offset += currentPageRows.length;
          }
        }

        return rows.map(mapTelegramPushRecordRow);
      },
      async getById(id) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const currentResult = await client
          .from("telegram_push_records")
          .select(TELEGRAM_PUSH_RECORD_COLUMNS)
          .eq("id", id)
          .maybeSingle();
        let data: Record<string, unknown> | null =
          (currentResult.data as unknown as Record<string, unknown> | null) ?? null;
        let error = currentResult.error;

        if (isMissingTelegramPushRecordColumnError(error)) {
          const legacyResult = await client
            .from("telegram_push_records")
            .select(LEGACY_TELEGRAM_PUSH_RECORD_COLUMNS)
            .eq("id", id)
            .maybeSingle();
          data = (legacyResult.data as unknown as Record<string, unknown> | null) ?? null;
          error = legacyResult.error;
        }

        if (error) {
          wrapStorageError("读取 Telegram 推送记录详情", error);
        }

        return data ? mapTelegramPushRecordRow(data) : null;
      },
      async findLatestByContext(input) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const isTestEvent = input.eventType === "test";
        let query = client
          .from("telegram_push_records")
          .select(TELEGRAM_PUSH_RECORD_COLUMNS)
          .eq("event_type", input.eventType)
          .order("created_at", {ascending: false})
          .limit(1);

        if (!isTestEvent) {
          query = query.eq("notification_key", input.notificationKey ?? "");
        }

        const {data, error} = await query.maybeSingle();
        if (isMissingTelegramPushRecordColumnError(error)) {
          return null;
        }
        if (error) {
          wrapStorageError("读取最新 Telegram 推送记录", error);
        }

        return data ? mapTelegramPushRecordRow(data as Record<string, unknown>) : null;
      },
      async create(input: TelegramPushRecordMutationInput) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const payload = {
          id: input.id ?? createStorageId(),
          project_name: input.project_name,
          title: input.title,
          content: input.content,
          chat_id: input.chat_id ?? null,
          notification_key: input.notification_key ?? null,
          event_type: input.event_type ?? null,
          status: input.status ?? "pending",
          push_count: input.push_count ?? 0,
          failure_reason: input.failure_reason ?? null,
          last_pushed_at: input.last_pushed_at ?? null,
        };
        const {data, error} = await client
          .from("telegram_push_records")
          .upsert(payload, {onConflict: "id"})
          .select(TELEGRAM_PUSH_RECORD_COLUMNS)
          .single();

        if (error) {
          wrapStorageError("创建 Telegram 推送记录", error);
        }

        return mapTelegramPushRecordRow(data as Record<string, unknown>);
      },
      async updateStatus(input: TelegramPushRecordStatusUpdateInput) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const payload: Record<string, unknown> = {
          status: input.status,
          push_count: input.push_count,
          failure_reason: input.failure_reason ?? null,
          last_pushed_at: input.last_pushed_at ?? null,
        };
        if (input.chat_id !== undefined) {
          payload.chat_id = input.chat_id;
        }

        const {data, error} = await client
          .from("telegram_push_records")
          .update(payload)
          .eq("id", input.id)
          .select(TELEGRAM_PUSH_RECORD_COLUMNS)
          .single();

        if (error) {
          wrapStorageError("更新 Telegram 推送记录", error);
        }

        return mapTelegramPushRecordRow(data as Record<string, unknown>);
      },
      async delete(id) {
        await ensureReady();
        await ensureTelegramStorageReady();
        const client = createAdminClient({allowDraft});
        const {error} = await client.from("telegram_push_records").delete().eq("id", id);

        if (error) {
          wrapStorageError("删除 Telegram 推送记录", error);
        }
      },
    },
  };
}
