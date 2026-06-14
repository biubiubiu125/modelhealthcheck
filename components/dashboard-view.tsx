"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {Activity, RefreshCcw, Search, X} from "lucide-react";

import {ClientTime} from "@/components/client-time";
import {ProviderCard} from "@/components/provider-card";
import {ThemeToggle} from "@/components/theme-toggle";
import {fetchWithCache, prefetchDashboardData, setCache} from "@/lib/core/frontend-cache";
import type {
  AvailabilityPeriod,
  AvailabilityStatsMap,
  DashboardData,
  ProviderTimeline,
} from "@/lib/types";
import type {SiteSettings} from "@/lib/types/site-settings";
import {cn} from "@/lib/utils";

interface DashboardViewProps {
  initialData: DashboardData;
  siteSettings: SiteSettings;
  canForceRefresh: boolean;
}

const PERIOD_OPTIONS: Array<{value: AvailabilityPeriod; label: string}> = [
  {value: "7d", label: "7 天"},
  {value: "15d", label: "15 天"},
  {value: "30d", label: "30 天"},
];

const AUTO_SYNC_RETRY_MS = 5_000;

function getLatestCheckTimestamp(timelines: DashboardData["providerTimelines"]) {
  const timestamps = timelines.map((timeline) => new Date(timeline.latest.checkedAt).getTime());
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function computeRemainingMs(
  pollIntervalMs: number | null | undefined,
  latestCheckTimestamp: number | null,
  clock: number = Date.now()
) {
  if (!pollIntervalMs || pollIntervalMs <= 0 || latestCheckTimestamp === null) {
    return null;
  }

  return Math.max(0, pollIntervalMs - (clock - latestCheckTimestamp));
}

function matchesQuery(timeline: ProviderTimeline, query: string): boolean {
  if (!query) {
    return true;
  }

  const latest = timeline.latest;
  return [latest.name, latest.model, latest.type, latest.endpoint]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(query));
}

const CornerPlus = ({className}: {className?: string}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    className={cn("absolute h-4 w-4 text-muted-foreground/40", className)}
  >
    <line x1="12" y1="0" x2="12" y2="24" />
    <line x1="0" y1="12" x2="24" y2="12" />
  </svg>
);

