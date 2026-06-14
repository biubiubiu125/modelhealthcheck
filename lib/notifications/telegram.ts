import "server-only";

import {
  DEFAULT_TELEGRAM_PUSH_PROJECT_NAME,
  getDefaultTelegramPushConfigRow,
  TELEGRAM_PUSH_SINGLETON_KEY,
} from "@/lib/storage/shared";
import {getControlPlaneStorage} from "@/lib/storage/resolver";
import type {
  ControlPlaneStorage,
  TelegramAlertStateMutationInput,
  TelegramAlertStateRecord,
  TelegramPushConfigRecord,
  TelegramPushRecord,
} from "@/lib/storage/types";
import type {CheckResult, HealthStatus} from "@/lib/types";
import {getErrorMessage} from "@/lib/utils";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_SEND_TIMEOUT_MS = 8_000;
const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 1;
const FAILURE_STATUSES: ReadonlySet<HealthStatus> = new Set([
  "failed",
  "validation_failed",
  "error",
]);

export const TELEGRAM_PUSH_PROJECT_NAME_MAX_LENGTH = 32;
export const DEFAULT_TELEGRAM_PUSH_TEST_MESSAGE = "Telegram 推送测试成功";

interface ResolvedTelegramPushConfig extends TelegramPushConfigRecord {
  configured: boolean;
}

interface TelegramNotificationEvent {
  type: "failure" | "recovery";
  result: CheckResult;
  previousState: TelegramAlertStateRecord | null;
  nextState: TelegramAlertStateMutationInput;
  retryState: TelegramAlertStateMutationInput;
}

interface TelegramStateTransition {
  state: TelegramAlertStateMutationInput;
  event: TelegramNotificationEvent | null;
}

interface TelegramPreparedMessage {
  title: string;
  content: string;
}

interface TelegramPushRecordContext {
  notificationKey?: string | null;
  eventType?: "failure" | "recovery" | "test" | null;
}

export function normalizeTelegramPushProjectName(value: string | null | undefined): string {
  const normalized = value?.trim() || DEFAULT_TELEGRAM_PUSH_PROJECT_NAME;

  if (normalized.includes("[") || normalized.includes("]")) {
    throw new Error("项目显示名称不能包含方括号");
  }

  if (normalized.length > TELEGRAM_PUSH_PROJECT_NAME_MAX_LENGTH) {
    throw new Error(`项目显示名称最多 ${TELEGRAM_PUSH_PROJECT_NAME_MAX_LENGTH} 个字符`);
  }

  return normalized;
}

