import {runSupabaseAutoFixAction, runSupabaseAutoMigrateAction} from "@/app/admin/actions";
import {ManagedStoragePanel} from "@/components/admin/managed-storage-panel";
import {StorageDiagnosticsClient} from "@/components/admin/storage-diagnostics-client";
import {AdminPageIntro, AdminStatusBanner} from "@/components/admin/admin-primitives";
import {requireAdminSession} from "@/lib/admin/auth";
import {getAdminPath} from "@/lib/admin/paths";
import {getStorageDiagnosticsSnapshot} from "@/lib/admin/storage-diagnostics-cache";
import {getAdminFeedback} from "@/lib/admin/view";

export const dynamic = "force-dynamic";

interface AdminStoragePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  adminBasePath?: string;
}

export default async function AdminStoragePage({
  searchParams,
  adminBasePath = "/admin",
}: AdminStoragePageProps) {
  const storagePath = getAdminPath(adminBasePath, "storage");

  await requireAdminSession(getAdminPath(adminBasePath, "login"));
  const params = await searchParams;
  const feedback = getAdminFeedback(params);
  const initialSnapshot = getStorageDiagnosticsSnapshot({
    force: Boolean(feedback),
    triggerRefresh: true,
  });

  return (
    <div className="space-y-6">
      <AdminPageIntro
        title="存储"
        description="查看后端状态，处理连接、导入和切换。"
      />

      {feedback ? <AdminStatusBanner type={feedback.type} message={feedback.message} /> : null}

      <ManagedStoragePanel adminBasePath={adminBasePath} />

      <StorageDiagnosticsClient
        initialSnapshot={initialSnapshot}
        refreshAfterMount={Boolean(feedback)}
        runAutoFixAction={runSupabaseAutoFixAction.bind(null, storagePath)}
        runAutoMigrateAction={runSupabaseAutoMigrateAction.bind(null, storagePath)}
        dataEndpoint="/api/internal/storage-diagnostics"
      />
    </div>
  );
}