export function DashboardView({
  initialData,
  siteSettings,
  canForceRefresh,
}: DashboardViewProps) {
  const [data, setData] = useState(initialData);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const refreshLockRef = useRef(false);
  const autoSyncRetryAtRef = useRef(0);
  const [nextRefreshAnchor, setNextRefreshAnchor] = useState<number | null>(() =>
    getLatestCheckTimestamp(initialData.providerTimelines)
  );
  const [timeToNextRefresh, setTimeToNextRefresh] = useState<number | null>(() =>
    computeRemainingMs(
      initialData.pollIntervalMs,
      getLatestCheckTimestamp(initialData.providerTimelines),
      initialData.generatedAt
    )
  );
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  const [activeOfficialCardId, setActiveOfficialCardId] = useState<string | null>(null);

  const {providerTimelines, total, lastUpdated, pollIntervalLabel} = data;
  const availabilityStats: AvailabilityStatsMap = data.availabilityStats ?? {};
  const [selectedPeriod, setSelectedPeriod] = useState<AvailabilityPeriod>(
    data.trendPeriod ?? "7d"
  );

  const refresh = useCallback(
    async (period?: AvailabilityPeriod, forceFresh?: boolean, revalidateIfFresh?: boolean) => {
      if (refreshLockRef.current) {
        return;
      }

      refreshLockRef.current = true;
      setIsRefreshing(true);
      try {
        const targetPeriod = period ?? selectedPeriod;
        const result = await fetchWithCache({
          trendPeriod: targetPeriod,
          forceFresh,
          revalidateIfFresh,
          onBackgroundUpdate: (newData) => {
            autoSyncRetryAtRef.current = 0;
            setNextRefreshAnchor(getLatestCheckTimestamp(newData.providerTimelines));
            setData(newData);
          },
        });
        autoSyncRetryAtRef.current = 0;
        setNextRefreshAnchor(getLatestCheckTimestamp(result.data.providerTimelines));
        setData(result.data);
      } catch (error) {
        console.error("[check-cx] 刷新失败", error);
      } finally {
        setIsRefreshing(false);
        refreshLockRef.current = false;
      }
    },
    [selectedPeriod]
  );

  useEffect(() => {
    setData(initialData);
    autoSyncRetryAtRef.current = 0;
    setNextRefreshAnchor(getLatestCheckTimestamp(initialData.providerTimelines));
    if (initialData.trendPeriod) {
      setCache(initialData.trendPeriod, initialData);
    }
  }, [initialData]);

  useEffect(() => {
    const currentPeriod = data.trendPeriod ?? "7d";
    prefetchDashboardData(["7d", "15d", "30d"], currentPeriod).catch(() => undefined);
  }, [data.trendPeriod]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia("(pointer: coarse)");
    const updatePointerType = () => {
      const hasTouch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
      setIsCoarsePointer(media.matches || hasTouch);
    };

    updatePointerType();
    media.addEventListener("change", updatePointerType);
    return () => media.removeEventListener("change", updatePointerType);
  }, []);

  useEffect(() => {
    if (!isCoarsePointer) {
      setActiveOfficialCardId(null);
    }
  }, [isCoarsePointer]);

  useEffect(() => {
    if (selectedPeriod === data.trendPeriod) {
      return;
    }

    refresh(selectedPeriod).catch(() => undefined);
  }, [data.trendPeriod, refresh, selectedPeriod]);

  useEffect(() => {
    if (!data.pollIntervalMs || data.pollIntervalMs <= 0 || nextRefreshAnchor === null) {
      setTimeToNextRefresh(null);
      return;
    }

    const updateCountdown = () => {
      const now = Date.now();
      const remaining = computeRemainingMs(data.pollIntervalMs, nextRefreshAnchor, now);

      if (remaining === null) {
        setTimeToNextRefresh(null);
        return;
      }

      if (remaining > 0) {
        setTimeToNextRefresh(remaining);
        return;
      }

      if (autoSyncRetryAtRef.current > now) {
        setTimeToNextRefresh(autoSyncRetryAtRef.current - now);
        return;
      }

      autoSyncRetryAtRef.current = now + AUTO_SYNC_RETRY_MS;
      setTimeToNextRefresh(AUTO_SYNC_RETRY_MS);

      if (!refreshLockRef.current) {
        refresh(undefined, false, true).catch(() => undefined);
      }
    };

    updateCountdown();
    const countdownTimer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(countdownTimer);
  }, [data.pollIntervalMs, nextRefreshAnchor, refresh]);

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredTimelines = useMemo(
    () => providerTimelines.filter((timeline) => matchesQuery(timeline, normalizedSearchQuery)),
    [normalizedSearchQuery, providerTimelines]
  );

  const gridColsClass = useMemo(() => {
    if (filteredTimelines.length > 4) {
      return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
    }

    return "grid-cols-1 md:grid-cols-2";
  }, [filteredTimelines.length]);

  return (
    <div className="relative isolate">
      <div className="pointer-events-none fixed inset-x-0 -top-40 -z-10 transform-gpu overflow-hidden blur-3xl sm:-top-80">
        <div className="relative left-[calc(50%-11rem)] aspect-[1155/678] w-[36.125rem] -translate-x-1/2 rotate-[30deg] bg-gradient-to-tr from-primary/30 to-primary/10 opacity-20 sm:left-[calc(50%-30rem)] sm:w-[72.1875rem]" />
      </div>
      <div className="pointer-events-none fixed inset-x-0 top-[calc(100%-13rem)] -z-10 transform-gpu overflow-hidden blur-3xl sm:top-[calc(100%-30rem)]">
        <div className="relative left-[calc(50%+3rem)] aspect-[1155/678] w-[36.125rem] -translate-x-1/2 bg-gradient-to-tr from-primary/20 to-primary/5 opacity-20 sm:left-[calc(50%+36rem)] sm:w-[72.1875rem]" />
      </div>

      <CornerPlus className="fixed left-4 top-4 h-6 w-6 text-border md:left-8 md:top-8" />
      <CornerPlus className="fixed right-4 top-4 h-6 w-6 text-border md:right-8 md:top-8" />
      <CornerPlus className="fixed bottom-4 left-4 h-6 w-6 text-border md:bottom-8 md:left-8" />
      <CornerPlus className="fixed bottom-4 right-4 h-6 w-6 text-border md:bottom-8 md:right-8" />

      <header className="relative z-10 mb-8 flex flex-col gap-5 sm:mb-12">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-3 sm:gap-4">
            <div
              aria-label="站点图标"
              role="img"
              className="h-12 w-12 rounded-xl border border-border/50 bg-background bg-cover bg-center shadow-sm sm:h-14 sm:w-14"
              style={{backgroundImage: `url(${siteSettings.siteIconUrl})`}}
            />
            <h1 className="min-w-0 text-3xl font-black leading-none text-foreground sm:text-5xl">
              {siteSettings.siteName}
            </h1>
            <ThemeToggle />
          </div>

          <div className="flex w-full items-center gap-2 rounded-full border border-border/60 bg-background/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur-sm sm:w-auto">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
            </span>
            <span className="pl-0.5">可用性区间</span>
            <div className="flex items-center gap-1 rounded-full bg-muted/30 p-0.5">
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSelectedPeriod(option.value)}
                  className={cn(
                    "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                    selectedPeriod === option.value
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <input
              type="text"
              placeholder="搜索模型或端点..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="h-10 w-full rounded-full border border-border/60 bg-background/50 pl-10 pr-10 text-sm backdrop-blur-sm transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="清除搜索"
                className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          {lastUpdated ? (
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <RefreshCcw className={cn("h-3 w-3", isRefreshing && "animate-spin")} />
                <span>
                  更新于 <ClientTime value={lastUpdated} />
                </span>
              </div>
              <span className="opacity-30">|</span>
              <span>{pollIntervalLabel} 轮询</span>
              {canForceRefresh ? (
                <button
                  type="button"
                  onClick={() => refresh(selectedPeriod, true)}
                  disabled={isRefreshing}
                  className={cn(
                    "rounded-full border border-border/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:border-border/80 hover:text-foreground",
                    isRefreshing && "cursor-not-allowed opacity-60"
                  )}
                >
                  刷新
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <main className="relative z-10 min-h-[50vh]">
        {total === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border/50 bg-muted/20 py-20 text-center">
            <div className="mb-4 rounded-full bg-muted/50 p-4">
              <Activity className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">尚无监控目标</h3>
            <p className="text-muted-foreground">请配置检查端点以开始监控</p>
          </div>
        ) : filteredTimelines.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border/50 bg-muted/20 py-20 text-center">
            <div className="mb-4 rounded-full bg-muted/50 p-4">
              <Search className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">没有找到匹配的监控项</h3>
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="mt-4 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
            >
              清除搜索
            </button>
          </div>
        ) : (
          <div className={`grid gap-6 ${gridColsClass}`}>
            {filteredTimelines.map((timeline) => (
              <ProviderCard
                key={timeline.id}
                timeline={timeline}
                timeToNextRefresh={timeToNextRefresh}
                isCoarsePointer={isCoarsePointer}
                activeOfficialCardId={activeOfficialCardId}
                setActiveOfficialCardId={setActiveOfficialCardId}
                availabilityStats={availabilityStats[timeline.id]}
                selectedPeriod={selectedPeriod}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
