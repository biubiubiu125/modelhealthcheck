import type {ReactNode} from "react";
import {notFound, redirect} from "next/navigation";

import AdminOverviewPage from "@/app/admin/page";
import AdminConfigsPage from "@/app/admin/configs/page";
import AdminLoginPage from "@/app/admin/login/page";
import AdminNotificationsPage from "@/app/admin/notifications/page";
import AdminSettingsPage from "@/app/admin/settings/page";
import AdminStoragePage from "@/app/admin/storage/page";
import AdminTemplatesPage from "@/app/admin/templates/page";
import {AdminShell} from "@/components/admin/admin-shell";
import {getAdminSession} from "@/lib/admin/auth";
import {loadSiteSettings} from "@/lib/site-settings";
import {DEFAULT_ADMIN_ENTRY_PATH, normalizeAdminEntryPath} from "@/lib/types/site-settings";

export const dynamic = "force-dynamic";

interface CustomAdminEntryPageProps {
  params: Promise<{
    adminEntry?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function resolveAliasSubPath(requestedPath: string, adminEntryPath: string): string | null {
  if (requestedPath === adminEntryPath) {
    return "";
  }

  const prefix = `${adminEntryPath}/`;
  if (!requestedPath.startsWith(prefix)) {
    return null;
  }

  return requestedPath.slice(prefix.length);
}

async function renderAdminShell(children: ReactNode, adminBasePath: string) {
  const [session, siteSettings] = await Promise.all([getAdminSession(), loadSiteSettings()]);

  return (
    <AdminShell
      username={session?.username}
      siteName={siteSettings.siteName}
      consoleTitle={siteSettings.adminConsoleTitle}
      adminBasePath={adminBasePath}
    >
      {children}
    </AdminShell>
  );
}

export default async function CustomAdminEntryPage({
  params,
  searchParams,
}: CustomAdminEntryPageProps) {
  const {adminEntry = []} = await params;
  const settings = await loadSiteSettings();

  let requestedPath: string;
  let adminEntryPath: string;

  try {
    requestedPath = normalizeAdminEntryPath(`/${adminEntry.join("/")}`);
    adminEntryPath = normalizeAdminEntryPath(settings.adminEntryPath);
  } catch {
    notFound();
  }

  if (adminEntryPath === DEFAULT_ADMIN_ENTRY_PATH) {
    notFound();
  }

  const subPath = resolveAliasSubPath(requestedPath, adminEntryPath);
  if (subPath === null) {
    notFound();
  }

  if (subPath === "supabase") {
    redirect(`${adminEntryPath}/storage`);
  }

  if (subPath === "login") {
    return <AdminLoginPage searchParams={searchParams} adminBasePath={adminEntryPath} />;
  }

  let page: ReactNode;
  switch (subPath) {
    case "":
      page = <AdminOverviewPage adminBasePath={adminEntryPath} />;
      break;
    case "configs":
      page = <AdminConfigsPage searchParams={searchParams} adminBasePath={adminEntryPath} />;
      break;
    case "templates":
      page = <AdminTemplatesPage searchParams={searchParams} adminBasePath={adminEntryPath} />;
      break;
    case "notifications":
      page = <AdminNotificationsPage searchParams={searchParams} adminBasePath={adminEntryPath} />;
      break;
    case "storage":
      page = <AdminStoragePage searchParams={searchParams} adminBasePath={adminEntryPath} />;
      break;
    case "settings":
      page = <AdminSettingsPage searchParams={searchParams} adminBasePath={adminEntryPath} />;
      break;
    default:
      notFound();
  }

  return renderAdminShell(page, adminEntryPath);
}