function normalizeOptionalSecret(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function getNotificationKey(result: CheckResult): string {
  return `${result.id}:${result.model}`;
}

function isFailureResult(result: CheckResult): boolean {
  return FAILURE_STATUSES.has(result.status);
}

function getResultMessage(result: CheckResult): string {
  return (result.logMessage || result.message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function getLatencyText(result: CheckResult): string {
  return typeof result.latencyMs === "number" ? `${result.latencyMs}ms` : "N/A";
}

function getFailureDurationText(startedAt: string | null, recoveredAt: string): string {
  if (!startedAt) {
    return "未知";
  }

  const start = Date.parse(startedAt);
  const end = Date.parse(recoveredAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "未知";
  }

  const totalSeconds = Math.max(1, Math.round((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds} 秒`;
  }

  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
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

function hasNotifiedCurrentFailure(state: TelegramAlertStateRecord | null): boolean {
  if (!state || state.state !== "failed") {
    return false;
  }

  return isTimestampAtOrAfter(state.last_notified_at, state.failure_started_at);
}

function resolveConfig(record: TelegramPushConfigRecord | null): ResolvedTelegramPushConfig {
  const defaults = getDefaultTelegramPushConfigRow();
  const config = record ?? defaults;
  const botToken = normalizeOptionalSecret(config.bot_token);
  const chatId = normalizeOptionalSecret(config.chat_id);

  return {
    ...defaults,
    ...config,
    project_name: normalizeTelegramPushProjectName(config.project_name),
    bot_token: botToken,
    chat_id: chatId,
    auto_push_enabled: config.auto_push_enabled,
    configured: Boolean(botToken && chatId),
  };
}

export async function loadTelegramPushConfig(): Promise<ResolvedTelegramPushConfig> {
  const storage = await getControlPlaneStorage();
  return resolveConfig(await storage.telegramPushConfig.getSingleton(TELEGRAM_PUSH_SINGLETON_KEY));
}

export async function saveTelegramPushConfig(input: {
  projectName: string;
  botToken: string | null;
  chatId: string | null;
  autoPushEnabled: boolean;
}): Promise<TelegramPushConfigRecord> {
  const storage = await getControlPlaneStorage();
  return storage.telegramPushConfig.upsert({
    singleton_key: TELEGRAM_PUSH_SINGLETON_KEY,
    project_name: normalizeTelegramPushProjectName(input.projectName),
    bot_token: normalizeOptionalSecret(input.botToken),
    chat_id: normalizeOptionalSecret(input.chatId),
    auto_push_enabled: input.autoPushEnabled,
  });
}

async function sendTelegramMessage(input: {
  botToken: string;
  chatId: string;
  text: string;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);

  try {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${input.botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Telegram 推送失败：${response.status} ${detail}`.trim());
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function sendRecordWithConfig(
  storage: ControlPlaneStorage,
  record: TelegramPushRecord,
  config: ResolvedTelegramPushConfig
): Promise<TelegramPushRecord> {
  const botToken = config.bot_token;
  const chatId = config.chat_id;
  const nextPushCount = record.push_count + 1;

  if (!botToken || !chatId) {
    return storage.telegramPushRecords.updateStatus({
      id: record.id,
      status: "failed",
      push_count: nextPushCount,
      failure_reason: "Telegram 推送未配置 Bot Token 或 Chat ID",
      chat_id: chatId ?? record.chat_id,
    });
  }

  try {
    await sendTelegramMessage({
      botToken,
      chatId,
      text: record.content,
    });

    return storage.telegramPushRecords.updateStatus({
      id: record.id,
      status: "sent",
      push_count: nextPushCount,
      failure_reason: null,
      last_pushed_at: new Date().toISOString(),
      chat_id: chatId,
    });
  } catch (error) {
    return storage.telegramPushRecords.updateStatus({
      id: record.id,
      status: "failed",
      push_count: nextPushCount,
      failure_reason: getErrorMessage(error),
      chat_id: chatId,
    });
  }
}

async function createAndSendTelegramPushRecord(input: {
  storage: ControlPlaneStorage;
  config: ResolvedTelegramPushConfig;
  title: string;
  content: string;
  context?: TelegramPushRecordContext;
}): Promise<TelegramPushRecord> {
  const record = await input.storage.telegramPushRecords.create({
    project_name: input.config.project_name,
    title: input.title,
    content: input.content,
    chat_id: input.config.chat_id,
    notification_key: input.context?.notificationKey ?? null,
    event_type: input.context?.eventType ?? null,
    status: "pending",
    push_count: 0,
  });

  return sendRecordWithConfig(input.storage, record, input.config);
}

async function syncAlertStateAfterRetry(
  storage: ControlPlaneStorage,
  record: TelegramPushRecord
): Promise<void> {
  if (record.status !== "sent" || !record.notification_key || !record.event_type) {
    return;
  }

  if (record.event_type !== "failure" && record.event_type !== "recovery") {
    return;
  }

  const state = await storage.telegramAlertStates.get(record.notification_key);
  if (!state) {
    return;
  }

  if (state.state !== "failed") {
    return;
  }

  const recordCreatedAt = Date.parse(record.created_at);
  const failureStartedAt = Date.parse(state.failure_started_at ?? state.last_failure_at ?? "");
  if (Number.isFinite(recordCreatedAt) && Number.isFinite(failureStartedAt)) {
    if (recordCreatedAt < failureStartedAt) {
      return;
    }
  }

  const now = record.last_pushed_at ?? new Date().toISOString();
  if (record.event_type === "failure") {
    await storage.telegramAlertStates.upsert({
      config_id: state.config_id,
      model: state.model,
      notification_key: state.notification_key,
      state: "failed",
      failure_count: state.failure_count,
      success_count: 0,
      last_status: state.last_status,
      last_message: state.last_message,
      failure_started_at: state.failure_started_at,
      last_failure_at: state.last_failure_at,
      last_success_at: state.last_success_at,
      last_notified_at: now,
    });
    return;
  }

  await storage.telegramAlertStates.upsert({
    config_id: state.config_id,
    model: state.model,
    notification_key: state.notification_key,
    state: "healthy",
    failure_count: 0,
    success_count: 0,
    last_status: state.last_status,
    last_message: state.last_message,
    failure_started_at: null,
    last_failure_at: state.last_failure_at,
    last_success_at: state.last_success_at ?? now,
    last_notified_at: now,
  });
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

async function assertRetryableTelegramPushRecord(
  storage: ControlPlaneStorage,
  record: TelegramPushRecord
): Promise<void> {
  if (record.status !== "failed") {
    throw new Error("只能重试当前发送失败的 Telegram 推送记录");
  }

  if (!record.notification_key || !record.event_type) {
    if (record.event_type !== "test") {
      throw new Error("旧推送记录缺少状态关联，不能重试");
    }
  }

  if (record.event_type !== "failure" && record.event_type !== "recovery") {
    if (record.event_type !== "test") {
      throw new Error("不支持重试该类型的 Telegram 推送记录");
    }
  }

  const latestRelatedRecord = await storage.telegramPushRecords.findLatestByContext({
    notificationKey: record.notification_key,
    eventType: record.event_type,
  });
  const recordCreatedAt = Date.parse(record.created_at);
  if (!Number.isFinite(recordCreatedAt)) {
    throw new Error("推送记录时间异常，不能重试");
  }

  const newerRelatedRecord = latestRelatedRecord && latestRelatedRecord.id !== record.id;

  if (newerRelatedRecord) {
    throw new Error("只能重试该模型当前最新的一条失败推送记录");
  }

  if (record.event_type === "test") {
    return;
  }

  const notificationKey = record.notification_key;
  if (!notificationKey) {
    throw new Error("旧推送记录缺少状态关联，不能重试");
  }

  const state = await storage.telegramAlertStates.get(notificationKey);
  if (!state || state.state !== "failed" || isRecordBeforeCurrentFailure(record, state)) {
    throw new Error("只能重试当前故障周期内的 Telegram 推送记录");
  }

  if (record.event_type === "failure" && hasNotifiedCurrentFailure(state)) {
    throw new Error("当前故障已经成功推送过，不能重试历史失败记录");
  }

  if (record.event_type === "recovery") {
    if (!hasNotifiedCurrentFailure(state) || state.success_count < RECOVERY_THRESHOLD) {
      throw new Error("当前恢复条件不成立，不能重试恢复推送记录");
    }
  }
}

export async function retryTelegramPushRecord(recordId: string): Promise<TelegramPushRecord> {
  const storage = await getControlPlaneStorage();
  const [configRecord, record] = await Promise.all([
    storage.telegramPushConfig.getSingleton(TELEGRAM_PUSH_SINGLETON_KEY),
    storage.telegramPushRecords.getById(recordId),
  ]);

  if (!record) {
    throw new Error("推送记录不存在或已被删除");
  }

  await assertRetryableTelegramPushRecord(storage, record);
  const sentRecord = await sendRecordWithConfig(storage, record, resolveConfig(configRecord));
  await syncAlertStateAfterRetry(storage, sentRecord);
  return sentRecord;
}

export async function sendTelegramPushTestMessage(text: string): Promise<TelegramPushRecord> {
  const storage = await getControlPlaneStorage();
  const config = resolveConfig(
    await storage.telegramPushConfig.getSingleton(TELEGRAM_PUSH_SINGLETON_KEY)
  );
  const message = text.trim() || DEFAULT_TELEGRAM_PUSH_TEST_MESSAGE;
  const content = [
    `[${config.project_name}][测试]`,
    message,
    "",
    `时间：${new Date().toISOString()}`,
  ].join("\n");

  const sentRecord = await createAndSendTelegramPushRecord({
    storage,
    config,
    title: "测试推送",
    content,
    context: {
      eventType: "test",
    },
  });

  if (sentRecord.status !== "sent") {
    throw new Error(sentRecord.failure_reason || "Telegram 推送测试失败");
  }

  return sentRecord;
}

function buildFailureMessage(prefixName: string, event: TelegramNotificationEvent): TelegramPreparedMessage {
  const {result, nextState} = event;
  const reason = getResultMessage(result) || "连续检测失败";
  const title = `${result.model} 暂不可调用`;

  return {
    title,
    content: [
      `[${prefixName}][故障]`,
      title,
      "",
      `服务：${result.name}`,
      `模型：${result.model}`,
      `状态：${result.status}`,
      `延迟：${getLatencyText(result)}`,
      `时间：${nextState.last_failure_at ?? result.checkedAt}`,
      `原因：连续 ${nextState.failure_count} 次检测失败`,
      `详情：${reason}`,
    ].join("\n"),
  };
}

function buildRecoveryMessage(prefixName: string, event: TelegramNotificationEvent): TelegramPreparedMessage {
  const {result, previousState, nextState} = event;
  const title = `${result.model} 已恢复正常调用`;

  return {
    title,
    content: [
      `[${prefixName}][恢复]`,
      title,
      "",
      `服务：${result.name}`,
      `模型：${result.model}`,
      `恢复时间：${nextState.last_success_at ?? result.checkedAt}`,
      `故障持续：${getFailureDurationText(previousState?.failure_started_at ?? null, result.checkedAt)}`,
    ].join("\n"),
  };
}

function buildNextState(
  result: CheckResult,
  previousState: TelegramAlertStateRecord | null
): TelegramStateTransition {
  const now = result.checkedAt || new Date().toISOString();
  const notificationKey = getNotificationKey(result);

  if (isFailureResult(result)) {
    const nextFailureCount = (previousState?.failure_count ?? 0) + 1;
    const failureStartedAt =
      previousState?.state === "failed"
        ? previousState.failure_started_at ?? now
        : previousState?.failure_started_at ?? now;
    const failureAlreadyNotified = hasNotifiedCurrentFailure(previousState);
    const shouldNotify = !failureAlreadyNotified && nextFailureCount >= FAILURE_THRESHOLD;
    const state: TelegramAlertStateMutationInput = {
      config_id: result.id,
      model: result.model,
      notification_key: notificationKey,
      state: shouldNotify || previousState?.state === "failed" ? "failed" : "healthy",
      failure_count: nextFailureCount,
      success_count: 0,
      last_status: result.status,
      last_message: getResultMessage(result),
      failure_started_at: failureStartedAt,
      last_failure_at: now,
      last_success_at: previousState?.last_success_at ?? null,
      last_notified_at: previousState?.last_notified_at ?? null,
    };

    return {
      state,
      event: shouldNotify
        ? {
            type: "failure",
            result,
            previousState,
            retryState: state,
            nextState: {
              ...state,
              last_notified_at: now,
            },
          }
        : null,
    };
  }

  if (previousState?.state === "failed") {
    const nextSuccessCount = previousState.success_count + 1;
    const shouldNotify =
      hasNotifiedCurrentFailure(previousState) && nextSuccessCount >= RECOVERY_THRESHOLD;
    const recoveredState: TelegramAlertStateMutationInput = {
      config_id: result.id,
      model: result.model,
      notification_key: notificationKey,
      state: "healthy",
      failure_count: 0,
      success_count: 0,
      last_status: result.status,
      last_message: getResultMessage(result),
      failure_started_at: null,
      last_failure_at: previousState.last_failure_at,
      last_success_at: now,
      last_notified_at: shouldNotify ? now : previousState.last_notified_at,
    };
    const retryState: TelegramAlertStateMutationInput = {
      config_id: result.id,
      model: result.model,
      notification_key: notificationKey,
      state: "failed",
      failure_count: previousState.failure_count,
      success_count: nextSuccessCount,
      last_status: result.status,
      last_message: getResultMessage(result),
      failure_started_at: previousState.failure_started_at,
      last_failure_at: previousState.last_failure_at,
      last_success_at: now,
      last_notified_at: previousState.last_notified_at,
    };

    const notifiedCurrentFailure = hasNotifiedCurrentFailure(previousState);
    return {
      state: shouldNotify ? recoveredState : notifiedCurrentFailure ? retryState : recoveredState,
      event: shouldNotify
        ? {
            type: "recovery",
            result,
            previousState,
            retryState,
            nextState: recoveredState,
          }
        : null,
    };
  }

  return {
    state: {
      config_id: result.id,
      model: result.model,
      notification_key: notificationKey,
      state: "healthy",
      failure_count: 0,
      success_count: 0,
      last_status: result.status,
      last_message: getResultMessage(result),
      failure_started_at: null,
      last_failure_at: previousState?.last_failure_at ?? null,
      last_success_at: now,
      last_notified_at: previousState?.last_notified_at ?? null,
    },
    event: null,
  };
}

function getSuppressedNotificationState(
  event: TelegramNotificationEvent
): TelegramAlertStateMutationInput {
  if (event.type === "failure") {
    return event.retryState;
  }

  return {
    ...event.nextState,
    last_notified_at: event.retryState.last_notified_at,
  };
}

export async function notifyTelegramForCheckResults(results: CheckResult[]): Promise<void> {
  try {
    await processTelegramForCheckResults(results);
  } catch (error) {
    console.error("[modelhealthcheck] Telegram 推送处理失败", getErrorMessage(error));
  }
}

async function processTelegramForCheckResults(results: CheckResult[]): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const storage = await getControlPlaneStorage();
  const config = resolveConfig(
    await storage.telegramPushConfig.getSingleton(TELEGRAM_PUSH_SINGLETON_KEY)
  );

  for (const result of results) {
    try {
      const previousState = await storage.telegramAlertStates.get(getNotificationKey(result));
      const transition = buildNextState(result, previousState);

      if (!transition.event) {
        await storage.telegramAlertStates.upsert(transition.state);
        continue;
      }

      if (!config.auto_push_enabled || !config.configured) {
        await storage.telegramAlertStates.upsert(getSuppressedNotificationState(transition.event));
        continue;
      }

      await processTelegramNotificationEvent(storage, config, transition.event);
    } catch (error) {
      console.error(
        `[modelhealthcheck] Telegram 推送处理单项失败：${result.name}/${result.model}`,
        getErrorMessage(error)
      );
    }
  }
}

async function processTelegramNotificationEvent(
  storage: ControlPlaneStorage,
  config: ResolvedTelegramPushConfig,
  event: TelegramNotificationEvent
): Promise<void> {
  const prepared =
    event.type === "failure"
      ? buildFailureMessage(config.project_name, event)
      : buildRecoveryMessage(config.project_name, event);

  const record = await createAndSendTelegramPushRecord({
    storage,
    config,
    title: prepared.title,
    content: prepared.content,
    context: {
      notificationKey: event.nextState.notification_key,
      eventType: event.type,
    },
  });

  if (record.status !== "sent") {
    console.error(
      "[modelhealthcheck] Telegram 推送发送失败",
      record.failure_reason ?? "unknown error"
    );
    try {
      await storage.telegramAlertStates.upsert(event.retryState);
    } catch (stateError) {
      console.error("[modelhealthcheck] Telegram 推送重试状态保存失败", getErrorMessage(stateError));
    }
    return;
  }

  try {
    await storage.telegramAlertStates.upsert(event.nextState);
  } catch (error) {
    console.error("[modelhealthcheck] Telegram 推送已发送但状态保存失败", getErrorMessage(error));
  }
}
