import "server-only";

import {Pool, type QueryResultRow} from "pg";

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
  POSTGRES_CONTROL_PLANE_SCHEMA_STATEMENTS,
  POSTGRES_RUNTIME_SCHEMA_STATEMENTS,
  serializeJson,
} from "./shared";
import {resolvePostgresSsl} from "./postgres-ssl";
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
  provider: "postgres",
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

let poolCache:
  | {
      connectionString: string;
      pool: Pool;
    }
  | null = null;

export async function resetPostgresControlPlaneStorageCache(): Promise<void> {
  if (!poolCache) {
    return;
  }

  const current = poolCache;
  poolCache = null;
  try {
    await current.pool.end();
  } catch {
  }
}

function getPool(connectionString: string): Pool {
  if (poolCache?.connectionString === connectionString) {
    return poolCache.pool;
  }

  const ssl = resolvePostgresSsl(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: ssl.ssl,
  });
  poolCache = {
    connectionString,
    pool,
  };

  return pool;
}

function wrapError(action: string, error: unknown): never {
  throw new Error(`${action}失败：${getErrorMessage(error)}`);
}

function mapRows<T extends QueryResultRow>(rows: T[] | undefined): Array<Record<string, unknown>> {
  return (rows ?? []) as Array<Record<string, unknown>>;
}

