import "server-only";

import type {CheckConfigRow, CheckRequestTemplateRow, SystemNotificationRow} from "@/lib/types/database";
import {loadDashboardData} from "@/lib/core/dashboard-data";
import {
  getDefaultTelegramPushConfigRow,
  TELEGRAM_PUSH_SINGLETON_KEY,
} from "@/lib/storage/shared";
import {getControlPlaneStorage, getStorageCapabilities} from "@/lib/storage/resolver";
import type {
  TelegramAlertStateRecord,
  TelegramPushConfigRecord,
  TelegramPushRecord,
} from "@/lib/storage/types";
import {logError} from "@/lib/utils";

export const ADMIN_PROVIDER_TYPES = ["openai", "anthropic", "gemini"] as const;
export type AdminProviderType = (typeof ADMIN_PROVIDER_TYPES)[number];

export const ADMIN_NOTIFICATION_LEVELS = ["info", "warning", "error"] as const;
export type AdminNotificationLevel = (typeof ADMIN_NOTIFICATION_LEVELS)[number];

export interface AdminCheckConfigRow extends CheckConfigRow {
  updated_at?: string | null;
}

export interface AdminOverviewData {
  configCount: number;
  enabledConfigCount: number;
  maintenanceCount: number;
  templateCount: number;
  activeNotificationCount: number;
  telegramPushRecordCount: number;
  lastCheckedAt: string | null;
  latestStatuses: Array<{
    id: string;
    name: string;
    status: string;
    checkedAt: string;
  }>;
  statusBreakdown: Array<{
    status: string;
    count: number;
  }>;
}

export interface AdminManagementData {
  configs: AdminCheckConfigRow[];
  templates: CheckRequestTemplateRow[];
  notifications: SystemNotificationRow[];
  overview: AdminOverviewData;
}

export interface AdminConfigData {
  configs: AdminCheckConfigRow[];
  templates: CheckRequestTemplateRow[];
}

export interface AdminTelegramPushData {
  config: TelegramPushConfigRecord;
  records: TelegramPushRecord[];
  retryableRecordIds: string[];
  detail: TelegramPushRecord | null;
}

function isTimestampAtOrAfter(value: string | null | undefined, baseline: string | null): boolean {
  if (!value || !baseline) {
    return false;
  }

  const timestamp = Date.parse(value);
  const baselineTimestamp = Date.parse(baseline);
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(baselineTimestamp) &&
    timestamp >= baselineTimestamp
  );
}

function isRecordBeforeCurrentFailure(
  record: TelegramPushRecord,
  state: TelegramAlertStateRecord
): boolean {
  const recordCreatedAt = Date.parse(record.created_at);
  const failureStartedAt = Date.parse(state.failure_started_at ?? state.last_failure_at ?? "");

  return (
    Number.isFinite(recordCreatedAt) &&
    Number.isFinite(failureStartedAt) &&
    recordCreatedAt < failureStartedAt
  );
}

async function loadConfigs(): Promise<AdminCheckConfigRow[]> {
  const storage = await getControlPlaneStorage();
  return storage.checkConfigs.list();
}

async function loadTemplates(): Promise<CheckRequestTemplateRow[]> {
  const storage = await getControlPlaneStorage();
  return storage.requestTemplates.list();
}

async function loadNotifications(): Promise<SystemNotificationRow[]> {
  const storage = await getControlPlaneStorage();
  return storage.notifications.list();
}

function buildOverview(input: {
  configs: AdminCheckConfigRow[];
  templates: CheckRequestTemplateRow[];
  notifications: SystemNotificationRow[];
  telegramPushRecordCount: number;
  lastCheckedAt: string | null;
  latestStatuses: Array<{
    id: string;
    name: string;
    status: string;
    checkedAt: string;
  }>;
}): AdminOverviewData {
  const statusMap = new Map<string, number>();

  for (const item of input.latestStatuses) {
    statusMap.set(item.status, (statusMap.get(item.status) ?? 0) + 1);
  }

  return {
    configCount: input.configs.length,
    enabledConfigCount: input.configs.filter((item) => item.enabled).length,
    maintenanceCount: input.configs.filter((item) => item.is_maintenance).length,
    templateCount: input.templates.length,
    activeNotificationCount: input.notifications.filter((item) => item.is_active).length,
    telegramPushRecordCount: input.telegramPushRecordCount,
    lastCheckedAt: input.lastCheckedAt,
    latestStatuses: input.latestStatuses,
    statusBreakdown: [...statusMap.entries()]
      .map(([status, count]) => ({status, count}))
      .sort((left, right) => right.count - left.count),
  };
}

