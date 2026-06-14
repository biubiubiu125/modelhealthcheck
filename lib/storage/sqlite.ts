import "server-only";

import {mkdirSync} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {getErrorMessage} from "@/lib/utils";

import {
  createStorageId,
  getDefaultRequestTemplateRows,
  getDefaultSiteSettingsRow,
  getDefaultTelegramPushConfigRow,
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
  nowIso,
  serializeJson,
  SQLITE_CONTROL_PLANE_SCHEMA_STATEMENTS,
  SQLITE_RUNTIME_SCHEMA_STATEMENTS,
} from "./shared";
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

const capabilities: StorageCapabilities = {
  provider: "sqlite",
  adminAuth: true,
  siteSettings: true,
  controlPlaneCrud: true,
  requestTemplates: true,
  notifications: true,
  historySnapshots: true,
  availabilityStats: true,
  pollerLease: false,
  runtimeMigrations: false,
  supabaseDiagnostics: false,
  autoProvisionControlPlane: true,
};

let sqliteCache:
  | {
      filePath: string;
      db: Database.Database;
    }
  | null = null;

export function resetSqliteControlPlaneStorageCache(): void {
  if (sqliteCache) {
    try {
      sqliteCache.db.close();
    } catch {
    }
  }

  sqliteCache = null;
}

function getDatabase(filePath: string): Database.Database {
  if (sqliteCache?.filePath === filePath) {
    return sqliteCache.db;
  }

  mkdirSync(path.dirname(filePath), {recursive: true});
  const db = new Database(filePath);
  sqliteCache = {
    filePath,
    db,
  };

  return db;
}

function wrapError(action: string, error: unknown): never {
  throw new Error(`${action}失败：${getErrorMessage(error)}`);
}

function ensureColumnExists(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{name: string}>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
}

