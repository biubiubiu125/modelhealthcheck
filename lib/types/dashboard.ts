/**
 * Dashboard 数据相关类型定义
 */

import type {CheckResult} from "./check";

export type AvailabilityPeriod = "7d" | "15d" | "30d";

export interface AvailabilityStat {
  period: AvailabilityPeriod;
  totalChecks: number;
  operationalCount: number;
  availabilityPct: number | null;
}

export type AvailabilityStatsMap = Record<string, AvailabilityStat[]>;

/**
 * 时间线项目（保持原始 ISO 时间，交给客户端格式化）
 */
export type TimelineItem = CheckResult;

/**
 * Provider 的时间线数据
 */
export interface ProviderTimeline {
  id: string;
  items: TimelineItem[];
  latest: TimelineItem;
}

/**
 * Dashboard 完整数据
 */
export interface DashboardData {
  providerTimelines: ProviderTimeline[];
  lastUpdated: string | null;
  total: number;
  pollIntervalLabel: string;
  pollIntervalMs: number;
  availabilityStats?: AvailabilityStatsMap;
  trendPeriod: AvailabilityPeriod;
  /**
   * 服务端生成该数据的时间戳（ms）
   * 用于保持倒计时在服务端与客户端渲染时一致
   */
  generatedAt: number;
}

/**
 * 刷新模式
 */
export type RefreshMode = "always" | "missing" | "never";

/**
 * Ping 缓存条目
 */
export interface PingCacheEntry {
  lastPingAt: number;
  inflight?: Promise<HistorySnapshot>;
  history?: HistorySnapshot;
}

/**
 * 历史记录快照类型
 * 动态推断自 loadHistory 的返回值
 */
export type HistorySnapshot = Record<string, CheckResult[]>;
