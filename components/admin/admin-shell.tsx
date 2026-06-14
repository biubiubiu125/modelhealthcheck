"use client";

import type {ReactNode} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {ArrowRight, BellRing, Boxes, HardDrive, LayoutDashboard, Layers3, Settings2} from "lucide-react";

import {logoutAdminAction} from "@/app/admin/actions";
import {getAdminPath} from "@/lib/admin/paths";
import {cn} from "@/lib/utils";

const NAV_ITEMS = [
  {
    suffix: "",
    label: "总览",
    icon: LayoutDashboard,
  },
  {
    suffix: "configs",
    label: "检测配置",
    icon: Boxes,
  },
  {
    suffix: "templates",
    label: "请求模板",
    icon: Layers3,
  },
  {
    suffix: "notifications",
    label: "Telegram 推送",
    icon: BellRing,
  },
  {
    suffix: "storage",
    label: "存储诊断",
    icon: HardDrive,
  },
  {
    suffix: "settings",
    label: "站点设置",
    icon: Settings2,
  },
] as const;

function isActivePath(currentPath: string, href: string, isRoot: boolean): boolean {
  if (isRoot) {
    return currentPath === href;
  }

  return currentPath.startsWith(href);
}

export function AdminShell({
  children,
  username,
  siteName,
  consoleTitle,
  adminBasePath = "/admin",
}: {
  children: ReactNode;
  username?: string;
  siteName: string;
  consoleTitle: string;
  adminBasePath?: string;
}) {
  const pathname = usePathname();
  const loginPath = getAdminPath(adminBasePath, "login");

  if (pathname === loginPath) {
    return <>{children}</>;
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden py-8 md:py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_10%_10%,rgba(14,165,233,0.12),transparent_40%),radial-gradient(circle_at_90%_0%,rgba(236,72,153,0.12),transparent_36%),radial-gradient(circle_at_50%_100%,rgba(16,185,129,0.1),transparent_34%)]"
      />
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-3 sm:px-6 lg:px-12 xl:flex-row xl:items-start">
        <aside className="!static xl:w-[320px] xl:self-start">
          <div className="relative overflow-hidden rounded-[2rem] border border-border/60 bg-background/80 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.08)] backdrop-blur-xl sm:p-6 dark:shadow-black/25">
            <div className="space-y-5">
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold tracking-[-0.05em] text-foreground sm:text-3xl">
                  {consoleTitle}
                </h1>
                <div className="inline-flex items-center rounded-full border border-border/40 bg-background/75 px-3 py-1 text-sm text-muted-foreground shadow-sm">
                  {siteName}
                </div>
              </div>

              <nav className="grid gap-2.5" aria-label="Admin navigation">
                {NAV_ITEMS.map((item) => {
                  const href = getAdminPath(adminBasePath, item.suffix);
                  const active = isActivePath(pathname, href, item.suffix === "");
                  const Icon = item.icon;

                  return (
                    <Link
                      key={item.suffix || "overview"}
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex items-center gap-3 rounded-[1.45rem] border px-4 py-3.5 text-left transition duration-200",
                        active
                          ? "border-cyan-500/20 bg-cyan-500/[0.08] shadow-sm shadow-cyan-500/10"
                          : "border-border/40 bg-background/70 hover:border-cyan-500/25 hover:bg-background"
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border transition",
                          active
                            ? "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200"
                            : "border-border/40 bg-background/80 text-muted-foreground group-hover:text-foreground"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            "text-sm leading-5 tracking-[-0.01em]",
                            active ? "font-semibold text-foreground" : "font-medium text-foreground"
                          )}
                        >
                          {item.label}
                        </div>
                      </div>
                      <ArrowRight
                        className={cn(
                          "h-4 w-4 shrink-0 transition duration-200",
                          active
                            ? "translate-x-0 text-foreground opacity-100"
                            : "text-muted-foreground opacity-0 group-hover:translate-x-0.5 group-hover:opacity-100 group-hover:text-foreground"
                        )}
                      />
                    </Link>
                  );
                })}
              </nav>

              {username ? (
                <div className="rounded-[1.5rem] border border-border/40 bg-gradient-to-br from-background/80 to-background/60 p-4">
                  <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                    当前账号
                  </div>
                  <div className="mt-2 text-sm font-medium text-foreground">{username}</div>
                  <form action={logoutAdminAction} className="mt-4">
                    <input type="hidden" name="returnTo" value={loginPath} />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-full border border-border/40 bg-background/80 px-4 py-2 text-sm text-muted-foreground transition hover:border-cyan-500/30 hover:text-foreground"
                    >
                      退出
                    </button>
                  </form>
                </div>
              ) : null}

              <Link
                href="/"
                className="inline-flex items-center gap-2 rounded-full border border-border/40 bg-background/70 px-4 py-2 text-sm text-muted-foreground transition hover:border-cyan-500/30 hover:text-foreground"
              >
                返回首页
              </Link>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