export function createSqliteControlPlaneStorage(filePath: string): ControlPlaneStorage {
  const db = getDatabase(filePath);
  let readyPromise: Promise<void> | null = null;

  async function ensureReady(): Promise<void> {
    if (readyPromise) {
      return readyPromise;
    }

    readyPromise = Promise.resolve()
      .then(() => {
        for (const statement of SQLITE_CONTROL_PLANE_SCHEMA_STATEMENTS) {
          db.prepare(statement).run();
        }

        for (const statement of SQLITE_RUNTIME_SCHEMA_STATEMENTS) {
          db.prepare(statement).run();
        }

        ensureColumnExists(db, "site_settings", "site_icon_url", "text NOT NULL DEFAULT '/favicon.png'");
        ensureColumnExists(db, "site_settings", "admin_entry_path", "text NOT NULL DEFAULT '/admin'");
        ensureColumnExists(
          db,
          "site_settings",
          "telegram_notification_name",
          "text NOT NULL DEFAULT 'RKAPI模型监控'"
        );
        ensureColumnExists(db, "telegram_push_records", "notification_key", "text");
        ensureColumnExists(db, "telegram_push_records", "event_type", "text");
        db.prepare(
          `CREATE INDEX IF NOT EXISTS idx_telegram_push_records_notification_key ON telegram_push_records (notification_key)`
        ).run();

        const defaults = getDefaultSiteSettingsRow();
        db.prepare(
          `
            INSERT INTO site_settings (
              singleton_key,
              site_name,
              site_description,
              site_icon_url,
              hero_badge,
              hero_title_primary,
              hero_title_secondary,
              hero_description,
              footer_brand,
              admin_console_title,
              admin_console_description,
              admin_entry_path,
              telegram_notification_name,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(singleton_key) DO NOTHING
          `
        ).run(
          defaults.singleton_key,
          defaults.site_name,
          defaults.site_description,
          defaults.site_icon_url,
          defaults.hero_badge,
          defaults.hero_title_primary,
          defaults.hero_title_secondary,
          defaults.hero_description,
          defaults.footer_brand,
          defaults.admin_console_title,
          defaults.admin_console_description,
          defaults.admin_entry_path,
          defaults.telegram_notification_name,
          defaults.created_at,
          defaults.updated_at
        );

        const telegramDefaults = getDefaultTelegramPushConfigRow();
        db.prepare(
          `
            INSERT INTO telegram_push_config (
              singleton_key,
              project_name,
              bot_token,
              chat_id,
              auto_push_enabled,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(singleton_key) DO NOTHING
          `
        ).run(
          telegramDefaults.singleton_key,
          telegramDefaults.project_name,
          telegramDefaults.bot_token,
          telegramDefaults.chat_id,
          telegramDefaults.auto_push_enabled ? 1 : 0,
          telegramDefaults.created_at,
          telegramDefaults.updated_at
        );

        const templateStatement = db.prepare(
          `
            INSERT INTO check_request_templates (
              id,
              name,
              type,
              request_header,
              metadata,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `
        );

        for (const template of getDefaultRequestTemplateRows()) {
          templateStatement.run(
            template.id,
            template.name,
            template.type,
            serializeJson(template.request_header),
            serializeJson(template.metadata),
            template.created_at,
            template.updated_at
          );
        }
      })
      .catch((error) => {
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

  function chunkRows<T>(rows: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < rows.length; index += size) {
      chunks.push(rows.slice(index, index + size));
    }
    return chunks;
  }

  async function fetchHistoryRows(options?: RuntimeHistoryQueryOptions) {
    await ensureReady();

    const normalizedIds = normalizeIds(options?.allowedIds);
    if (Array.isArray(normalizedIds) && normalizedIds.length === 0) {
      return [];
    }

    const limitPerConfig = options?.limitPerConfig ?? 60;
    const filterClause = normalizedIds
      ? `WHERE h.config_id IN (${normalizedIds.map(() => "?").join(", ")})`
      : "";
    const limitClause = typeof limitPerConfig === "number" ? `WHERE row_number <= ?` : "";

    try {
      const params: Array<string | number> = [...(normalizedIds ?? [])];
      if (typeof limitPerConfig === "number") {
        params.push(limitPerConfig);
      }

      const rows = db.prepare(
        `
          WITH ranked_history AS (
            SELECT
              CAST(h.id AS text) AS id,
              h.config_id,
              h.status,
              h.latency_ms,
              h.ping_latency_ms,
              h.checked_at,
              h.message,
              c.name,
              c.type,
              c.model,
              c.endpoint,
              c.group_name,
              ROW_NUMBER() OVER (PARTITION BY h.config_id ORDER BY h.checked_at DESC) AS row_number
            FROM check_history h
            INNER JOIN check_configs c ON c.id = h.config_id
            ${filterClause}
          )
          SELECT id, config_id, status, latency_ms, ping_latency_ms, checked_at, message, name, type, model, endpoint, group_name
          FROM ranked_history
          ${limitClause}
          ORDER BY checked_at DESC
        `
      ).all(...params) as Array<Record<string, unknown>>;

      return rows.map(mapHistorySnapshotRow);
    } catch (error) {
      wrapError("读取历史快照", error);
    }
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

    const statement = db.prepare(
      `
        INSERT INTO check_history (
          config_id,
          status,
          latency_ms,
          ping_latency_ms,
          checked_at,
          message,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    );

    const insertMany = db.transaction(
      (entries: typeof results) => {
        for (const result of entries) {
          statement.run(
            result.id,
            result.status,
            result.latencyMs,
            result.pingLatencyMs,
            result.checkedAt,
            result.message,
            result.checkedAt
          );
        }
      }
    );

    try {
      insertMany(results);
    } catch (error) {
      wrapError("写入历史记录", error);
    }
  }

  async function pruneHistory(retentionDays: number) {
    await ensureReady();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    try {
      db.prepare(`DELETE FROM check_history WHERE checked_at < ?`).run(cutoff);
    } catch (error) {
      wrapError("清理历史记录", error);
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

    const deleteStatement = db.prepare(
      `DELETE FROM check_history WHERE config_id IN (${normalizedIds.map(() => "?").join(", ")})`
    );
    const insertStatement = db.prepare(
      `
        INSERT INTO check_history (
          config_id,
          status,
          latency_ms,
          ping_latency_ms,
          checked_at,
          message,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    );

    const replaceMany = db.transaction((rows: typeof input.rows) => {
      deleteStatement.run(...normalizedIds);
      for (const batch of chunkRows(rows, 500)) {
        for (const row of batch) {
          insertStatement.run(
            row.config_id,
            row.status,
            row.latency_ms,
            row.ping_latency_ms,
            row.checked_at,
            row.message,
            row.checked_at
          );
        }
      }
    });

    try {
      replaceMany(input.rows);
    } catch (error) {
      wrapError("替换历史记录", error);
    }
  }

  async function listAvailabilityStats(configIds?: Iterable<string> | null) {
    await ensureReady();

    const normalizedIds = normalizeIds(configIds);
    if (Array.isArray(normalizedIds) && normalizedIds.length === 0) {
      return [];
    }

    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff15d = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const buildSelect = (period: "7d" | "15d" | "30d") => `
      SELECT
        config_id,
        '${period}' AS period,
        COUNT(*) AS total_checks,
        SUM(CASE WHEN status = 'operational' THEN 1 ELSE 0 END) AS operational_count,
        ROUND(100.0 * SUM(CASE WHEN status = 'operational' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS availability_pct
      FROM check_history
      WHERE checked_at > ?
      ${normalizedIds ? `AND config_id IN (${normalizedIds.map(() => "?").join(", ")})` : ""}
      GROUP BY config_id
    `;

    try {
      const statement = db.prepare(
        `
          ${buildSelect("7d")}
          UNION ALL
          ${buildSelect("15d")}
          UNION ALL
          ${buildSelect("30d")}
          ORDER BY config_id ASC, period ASC
        `
      );
      const params = normalizedIds
        ? [
            cutoff7d,
            ...normalizedIds,
            cutoff15d,
            ...normalizedIds,
            cutoff30d,
            ...normalizedIds,
          ]
        : [cutoff7d, cutoff15d, cutoff30d];
      const rows = statement.all(...params) as Array<Record<string, unknown>>;
      return rows.map(mapAvailabilityStatsRow);
    } catch (error) {
      wrapError("读取可用性统计", error);
    }
  }

  return {
    provider: "sqlite",
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
        try {
          const row = db.prepare(`SELECT id FROM admin_users LIMIT 1`).get() as
            | Record<string, unknown>
            | undefined;
          return Boolean(row?.id);
        } catch (error) {
          wrapError("读取管理员账户", error);
        }
      },
      async list() {
        await ensureReady();
        try {
          const rows = db
            .prepare(
              `
                SELECT id, username, password_hash, last_login_at, created_at, updated_at
                FROM admin_users
                ORDER BY username ASC
              `
            )
            .all() as Array<Record<string, unknown>>;

          return rows.map(mapAdminUserRecord);
        } catch (error) {
          wrapError("读取管理员账户列表", error);
        }
      },
      async findByUsername(username) {
        await ensureReady();
        try {
          const row = db
            .prepare(
              `
                SELECT id, username, password_hash, last_login_at, created_at, updated_at
                FROM admin_users
                WHERE username = ?
                LIMIT 1
              `
            )
            .get(username) as Record<string, unknown> | undefined;

          return row ? mapAdminUserRecord(row) : null;
        } catch (error) {
          wrapError("读取管理员账户", error);
        }
      },
      async create(input) {
        await ensureReady();
        const id = createStorageId();
        const timestamp = nowIso();

        try {
          db.prepare(
            `
              INSERT INTO admin_users (
                id,
                username,
                password_hash,
                last_login_at,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `
          ).run(id, input.username, input.passwordHash, input.lastLoginAt ?? null, timestamp, timestamp);

          return mapAdminUserRecord({
            id,
            username: input.username,
            password_hash: input.passwordHash,
            last_login_at: input.lastLoginAt ?? null,
            created_at: timestamp,
            updated_at: timestamp,
          });
        } catch (error) {
          wrapError("创建管理员账户", error);
        }
      },
      async replaceAll(records) {
        await ensureReady();
        try {
          const insertStatement = db.prepare(
            `
              INSERT INTO admin_users (
                id,
                username,
                password_hash,
                last_login_at,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `
          );
          const transaction = db.transaction((rows: typeof records) => {
            db.prepare(`DELETE FROM admin_users`).run();
            for (const row of rows) {
              insertStatement.run(
                row.id,
                row.username,
                row.password_hash,
                row.last_login_at ?? null,
                row.created_at ?? nowIso(),
                row.updated_at ?? nowIso()
              );
            }
          });

          transaction(records);
        } catch (error) {
          wrapError("导入管理员账户", error);
        }
      },
      async updateLastLoginAt(id, lastLoginAt) {
        await ensureReady();
        try {
          db.prepare(
            `UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?`
          ).run(lastLoginAt, nowIso(), id);
        } catch (error) {
          wrapError("更新管理员登录时间", error);
        }
      },
    },
    siteSettings: {
      async getSingleton(singletonKey) {
        await ensureReady();
        try {
          const row = db
            .prepare(
              `
                SELECT singleton_key, site_name, site_description, site_icon_url, hero_badge, hero_title_primary,
                       hero_title_secondary, hero_description, footer_brand,
                       admin_console_title, admin_console_description, admin_entry_path,
                       telegram_notification_name, created_at, updated_at
                FROM site_settings
                WHERE singleton_key = ?
                LIMIT 1
              `
            )
            .get(singletonKey) as Record<string, unknown> | undefined;

          return row ? mapSiteSettingsRow(row) : null;
        } catch (error) {
          wrapError("读取站点设置", error);
        }
      },
      async upsert(input: SiteSettingsMutationInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          db.prepare(
            `
              INSERT INTO site_settings (
                singleton_key,
                site_name,
                site_description,
                site_icon_url,
                hero_badge,
                hero_title_primary,
                hero_title_secondary,
                hero_description,
                footer_brand,
                admin_console_title,
                admin_console_description,
                admin_entry_path,
                telegram_notification_name,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(singleton_key) DO UPDATE SET
                site_name = excluded.site_name,
                site_description = excluded.site_description,
                site_icon_url = excluded.site_icon_url,
                hero_badge = excluded.hero_badge,
                hero_title_primary = excluded.hero_title_primary,
                hero_title_secondary = excluded.hero_title_secondary,
                hero_description = excluded.hero_description,
                footer_brand = excluded.footer_brand,
                admin_console_title = excluded.admin_console_title,
                admin_console_description = excluded.admin_console_description,
                admin_entry_path = excluded.admin_entry_path,
                telegram_notification_name = excluded.telegram_notification_name,
                updated_at = excluded.updated_at
            `
          ).run(
            input.singleton_key,
            input.site_name,
            input.site_description,
            input.site_icon_url,
            input.hero_badge,
            input.hero_title_primary,
            input.hero_title_secondary,
            input.hero_description,
            input.footer_brand,
            input.admin_console_title,
            input.admin_console_description,
            input.admin_entry_path,
            input.telegram_notification_name,
            timestamp,
            timestamp
          );
        } catch (error) {
          wrapError("保存站点设置", error);
        }
      },
    },
    checkConfigs: {
      async list(input) {
        await ensureReady();
        try {
          const statement = db.prepare(
            `
              SELECT id, name, type, model, endpoint, api_key, enabled, is_maintenance,
                     template_id, request_header, metadata, group_name, created_at, updated_at
              FROM check_configs
              ${input?.enabledOnly ? "WHERE enabled = 1" : ""}
              ORDER BY updated_at DESC, created_at DESC
            `
          );
          const rows = statement.all() as Array<Record<string, unknown>>;
          return rows.map(mapCheckConfigRow);
        } catch (error) {
          wrapError("读取检测配置", error);
        }
      },
      async getById(id) {
        await ensureReady();
        try {
          const row = db
            .prepare(
              `
                SELECT id, name, type, model, endpoint, api_key, enabled, is_maintenance,
                       template_id, request_header, metadata, group_name, created_at, updated_at
                FROM check_configs
                WHERE id = ?
                LIMIT 1
              `
            )
            .get(id) as Record<string, unknown> | undefined;

          return row ? mapCheckConfigRow(row) : null;
        } catch (error) {
          wrapError("读取检测配置", error);
        }
      },
      async upsert(input: CheckConfigMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();

        try {
          db.prepare(
            `
              INSERT INTO check_configs (
                id,
                name,
                type,
                model,
                endpoint,
                api_key,
                enabled,
                is_maintenance,
                template_id,
                request_header,
                metadata,
                group_name,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                type = excluded.type,
                model = excluded.model,
                endpoint = excluded.endpoint,
                api_key = excluded.api_key,
                enabled = excluded.enabled,
                is_maintenance = excluded.is_maintenance,
                template_id = excluded.template_id,
                request_header = excluded.request_header,
                metadata = excluded.metadata,
                group_name = excluded.group_name,
                updated_at = excluded.updated_at
            `
          ).run(
            payloadId,
            input.name,
            input.type,
            input.model,
            input.endpoint,
            input.api_key,
            input.enabled ? 1 : 0,
            input.is_maintenance ? 1 : 0,
            input.template_id ?? null,
            serializeJson(input.request_header),
            serializeJson(input.metadata),
            input.group_name ?? null,
            timestamp,
            timestamp
          );
        } catch (error) {
          wrapError("保存检测配置", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          db.prepare(`DELETE FROM check_configs WHERE id = ?`).run(id);
        } catch (error) {
          wrapError("删除检测配置", error);
        }
      },
    },
    requestTemplates: {
      async list() {
        await ensureReady();
        try {
          const rows = db
            .prepare(
              `
                SELECT id, name, type, request_header, metadata, created_at, updated_at
                FROM check_request_templates
                ORDER BY updated_at DESC, created_at DESC
              `
            )
            .all() as Array<Record<string, unknown>>;
          return rows.map(mapRequestTemplateRow);
        } catch (error) {
          wrapError("读取请求模板", error);
        }
      },
      async upsert(input: RequestTemplateMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();

        try {
          db.prepare(
            `
              INSERT INTO check_request_templates (
                id,
                name,
                type,
                request_header,
                metadata,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                type = excluded.type,
                request_header = excluded.request_header,
                metadata = excluded.metadata,
                updated_at = excluded.updated_at
            `
          ).run(
            payloadId,
            input.name,
            input.type,
            serializeJson(input.request_header),
            serializeJson(input.metadata),
            timestamp,
            timestamp
          );
        } catch (error) {
          wrapError("保存请求模板", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          db.prepare(`DELETE FROM check_request_templates WHERE id = ?`).run(id);
        } catch (error) {
          wrapError("删除请求模板", error);
        }
      },
    },
    notifications: {
      async list() {
        await ensureReady();
        try {
          const rows = db
            .prepare(
              `
                SELECT id, message, is_active, level, created_at
                FROM system_notifications
                ORDER BY created_at DESC
              `
            )
            .all() as Array<Record<string, unknown>>;
          return rows.map(mapNotificationRow);
        } catch (error) {
          wrapError("读取系统通知", error);
        }
      },
      async listActive() {
        await ensureReady();
        try {
          const rows = db
            .prepare(
              `
                SELECT id, message, is_active, level, created_at
                FROM system_notifications
                WHERE is_active = 1
                ORDER BY created_at DESC
              `
            )
            .all() as Array<Record<string, unknown>>;
          return rows.map(mapNotificationRow);
        } catch (error) {
          wrapError("读取系统通知", error);
        }
      },
      async upsert(input: NotificationMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();

        try {
          db.prepare(
            `
              INSERT INTO system_notifications (
                id,
                message,
                is_active,
                level,
                created_at
              )
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                message = excluded.message,
                is_active = excluded.is_active,
                level = excluded.level
            `
          ).run(payloadId, input.message, input.is_active ? 1 : 0, input.level, timestamp);
        } catch (error) {
          wrapError("保存系统通知", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          db.prepare(`DELETE FROM system_notifications WHERE id = ?`).run(id);
        } catch (error) {
          wrapError("删除系统通知", error);
        }
      },
    },
    telegramAlertStates: {
      async list(input) {
        await ensureReady();
        const limit = input?.limit === null ? null : Math.min(Math.max(input?.limit ?? 100, 1), 500);

        try {
          const rows = db
            .prepare(
              `
                SELECT notification_key, config_id, model, state, failure_count, success_count,
                       last_status, last_message, failure_started_at, last_failure_at,
                       last_success_at, last_notified_at, created_at, updated_at
                FROM telegram_alert_states
                ORDER BY updated_at DESC, notification_key ASC
                ${limit === null ? "" : "LIMIT ?"}
              `
            )
            .all(...(limit === null ? [] : [limit])) as Array<Record<string, unknown>>;

          return rows.map(mapTelegramAlertStateRow);
        } catch (error) {
          wrapError("读取 Telegram 告警状态列表", error);
        }
      },
      async get(notificationKey) {
        await ensureReady();
        try {
          const row = db
            .prepare(
              `
                SELECT notification_key, config_id, model, state, failure_count, success_count,
                       last_status, last_message, failure_started_at, last_failure_at,
                       last_success_at, last_notified_at, created_at, updated_at
                FROM telegram_alert_states
                WHERE notification_key = ?
                LIMIT 1
              `
            )
            .get(notificationKey) as Record<string, unknown> | undefined;

          return row ? mapTelegramAlertStateRow(row) : null;
        } catch (error) {
          wrapError("读取 Telegram 告警状态", error);
        }
      },
      async upsert(input: TelegramAlertStateMutationInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          db.prepare(
            `
              INSERT INTO telegram_alert_states (
                notification_key,
                config_id,
                model,
                state,
                failure_count,
                success_count,
                last_status,
                last_message,
                failure_started_at,
                last_failure_at,
                last_success_at,
                last_notified_at,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(notification_key) DO UPDATE SET
                config_id = excluded.config_id,
                model = excluded.model,
                state = excluded.state,
                failure_count = excluded.failure_count,
                success_count = excluded.success_count,
                last_status = excluded.last_status,
                last_message = excluded.last_message,
                failure_started_at = excluded.failure_started_at,
                last_failure_at = excluded.last_failure_at,
                last_success_at = excluded.last_success_at,
                last_notified_at = excluded.last_notified_at,
                updated_at = excluded.updated_at
            `
          ).run(
            input.notification_key,
            input.config_id,
            input.model,
            input.state,
            input.failure_count,
            input.success_count,
            input.last_status ?? null,
            input.last_message ?? null,
            input.failure_started_at ?? null,
            input.last_failure_at ?? null,
            input.last_success_at ?? null,
            input.last_notified_at ?? null,
            timestamp,
            timestamp
          );

          const savedRow = db
            .prepare(
              `
                SELECT notification_key, config_id, model, state, failure_count, success_count,
                       last_status, last_message, failure_started_at, last_failure_at,
                       last_success_at, last_notified_at, created_at, updated_at
                FROM telegram_alert_states
                WHERE notification_key = ?
                LIMIT 1
              `
            )
            .get(input.notification_key) as Record<string, unknown> | undefined;
          if (!savedRow) {
            throw new Error("Telegram 告警状态保存后未找到记录");
          }
          return mapTelegramAlertStateRow(savedRow);
        } catch (error) {
          wrapError("保存 Telegram 告警状态", error);
        }
      },
      async delete(notificationKey) {
        await ensureReady();
        try {
          db.prepare(`DELETE FROM telegram_alert_states WHERE notification_key = ?`).run(
            notificationKey
          );
        } catch (error) {
          wrapError("删除 Telegram 告警状态", error);
        }
      },
    },
    telegramPushConfig: {
      async getSingleton(singletonKey) {
        await ensureReady();
        try {
          const row = db
            .prepare(
              `
                SELECT singleton_key, project_name, bot_token, chat_id, auto_push_enabled,
                       created_at, updated_at
                FROM telegram_push_config
                WHERE singleton_key = ?
                LIMIT 1
              `
            )
            .get(singletonKey) as Record<string, unknown> | undefined;

          return row ? mapTelegramPushConfigRow(row) : null;
        } catch (error) {
          wrapError("读取 Telegram 推送配置", error);
        }
      },
      async upsert(input: TelegramPushConfigMutationInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          db.prepare(
            `
              INSERT INTO telegram_push_config (
                singleton_key,
                project_name,
                bot_token,
                chat_id,
                auto_push_enabled,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(singleton_key) DO UPDATE SET
                project_name = excluded.project_name,
                bot_token = excluded.bot_token,
                chat_id = excluded.chat_id,
                auto_push_enabled = excluded.auto_push_enabled,
                updated_at = excluded.updated_at
            `
          ).run(
            input.singleton_key,
            input.project_name,
            input.bot_token,
            input.chat_id,
            input.auto_push_enabled ? 1 : 0,
            timestamp,
            timestamp
          );

          const savedRow = db
            .prepare(
              `
                SELECT singleton_key, project_name, bot_token, chat_id, auto_push_enabled,
                       created_at, updated_at
                FROM telegram_push_config
                WHERE singleton_key = ?
                LIMIT 1
              `
            )
            .get(input.singleton_key) as Record<string, unknown> | undefined;

          if (!savedRow) {
            throw new Error("Telegram 推送配置保存后未找到记录");
          }

          return mapTelegramPushConfigRow(savedRow);
        } catch (error) {
          wrapError("保存 Telegram 推送配置", error);
        }
      },
    },
    telegramPushRecords: {
      async list(input) {
        await ensureReady();
        const limit = input?.limit === null ? null : Math.min(Math.max(input?.limit ?? 100, 1), 500);

        try {
          const rows = db
            .prepare(
              `
                SELECT id, project_name, title, content, chat_id, status, push_count,
                       notification_key, event_type, failure_reason, last_pushed_at,
                       created_at, updated_at
                FROM telegram_push_records
                ORDER BY created_at DESC
                ${limit === null ? "" : "LIMIT ?"}
              `
            )
            .all(...(limit === null ? [] : [limit])) as Array<Record<string, unknown>>;

          return rows.map(mapTelegramPushRecordRow);
        } catch (error) {
          wrapError("读取 Telegram 推送记录", error);
        }
      },
      async getById(id) {
        await ensureReady();
        try {
          const row = db
            .prepare(
              `
                SELECT id, project_name, title, content, chat_id, status, push_count,
                       notification_key, event_type, failure_reason, last_pushed_at,
                       created_at, updated_at
                FROM telegram_push_records
                WHERE id = ?
                LIMIT 1
              `
            )
            .get(id) as Record<string, unknown> | undefined;

          return row ? mapTelegramPushRecordRow(row) : null;
        } catch (error) {
          wrapError("读取 Telegram 推送记录详情", error);
        }
      },
      async findLatestByContext(input) {
        await ensureReady();
        const isTestEvent = input.eventType === "test";
        const whereClause = isTestEvent
          ? "event_type = ?"
          : "notification_key = ? AND event_type = ?";
        const params = isTestEvent ? [input.eventType] : [input.notificationKey ?? "", input.eventType];

        try {
          const row = db
            .prepare(
              `
                SELECT id, project_name, title, content, chat_id, status, push_count,
                       notification_key, event_type, failure_reason, last_pushed_at,
                       created_at, updated_at
                FROM telegram_push_records
                WHERE ${whereClause}
                ORDER BY created_at DESC
                LIMIT 1
              `
            )
            .get(...params) as Record<string, unknown> | undefined;

          return row ? mapTelegramPushRecordRow(row) : null;
        } catch (error) {
          wrapError("读取最新 Telegram 推送记录", error);
        }
      },
      async create(input: TelegramPushRecordMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();

        try {
          db.prepare(
            `
              INSERT INTO telegram_push_records (
                id,
                project_name,
                title,
                content,
                chat_id,
                notification_key,
                event_type,
                status,
                push_count,
                failure_reason,
                last_pushed_at,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                project_name = excluded.project_name,
                title = excluded.title,
                content = excluded.content,
                chat_id = excluded.chat_id,
                notification_key = excluded.notification_key,
                event_type = excluded.event_type,
                status = excluded.status,
                push_count = excluded.push_count,
                failure_reason = excluded.failure_reason,
                last_pushed_at = excluded.last_pushed_at,
                updated_at = excluded.updated_at
            `
          ).run(
            payloadId,
            input.project_name,
            input.title,
            input.content,
            input.chat_id ?? null,
            input.notification_key ?? null,
            input.event_type ?? null,
            input.status ?? "pending",
            input.push_count ?? 0,
            input.failure_reason ?? null,
            input.last_pushed_at ?? null,
            timestamp,
            timestamp
          );

          const savedRow = db
            .prepare(
              `
                SELECT id, project_name, title, content, chat_id, status, push_count,
                       notification_key, event_type, failure_reason, last_pushed_at,
                       created_at, updated_at
                FROM telegram_push_records
                WHERE id = ?
                LIMIT 1
              `
            )
            .get(payloadId) as Record<string, unknown> | undefined;

          if (!savedRow) {
            throw new Error("Telegram 推送记录创建后未找到记录");
          }

          return mapTelegramPushRecordRow(savedRow);
        } catch (error) {
          wrapError("创建 Telegram 推送记录", error);
        }
      },
      async updateStatus(input: TelegramPushRecordStatusUpdateInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          db.prepare(
            `
              UPDATE telegram_push_records
              SET status = ?,
                  push_count = ?,
                  failure_reason = ?,
                  last_pushed_at = ?,
                  chat_id = COALESCE(?, chat_id),
                  updated_at = ?
              WHERE id = ?
            `
          ).run(
            input.status,
            input.push_count,
            input.failure_reason ?? null,
            input.last_pushed_at ?? null,
            input.chat_id ?? null,
            timestamp,
            input.id
          );

          const savedRow = db
            .prepare(
              `
                SELECT id, project_name, title, content, chat_id, status, push_count,
                       notification_key, event_type, failure_reason, last_pushed_at,
                       created_at, updated_at
                FROM telegram_push_records
                WHERE id = ?
                LIMIT 1
              `
            )
            .get(input.id) as Record<string, unknown> | undefined;

          if (!savedRow) {
            throw new Error("推送记录不存在或已被删除");
          }

          return mapTelegramPushRecordRow(savedRow);
        } catch (error) {
          wrapError("更新 Telegram 推送记录", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          db.prepare(`DELETE FROM telegram_push_records WHERE id = ?`).run(id);
        } catch (error) {
          wrapError("删除 Telegram 推送记录", error);
        }
      },
    },
  };
}