export async function loadAdminManagementData(): Promise<AdminManagementData> {
  const capabilities = getStorageCapabilities();
  const [configs, templates, notifications] = await Promise.all([
    loadConfigs(),
    loadTemplates(),
    loadNotifications(),
  ]);
  let telegramPushRecordCount = 0;
  let dashboard: Awaited<ReturnType<typeof loadDashboardData>> | null = null;

  try {
    const storage = await getControlPlaneStorage();
    telegramPushRecordCount = (await storage.telegramPushRecords.list({limit: 100})).length;
  } catch (error) {
    logError("load admin telegram push records failed", error);
  }

  if (capabilities.historySnapshots || capabilities.availabilityStats) {
    try {
      dashboard = await loadDashboardData({refreshMode: "never", trendPeriod: "7d"});
    } catch (error) {
      logError("load admin overview dashboard failed", error);
    }
  }

  const latestStatuses = (dashboard?.providerTimelines ?? [])
    .slice()
    .sort(
      (left, right) =>
        new Date(right.latest.checkedAt).getTime() - new Date(left.latest.checkedAt).getTime()
    )
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      name: item.latest.name,
      status: item.latest.status,
      checkedAt: item.latest.checkedAt,
    }));

  return {
    configs,
    templates,
    notifications,
    overview: buildOverview({
      configs,
      templates,
      notifications,
      telegramPushRecordCount,
      lastCheckedAt: dashboard?.lastUpdated ?? null,
      latestStatuses,
    }),
  };
}

export async function loadAdminConfigData(): Promise<AdminConfigData> {
  const [configs, templates] = await Promise.all([loadConfigs(), loadTemplates()]);

  return {
    configs,
    templates,
  };
}

export async function loadAdminTelegramPushData(
  detailId?: string | null
): Promise<AdminTelegramPushData> {
  const storage = await getControlPlaneStorage();
  const [config, records, alertStates, detail] = await Promise.all([
    storage.telegramPushConfig.getSingleton(TELEGRAM_PUSH_SINGLETON_KEY),
    storage.telegramPushRecords.list({limit: 100}),
    storage.telegramAlertStates.list({limit: null}),
    detailId ? storage.telegramPushRecords.getById(detailId) : Promise.resolve(null),
  ]);
  const latestRecordRequests = new Map<string, Promise<TelegramPushRecord | null>>();
  for (const record of records) {
    if (!record.event_type) {
      continue;
    }

    const retryKey =
      record.event_type === "test"
        ? "test"
        : record.notification_key
          ? `${record.notification_key}:${record.event_type}`
          : null;
    if (!retryKey) {
      continue;
    }

    latestRecordRequests.set(
      retryKey,
      storage.telegramPushRecords.findLatestByContext({
        notificationKey: record.notification_key,
        eventType: record.event_type,
      })
    );
  }
  const latestRecords = (await Promise.all(latestRecordRequests.values())).filter(
    (record): record is TelegramPushRecord => Boolean(record)
  );

  const alertStateByKey = new Map<string, TelegramAlertStateRecord>(
    alertStates.map((state) => [state.notification_key, state])
  );
  const retryableRecordIds = latestRecords
    .filter((record) => {
      if (record.status !== "failed") {
        return false;
      }

      if (record.event_type === "test") {
        return true;
      }

      const state = record.notification_key ? alertStateByKey.get(record.notification_key) : null;
      if (!state || state.state !== "failed" || isRecordBeforeCurrentFailure(record, state)) {
        return false;
      }

      if (record.event_type === "failure") {
        return !isTimestampAtOrAfter(state.last_notified_at, state.failure_started_at);
      }

      return (
        record.event_type === "recovery" &&
        isTimestampAtOrAfter(state.last_notified_at, state.failure_started_at) &&
        state.success_count >= 1
      );
    })
    .map((record) => record.id);

  return {
    config: config ?? getDefaultTelegramPushConfigRow(),
    records,
    retryableRecordIds,
    detail,
  };
}