async function ensureColumnExists(pool: Pool, tableName: string, columnName: string, definition: string) {
  const result = await pool.query<{exists: boolean}>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
      ) AS exists
    `,
    [tableName, columnName]
  );

  if (result.rows[0]?.exists) {
    return;
  }

  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

export function createPostgresControlPlaneStorage(connectionString: string): ControlPlaneStorage {
  const pool = getPool(connectionString);
  let readyPromise: Promise<void> | null = null;

  async function ensureReady(): Promise<void> {
    if (readyPromise) {
      return readyPromise;
    }

    readyPromise = (async () => {
      for (const statement of POSTGRES_CONTROL_PLANE_SCHEMA_STATEMENTS) {
        await pool.query(statement);
      }

      for (const statement of POSTGRES_RUNTIME_SCHEMA_STATEMENTS) {
        await pool.query(statement);
      }

      await ensureColumnExists(pool, "site_settings", "site_icon_url", "text NOT NULL DEFAULT '/favicon.png'");
      await ensureColumnExists(pool, "site_settings", "admin_entry_path", "text NOT NULL DEFAULT '/admin'");
      await ensureColumnExists(
        pool,
        "site_settings",
        "telegram_notification_name",
        "text NOT NULL DEFAULT 'RKAPI模型监控'"
      );
      await ensureColumnExists(pool, "telegram_push_records", "notification_key", "text");
      await ensureColumnExists(pool, "telegram_push_records", "event_type", "text");
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_telegram_push_records_notification_key ON telegram_push_records (notification_key)`
      );

      const defaults = getDefaultSiteSettingsRow();
      await pool.query(
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          ON CONFLICT (singleton_key) DO NOTHING
        `,
        [
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
          defaults.updated_at,
        ]
      );

      const telegramDefaults = getDefaultTelegramPushConfigRow();
      await pool.query(
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
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (singleton_key) DO NOTHING
        `,
        [
          telegramDefaults.singleton_key,
          telegramDefaults.project_name,
          telegramDefaults.bot_token,
          telegramDefaults.chat_id,
          telegramDefaults.auto_push_enabled,
          telegramDefaults.created_at,
          telegramDefaults.updated_at,
        ]
      );

      for (const template of getDefaultRequestTemplateRows()) {
        await pool.query(
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
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
            ON CONFLICT (id) DO NOTHING
          `,
          [
            template.id,
            template.name,
            template.type,
            serializeJson(template.request_header),
            serializeJson(template.metadata),
            template.created_at,
            template.updated_at,
          ]
        );
      }
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
    const params: Array<string[] | number> = [];
    const filterClause = normalizedIds
      ? (() => {
          params.push(normalizedIds);
          return `WHERE h.config_id::text = ANY($${params.length}::text[])`;
        })()
      : "";
    const limitClause =
      typeof limitPerConfig === "number"
        ? (() => {
            params.unshift(limitPerConfig);
            return `WHERE row_number <= $1`;
          })()
        : "";

    try {
      const result = await pool.query(
        `
          WITH ranked_history AS (
            SELECT
              h.id::text AS id,
              h.config_id::text AS config_id,
              h.status,
              h.latency_ms,
              h.ping_latency_ms,
              h.checked_at,
              h.message,
              c.name,
              c.type::text AS type,
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
        `,
        params
      );

      return mapRows(result.rows).map(mapHistorySnapshotRow);
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

    const placeholders: string[] = [];
    const params: Array<string | number | null> = [];

    for (const result of results) {
      const baseIndex = params.length;
      placeholders.push(
        `($${baseIndex + 1}::uuid, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`
      );
      params.push(
        result.id,
        result.status,
        result.latencyMs,
        result.pingLatencyMs,
        result.checkedAt,
        result.message,
        result.checkedAt
      );
    }

    try {
      await pool.query(
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
          VALUES ${placeholders.join(", ")}
        `,
        params
      );
    } catch (error) {
      wrapError("写入历史记录", error);
    }
  }

  async function pruneHistory(retentionDays: number) {
    await ensureReady();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    try {
      await pool.query(`DELETE FROM check_history WHERE checked_at < $1`, [cutoff]);
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM check_history WHERE config_id::text = ANY($1::text[])`, [normalizedIds]);

      for (const batch of chunkRows(input.rows, 250)) {
        if (batch.length === 0) {
          continue;
        }

        const placeholders: string[] = [];
        const params: Array<string | number | null> = [];
        for (const row of batch) {
          const baseIndex = params.length;
          placeholders.push(
            `($${baseIndex + 1}::uuid, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`
          );
          params.push(
            row.config_id,
            row.status,
            row.latency_ms,
            row.ping_latency_ms,
            row.checked_at,
            row.message,
            row.checked_at
          );
        }

        await client.query(
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
            VALUES ${placeholders.join(", ")}
          `,
          params
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      wrapError("替换历史记录", error);
    } finally {
      client.release();
    }
  }

  async function listAvailabilityStats(configIds?: Iterable<string> | null) {
    await ensureReady();

    const normalizedIds = normalizeIds(configIds);
    if (Array.isArray(normalizedIds) && normalizedIds.length === 0) {
      return [];
    }

    const params: Array<string[]> = [];
    const filterClause = normalizedIds
      ? (() => {
          params.push(normalizedIds);
          return `AND config_id::text = ANY($1::text[])`;
        })()
      : "";

    try {
      const result = await pool.query(
        `
          SELECT config_id::text AS config_id, '7d'::text AS period,
                 COUNT(*)::bigint AS total_checks,
                 COUNT(*) FILTER (WHERE status = 'operational')::bigint AS operational_count,
                 ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'operational') / NULLIF(COUNT(*), 0), 2) AS availability_pct
          FROM check_history
          WHERE checked_at > NOW() - INTERVAL '7 days' ${filterClause}
          GROUP BY config_id

          UNION ALL

          SELECT config_id::text AS config_id, '15d'::text AS period,
                 COUNT(*)::bigint AS total_checks,
                 COUNT(*) FILTER (WHERE status = 'operational')::bigint AS operational_count,
                 ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'operational') / NULLIF(COUNT(*), 0), 2) AS availability_pct
          FROM check_history
          WHERE checked_at > NOW() - INTERVAL '15 days' ${filterClause}
          GROUP BY config_id

          UNION ALL

          SELECT config_id::text AS config_id, '30d'::text AS period,
                 COUNT(*)::bigint AS total_checks,
                 COUNT(*) FILTER (WHERE status = 'operational')::bigint AS operational_count,
                 ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'operational') / NULLIF(COUNT(*), 0), 2) AS availability_pct
          FROM check_history
          WHERE checked_at > NOW() - INTERVAL '30 days' ${filterClause}
          GROUP BY config_id

          ORDER BY config_id ASC, period ASC
        `,
        params
      );

      return mapRows(result.rows).map(mapAvailabilityStatsRow);
    } catch (error) {
      wrapError("读取可用性统计", error);
    }
  }

  return {
    provider: "postgres",
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
          const result = await pool.query(`SELECT id FROM admin_users LIMIT 1`);
          return (result.rowCount ?? result.rows.length) > 0;
        } catch (error) {
          wrapError("读取管理员账户", error);
        }
      },
      async list() {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT id, username, password_hash, last_login_at, created_at, updated_at
              FROM admin_users
              ORDER BY username ASC
            `
          );

          return mapRows(result.rows).map(mapAdminUserRecord);
        } catch (error) {
          wrapError("读取管理员账户列表", error);
        }
      },
      async findByUsername(username) {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT id, username, password_hash, last_login_at, created_at, updated_at
              FROM admin_users
              WHERE username = $1
              LIMIT 1
            `,
            [username]
          );

          return result.rows[0] ? mapAdminUserRecord(result.rows[0]) : null;
        } catch (error) {
          wrapError("读取管理员账户", error);
        }
      },
      async create(input) {
        await ensureReady();
        const timestamp = nowIso();
        const id = createStorageId();

        try {
          const result = await pool.query(
            `
              INSERT INTO admin_users (
                id,
                username,
                password_hash,
                last_login_at,
                created_at,
                updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id, username, password_hash, last_login_at, created_at, updated_at
            `,
            [id, input.username, input.passwordHash, input.lastLoginAt ?? null, timestamp, timestamp]
          );

          return mapAdminUserRecord(result.rows[0] as Record<string, unknown>);
        } catch (error) {
          wrapError("创建管理员账户", error);
        }
      },
      async replaceAll(records) {
        await ensureReady();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`DELETE FROM admin_users`);

          for (const row of records) {
            await client.query(
              `
                INSERT INTO admin_users (
                  id,
                  username,
                  password_hash,
                  last_login_at,
                  created_at,
                  updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6)
              `,
              [
                row.id,
                row.username,
                row.password_hash,
                row.last_login_at ?? null,
                row.created_at ?? nowIso(),
                row.updated_at ?? nowIso(),
              ]
            );
          }

          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          wrapError("导入管理员账户", error);
        } finally {
          client.release();
        }
      },
      async updateLastLoginAt(id, lastLoginAt) {
        await ensureReady();
        try {
          await pool.query(
            `UPDATE admin_users SET last_login_at = $2, updated_at = $3 WHERE id = $1`,
            [id, lastLoginAt, nowIso()]
          );
        } catch (error) {
          wrapError("更新管理员登录时间", error);
        }
      },
    },
    siteSettings: {
      async getSingleton(singletonKey) {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT singleton_key, site_name, site_description, site_icon_url, hero_badge, hero_title_primary,
                     hero_title_secondary, hero_description, footer_brand,
                     admin_console_title, admin_console_description, admin_entry_path,
                     telegram_notification_name, created_at, updated_at
              FROM site_settings
              WHERE singleton_key = $1
              LIMIT 1
            `,
            [singletonKey]
          );

          return result.rows[0] ? mapSiteSettingsRow(result.rows[0]) : null;
        } catch (error) {
          wrapError("读取站点设置", error);
        }
      },
      async upsert(input: SiteSettingsMutationInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          await pool.query(
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
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
              ON CONFLICT (singleton_key)
              DO UPDATE SET
                site_name = EXCLUDED.site_name,
                site_description = EXCLUDED.site_description,
                site_icon_url = EXCLUDED.site_icon_url,
                hero_badge = EXCLUDED.hero_badge,
                hero_title_primary = EXCLUDED.hero_title_primary,
                hero_title_secondary = EXCLUDED.hero_title_secondary,
                hero_description = EXCLUDED.hero_description,
                footer_brand = EXCLUDED.footer_brand,
                admin_console_title = EXCLUDED.admin_console_title,
                admin_console_description = EXCLUDED.admin_console_description,
                admin_entry_path = EXCLUDED.admin_entry_path,
                telegram_notification_name = EXCLUDED.telegram_notification_name,
                updated_at = EXCLUDED.updated_at
            `,
            [
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
              timestamp,
            ]
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
          const result = await pool.query(
            `
              SELECT id, name, type, model, endpoint, api_key, enabled, is_maintenance,
                     template_id, request_header, metadata, group_name, created_at, updated_at
              FROM check_configs
              ${input?.enabledOnly ? "WHERE enabled = true" : ""}
              ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
            `
          );

          return mapRows(result.rows).map(mapCheckConfigRow);
        } catch (error) {
          wrapError("读取检测配置", error);
        }
      },
      async getById(id) {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT id, name, type, model, endpoint, api_key, enabled, is_maintenance,
                     template_id, request_header, metadata, group_name, created_at, updated_at
              FROM check_configs
              WHERE id = $1
              LIMIT 1
            `,
            [id]
          );

          return result.rows[0] ? mapCheckConfigRow(result.rows[0]) : null;
        } catch (error) {
          wrapError("读取检测配置", error);
        }
      },
      async upsert(input: CheckConfigMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();
        const requestHeader = serializeJson(input.request_header);
        const metadata = serializeJson(input.metadata);

        try {
          if (input.id) {
            const updateResult = await pool.query(
              `
                UPDATE check_configs
                SET name = $2,
                    type = $3,
                    model = $4,
                    endpoint = $5,
                    api_key = $6,
                    enabled = $7,
                    is_maintenance = $8,
                    template_id = $9,
                    request_header = $10::jsonb,
                    metadata = $11::jsonb,
                    group_name = $12,
                    updated_at = $13
                WHERE id = $1
              `,
              [
                input.id,
                input.name,
                input.type,
                input.model,
                input.endpoint,
                input.api_key,
                input.enabled,
                input.is_maintenance,
                input.template_id ?? null,
                requestHeader,
                metadata,
                input.group_name ?? null,
                timestamp,
              ]
            );

            if ((updateResult.rowCount ?? 0) > 0) {
              return;
            }
          }

          await pool.query(
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
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
            `,
            [
              payloadId,
              input.name,
              input.type,
              input.model,
              input.endpoint,
              input.api_key,
              input.enabled,
              input.is_maintenance,
              input.template_id ?? null,
              requestHeader,
              metadata,
              input.group_name ?? null,
              timestamp,
              timestamp,
            ]
          );
        } catch (error) {
          wrapError("保存检测配置", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          await pool.query(`DELETE FROM check_configs WHERE id = $1`, [id]);
        } catch (error) {
          wrapError("删除检测配置", error);
        }
      },
    },
    requestTemplates: {
      async list() {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT id, name, type, request_header, metadata, created_at, updated_at
              FROM check_request_templates
              ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
            `
          );

          return mapRows(result.rows).map(mapRequestTemplateRow);
        } catch (error) {
          wrapError("读取请求模板", error);
        }
      },
      async upsert(input: RequestTemplateMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();
        const requestHeader = serializeJson(input.request_header);
        const metadata = serializeJson(input.metadata);

        try {
          if (input.id) {
            const updateResult = await pool.query(
              `
                UPDATE check_request_templates
                SET name = $2,
                    type = $3,
                    request_header = $4::jsonb,
                    metadata = $5::jsonb,
                    updated_at = $6
                WHERE id = $1
              `,
              [input.id, input.name, input.type, requestHeader, metadata, timestamp]
            );

            if ((updateResult.rowCount ?? 0) > 0) {
              return;
            }
          }

          await pool.query(
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
              VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
            `,
            [payloadId, input.name, input.type, requestHeader, metadata, timestamp, timestamp]
          );
        } catch (error) {
          wrapError("保存请求模板", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          await pool.query(`DELETE FROM check_request_templates WHERE id = $1`, [id]);
        } catch (error) {
          wrapError("删除请求模板", error);
        }
      },
    },
    notifications: {
      async list() {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT id, message, is_active, level, created_at
              FROM system_notifications
              ORDER BY created_at DESC
            `
          );

          return mapRows(result.rows).map(mapNotificationRow);
        } catch (error) {
          wrapError("读取系统通知", error);
        }
      },
      async listActive() {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT id, message, is_active, level, created_at
              FROM system_notifications
              WHERE is_active = true
              ORDER BY created_at DESC
            `
          );

          return mapRows(result.rows).map(mapNotificationRow);
        } catch (error) {
          wrapError("读取系统通知", error);
        }
      },
      async upsert(input: NotificationMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();

        try {
          if (input.id) {
            const updateResult = await pool.query(
              `
                UPDATE system_notifications
                SET message = $2,
                    is_active = $3,
                    level = $4
                WHERE id = $1
              `,
              [input.id, input.message, input.is_active, input.level]
            );

            if ((updateResult.rowCount ?? 0) > 0) {
              return;
            }
          }

          await pool.query(
            `
              INSERT INTO system_notifications (
                id,
                message,
                is_active,
                level,
                created_at
              )
              VALUES ($1, $2, $3, $4, $5)
            `,
            [payloadId, input.message, input.is_active, input.level, timestamp]
          );
        } catch (error) {
          wrapError("保存系统通知", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          await pool.query(`DELETE FROM system_notifications WHERE id = $1`, [id]);
        } catch (error) {
          wrapError("删除系统通知", error);
        }
      },
    },
    telegramAlertStates: {
      async list(input) {
        await ensureReady();
        const limit = input?.limit === null ? null : Math.min(Math.max(input?.limit ?? 100, 1), 500);
        const limitClause = limit === null ? "" : "LIMIT $1";
        const params = limit === null ? [] : [limit];

        try {
          const result = await pool.query(
            `
              SELECT notification_key, config_id, model, state, failure_count, success_count,
                     last_status, last_message, failure_started_at, last_failure_at,
                     last_success_at, last_notified_at, created_at, updated_at
              FROM telegram_alert_states
              ORDER BY updated_at DESC, notification_key ASC
              ${limitClause}
            `,
            params
          );

          return mapRows(result.rows).map(mapTelegramAlertStateRow);
        } catch (error) {
          wrapError("读取 Telegram 告警状态列表", error);
        }
      },
      async get(notificationKey) {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT notification_key, config_id, model, state, failure_count, success_count,
                     last_status, last_message, failure_started_at, last_failure_at,
                     last_success_at, last_notified_at, created_at, updated_at
              FROM telegram_alert_states
              WHERE notification_key = $1
              LIMIT 1
            `,
            [notificationKey]
          );

          return result.rows[0] ? mapTelegramAlertStateRow(result.rows[0]) : null;
        } catch (error) {
          wrapError("读取 Telegram 告警状态", error);
        }
      },
      async upsert(input: TelegramAlertStateMutationInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          const result = await pool.query(
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
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
              ON CONFLICT (notification_key)
              DO UPDATE SET
                config_id = EXCLUDED.config_id,
                model = EXCLUDED.model,
                state = EXCLUDED.state,
                failure_count = EXCLUDED.failure_count,
                success_count = EXCLUDED.success_count,
                last_status = EXCLUDED.last_status,
                last_message = EXCLUDED.last_message,
                failure_started_at = EXCLUDED.failure_started_at,
                last_failure_at = EXCLUDED.last_failure_at,
                last_success_at = EXCLUDED.last_success_at,
                last_notified_at = EXCLUDED.last_notified_at,
                updated_at = EXCLUDED.updated_at
              RETURNING notification_key, config_id, model, state, failure_count, success_count,
                        last_status, last_message, failure_started_at, last_failure_at,
                        last_success_at, last_notified_at, created_at, updated_at
            `,
            [
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
              timestamp,
            ]
          );

          return mapTelegramAlertStateRow(result.rows[0]);
        } catch (error) {
          wrapError("保存 Telegram 告警状态", error);
        }
      },
      async delete(notificationKey) {
        await ensureReady();
        try {
          await pool.query(`DELETE FROM telegram_alert_states WHERE notification_key = $1`, [
            notificationKey,
          ]);
        } catch (error) {
          wrapError("删除 Telegram 告警状态", error);
        }
      },
    },
    telegramPushConfig: {
      async getSingleton(singletonKey) {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT singleton_key, project_name, bot_token, chat_id, auto_push_enabled,
                     created_at, updated_at
              FROM telegram_push_config
              WHERE singleton_key = $1
              LIMIT 1
            `,
            [singletonKey]
          );

          return result.rows[0] ? mapTelegramPushConfigRow(result.rows[0]) : null;
        } catch (error) {
          wrapError("读取 Telegram 推送配置", error);
        }
      },
      async upsert(input: TelegramPushConfigMutationInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          const result = await pool.query(
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
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (singleton_key)
              DO UPDATE SET
                project_name = EXCLUDED.project_name,
                bot_token = EXCLUDED.bot_token,
                chat_id = EXCLUDED.chat_id,
                auto_push_enabled = EXCLUDED.auto_push_enabled,
                updated_at = EXCLUDED.updated_at
              RETURNING singleton_key, project_name, bot_token, chat_id, auto_push_enabled,
                        created_at, updated_at
            `,
            [
              input.singleton_key,
              input.project_name,
              input.bot_token,
              input.chat_id,
              input.auto_push_enabled,
              timestamp,
              timestamp,
            ]
          );

          return mapTelegramPushConfigRow(result.rows[0]);
        } catch (error) {
          wrapError("保存 Telegram 推送配置", error);
        }
      },
    },
    telegramPushRecords: {
      async list(input) {
        await ensureReady();
        const limit = input?.limit === null ? null : Math.min(Math.max(input?.limit ?? 100, 1), 500);
        const limitClause = limit === null ? "" : "LIMIT $1";
        const params = limit === null ? [] : [limit];

        try {
          const result = await pool.query(
            `
              SELECT id, project_name, title, content, chat_id, status, push_count,
                     notification_key, event_type, failure_reason, last_pushed_at,
                     created_at, updated_at
              FROM telegram_push_records
              ORDER BY created_at DESC
              ${limitClause}
            `,
            params
          );

          return mapRows(result.rows).map(mapTelegramPushRecordRow);
        } catch (error) {
          wrapError("读取 Telegram 推送记录", error);
        }
      },
      async getById(id) {
        await ensureReady();
        try {
          const result = await pool.query(
            `
              SELECT id, project_name, title, content, chat_id, status, push_count,
                     notification_key, event_type, failure_reason, last_pushed_at,
                     created_at, updated_at
              FROM telegram_push_records
              WHERE id = $1
              LIMIT 1
            `,
            [id]
          );

          return result.rows[0] ? mapTelegramPushRecordRow(result.rows[0]) : null;
        } catch (error) {
          wrapError("读取 Telegram 推送记录详情", error);
        }
      },
      async findLatestByContext(input) {
        await ensureReady();
        const isTestEvent = input.eventType === "test";
        const whereClause = isTestEvent
          ? "event_type = $1"
          : "notification_key = $1 AND event_type = $2";
        const params = isTestEvent ? [input.eventType] : [input.notificationKey ?? "", input.eventType];

        try {
          const result = await pool.query(
            `
              SELECT id, project_name, title, content, chat_id, status, push_count,
                     notification_key, event_type, failure_reason, last_pushed_at,
                     created_at, updated_at
              FROM telegram_push_records
              WHERE ${whereClause}
              ORDER BY created_at DESC
              LIMIT 1
            `,
            params
          );

          return result.rows[0] ? mapTelegramPushRecordRow(result.rows[0]) : null;
        } catch (error) {
          wrapError("读取最新 Telegram 推送记录", error);
        }
      },
      async create(input: TelegramPushRecordMutationInput) {
        await ensureReady();
        const timestamp = nowIso();
        const payloadId = input.id ?? createStorageId();

        try {
          const result = await pool.query(
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
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (id)
              DO UPDATE SET
                project_name = EXCLUDED.project_name,
                title = EXCLUDED.title,
                content = EXCLUDED.content,
                chat_id = EXCLUDED.chat_id,
                notification_key = EXCLUDED.notification_key,
                event_type = EXCLUDED.event_type,
                status = EXCLUDED.status,
                push_count = EXCLUDED.push_count,
                failure_reason = EXCLUDED.failure_reason,
                last_pushed_at = EXCLUDED.last_pushed_at,
                updated_at = EXCLUDED.updated_at
              RETURNING id, project_name, title, content, chat_id, notification_key,
                        event_type, status, push_count, failure_reason, last_pushed_at,
                        created_at, updated_at
            `,
            [
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
              timestamp,
            ]
          );

          return mapTelegramPushRecordRow(result.rows[0]);
        } catch (error) {
          wrapError("创建 Telegram 推送记录", error);
        }
      },
      async updateStatus(input: TelegramPushRecordStatusUpdateInput) {
        await ensureReady();
        const timestamp = nowIso();

        try {
          const result = await pool.query(
            `
              UPDATE telegram_push_records
              SET status = $2,
                  push_count = $3,
                  failure_reason = $4,
                  last_pushed_at = $5,
                  chat_id = COALESCE($6, chat_id),
                  updated_at = $7
              WHERE id = $1
              RETURNING id, project_name, title, content, chat_id, status, push_count,
                        notification_key, event_type, failure_reason, last_pushed_at,
                        created_at, updated_at
            `,
            [
              input.id,
              input.status,
              input.push_count,
              input.failure_reason ?? null,
              input.last_pushed_at ?? null,
              input.chat_id ?? null,
              timestamp,
            ]
          );

          if (!result.rows[0]) {
            throw new Error("推送记录不存在或已被删除");
          }

          return mapTelegramPushRecordRow(result.rows[0]);
        } catch (error) {
          wrapError("更新 Telegram 推送记录", error);
        }
      },
      async delete(id) {
        await ensureReady();
        try {
          await pool.query(`DELETE FROM telegram_push_records WHERE id = $1`, [id]);
        } catch (error) {
          wrapError("删除 Telegram 推送记录", error);
        }
      },
    },
  };
}
