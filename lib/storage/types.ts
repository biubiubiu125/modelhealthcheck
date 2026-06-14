import "server-only";

import type {
  AvailabilityStats,
  CheckConfigRow,
  HistorySnapshotRow,
  CheckRequestTemplateRow,
  SiteSettingsRow,
  SystemNotificationRow,
} from "@/lib/types/database";
import type {CheckResult} from "@/lib/types/check";

export type DatabaseProvider = "supabase" | "postgres" | "sqlite";

export interface StorageCapabilities {
  provider: DatabaseProvider;
  adminAuth: boolean;
  siteSettings: boolean;
  controlPlaneCrud: boolean;
  requestTemplates: boolean;
  notifications: boolean;
  historySnapshots: boolean;
  availabilityStats: boolean;
  pollerLease: boolean;
  runtimeMigrations: boolean;
  supabaseDiagnostics: boolean;
  autoProvisionControlPlane: boolean;
}

export interface AdminUserRecord {
  id: string;
  username: string;
  password_hash: string;
  last_login_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface StoredCheckConfigRow extends CheckConfigRow {
  updated_at?: string | null;
}

export interface SiteSettingsMutationInput {
  singleton_key: string;
  site_name: string;
  site_description: string;
  site_icon_url: string;
  hero_badge: string;
  hero_title_primary: string;
  hero_title_secondary: string;
  hero_description: string;
  footer_brand: string;
  admin_console_title: string;
  admin_console_description: string;
  admin_entry_path: string;
  telegram_notification_name: string;
}

export type TelegramAlertState = "healthy" | "failed";

export interface TelegramAlertStateRecord {
  config_id: string;
  model: string;
  notification_key: string;
  state: TelegramAlertState;
  failure_count: number;
  success_count: number;
  last_status: string | null;
  last_message: string | null;
  failure_started_at: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
  last_notified_at: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TelegramAlertStateMutationInput {
  config_id: string;
  model: string;
  notification_key: string;
  state: TelegramAlertState;
  failure_count: number;
  success_count: number;
  last_status?: string | null;
  last_message?: string | null;
  failure_started_at?: string | null;
  last_failure_at?: string | null;
  last_success_at?: string | null;
  last_notified_at?: string | null;
}

export interface TelegramPushConfigRecord {
  singleton_key: string;
  project_name: string;
  bot_token: string | null;
  chat_id: string | null;
  auto_push_enabled: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TelegramPushConfigMutationInput {
  singleton_key: string;
  project_name: string;
  bot_token: string | null;
  chat_id: string | null;
  auto_push_enabled: boolean;
}

export type TelegramPushRecordStatus = "pending" | "sent" | "failed";
export type TelegramPushRecordEventType = "failure" | "recovery" | "test";

export interface TelegramPushRecord {
  id: string;
  project_name: string;
  title: string;
  content: string;
  chat_id: string | null;
  notification_key: string | null;
  event_type: TelegramPushRecordEventType | null;
  status: TelegramPushRecordStatus;
  push_count: number;
  failure_reason: string | null;
  last_pushed_at: string | null;
  created_at: string;
  updated_at?: string | null;
}

export interface TelegramPushRecordMutationInput {
  id?: string | null;
  project_name: string;
  title: string;
  content: string;
  chat_id?: string | null;
  notification_key?: string | null;
  event_type?: TelegramPushRecordEventType | null;
  status?: TelegramPushRecordStatus;
  push_count?: number;
  failure_reason?: string | null;
  last_pushed_at?: string | null;
}

export interface TelegramPushRecordStatusUpdateInput {
  id: string;
  status: TelegramPushRecordStatus;
  push_count: number;
  failure_reason?: string | null;
  last_pushed_at?: string | null;
  chat_id?: string | null;
}

export interface CheckConfigMutationInput {
  id?: string | null;
  name: string;
  type: string;
  model: string;
  endpoint: string;
  api_key: string;
  enabled: boolean;
  is_maintenance: boolean;
  template_id?: string | null;
  request_header?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  group_name?: string | null;
}

export interface RequestTemplateMutationInput {
  id?: string | null;
  name: string;
  type: string;
  request_header?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface NotificationMutationInput {
  id?: string | null;
  message: string;
  level: SystemNotificationRow["level"];
  is_active: boolean;
}

export interface RuntimeHistoryQueryOptions {
  allowedIds?: Iterable<string> | null;
  limitPerConfig?: number | null;
}

export interface RuntimeStorage {
  history: {
    fetchRows(options?: RuntimeHistoryQueryOptions): Promise<HistorySnapshotRow[]>;
    append(results: CheckResult[]): Promise<void>;
    prune(retentionDays: number): Promise<void>;
    replaceForConfigs(input: {
      configIds: Iterable<string>;
      rows: HistorySnapshotRow[];
    }): Promise<void>;
  };
  availability: {
    listStats(configIds?: Iterable<string> | null): Promise<AvailabilityStats[]>;
  };
}

export interface ControlPlaneStorage {
  provider: DatabaseProvider;
  capabilities: StorageCapabilities;
  ensureReady(): Promise<void>;
  runtime: RuntimeStorage;
  adminUsers: {
    hasAny(): Promise<boolean>;
    list(): Promise<AdminUserRecord[]>;
    findByUsername(username: string): Promise<AdminUserRecord | null>;
    create(input: {
      username: string;
      passwordHash: string;
      lastLoginAt?: string | null;
    }): Promise<AdminUserRecord>;
    replaceAll(records: AdminUserRecord[]): Promise<void>;
    updateLastLoginAt(id: string, lastLoginAt: string): Promise<void>;
  };
  siteSettings: {
    getSingleton(singletonKey: string): Promise<SiteSettingsRow | null>;
    upsert(input: SiteSettingsMutationInput): Promise<void>;
  };
  checkConfigs: {
    list(input?: {enabledOnly?: boolean}): Promise<StoredCheckConfigRow[]>;
    getById(id: string): Promise<StoredCheckConfigRow | null>;
    upsert(input: CheckConfigMutationInput): Promise<void>;
    delete(id: string): Promise<void>;
  };
  requestTemplates: {
    list(): Promise<CheckRequestTemplateRow[]>;
    upsert(input: RequestTemplateMutationInput): Promise<void>;
    delete(id: string): Promise<void>;
  };
  notifications: {
    list(): Promise<SystemNotificationRow[]>;
    listActive(): Promise<SystemNotificationRow[]>;
    upsert(input: NotificationMutationInput): Promise<void>;
    delete(id: string): Promise<void>;
  };
  telegramAlertStates: {
    list(input?: {limit?: number | null}): Promise<TelegramAlertStateRecord[]>;
    get(notificationKey: string): Promise<TelegramAlertStateRecord | null>;
    upsert(input: TelegramAlertStateMutationInput): Promise<TelegramAlertStateRecord>;
    delete(notificationKey: string): Promise<void>;
  };
  telegramPushConfig: {
    getSingleton(singletonKey: string): Promise<TelegramPushConfigRecord | null>;
    upsert(input: TelegramPushConfigMutationInput): Promise<TelegramPushConfigRecord>;
  };
  telegramPushRecords: {
    list(input?: {limit?: number | null}): Promise<TelegramPushRecord[]>;
    getById(id: string): Promise<TelegramPushRecord | null>;
    findLatestByContext(input: {
      notificationKey?: string | null;
      eventType: TelegramPushRecordEventType;
    }): Promise<TelegramPushRecord | null>;
    create(input: TelegramPushRecordMutationInput): Promise<TelegramPushRecord>;
    updateStatus(input: TelegramPushRecordStatusUpdateInput): Promise<TelegramPushRecord>;
    delete(id: string): Promise<void>;
  };
}
