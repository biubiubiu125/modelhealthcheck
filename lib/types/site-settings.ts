export const SITE_SETTINGS_SINGLETON_KEY = "global";
export const DEFAULT_ADMIN_ENTRY_PATH = "/admin";

export interface SiteSettings {
  siteName: string;
  siteDescription: string;
  siteIconUrl: string;
  heroBadge: string;
  heroTitlePrimary: string;
  heroTitleSecondary: string;
  heroDescription: string;
  footerBrand: string;
  adminConsoleTitle: string;
  adminConsoleDescription: string;
  adminEntryPath: string;
  telegramNotificationName: string;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: "RKAPI模型状态检测",
  siteDescription: "实时检测 AI 模型接口的可用性与延迟",
  siteIconUrl: "/favicon.png",
  heroBadge: "",
  heroTitlePrimary: "",
  heroTitleSecondary: "",
  heroDescription: "",
  footerBrand: "RKAPI模型状态检测",
  adminConsoleTitle: "站点管理后台",
  adminConsoleDescription:
    "针对当前监控站点的数据源、公告和全局站点设置进行统一维护。",
  adminEntryPath: DEFAULT_ADMIN_ENTRY_PATH,
  telegramNotificationName: "RKAPI模型监控",
};

export function normalizeTelegramNotificationName(
  value: string | null | undefined,
  fallback: string = DEFAULT_SITE_SETTINGS.siteName
): string {
  const normalizedFallback = fallback.trim() || DEFAULT_SITE_SETTINGS.siteName;
  const normalized = value?.trim() || normalizedFallback;

  if (normalized.includes("[") || normalized.includes("]")) {
    throw new Error("Telegram 通知显示名称不能包含方括号");
  }

  if (normalized.length < 2 || normalized.length > 24) {
    throw new Error("Telegram 通知显示名称长度需为 2-24 个字符");
  }

  return normalized;
}

export function normalizeAdminEntryPath(value: string | null | undefined): string {
  const raw = value?.trim() || DEFAULT_ADMIN_ENTRY_PATH;
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;

  if (/[\s?#]/.test(raw) || raw.includes("\\")) {
    throw new Error("后台入口路径只能填写路径本身，不能包含空格、查询参数或反斜杠");
  }

  let pathname: string;
  try {
    pathname = new URL(withLeadingSlash, "https://modelhealthcheck.local").pathname;
  } catch {
    throw new Error("后台入口路径格式不正确");
  }

  const normalized = pathname === "/" ? pathname : pathname.replace(/\/+$/, "");

  if (normalized === "/") {
    throw new Error("后台入口路径不能是站点根路径");
  }

  if (normalized.includes("//")) {
    throw new Error("后台入口路径不能包含连续斜杠");
  }

  const reservedPrefixes = ["/api", "/_next", "/group"];
  if (reservedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    throw new Error("后台入口路径不能占用系统保留路径");
  }

  if (normalized.startsWith(`${DEFAULT_ADMIN_ENTRY_PATH}/`)) {
    throw new Error("后台入口路径不能使用 /admin 的子路径");
  }

  return normalized;
}
