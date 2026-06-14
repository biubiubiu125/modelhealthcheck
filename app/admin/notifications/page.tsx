import Link from "next/link";

import {Button} from "@/components/ui/button";
import {
  AdminCheckbox,
  AdminField,
  AdminInput,
  AdminPageIntro,
  AdminPanel,
  AdminStatusBanner,
  AdminTextarea,
} from "@/components/admin/admin-primitives";
import {
  retryTelegramPushRecordAction,
  saveTelegramPushConfigAction,
  sendTelegramPushTestAction,
} from "@/app/admin/actions";
import {requireAdminSession} from "@/lib/admin/auth";
import {loadAdminTelegramPushData} from "@/lib/admin/data";
import {getAdminPath} from "@/lib/admin/paths";
import {formatAdminTimestamp, getAdminFeedback, getStatusToneClass} from "@/lib/admin/view";
import {
  DEFAULT_TELEGRAM_PUSH_TEST_MESSAGE,
  TELEGRAM_PUSH_PROJECT_NAME_MAX_LENGTH,
} from "@/lib/notifications/telegram";
import {cn} from "@/lib/utils";

export const dynamic = "force-dynamic";

interface AdminNotificationsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  adminBasePath?: string;
}

function getSearchParamValue(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | null {
  const value = params[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function getRecordStatusLabel(status: string): string {
  if (status === "sent") {
    return "已发送";
  }
  if (status === "failed") {
    return "失败";
  }
  return "待发送";
}

function getRecordStatusTone(status: string): string {
  if (status === "sent") {
    return getStatusToneClass("operational");
  }
  if (status === "failed") {
    return getStatusToneClass("failed");
  }
  return getStatusToneClass("pending");
}

function truncateFailureReason(reason: string | null): string {
  if (!reason) {
    return "—";
  }

  return reason.length > 80 ? `${reason.slice(0, 80)}...` : reason;
}

export default async function AdminNotificationsPage({
  searchParams,
  adminBasePath = "/admin",
}: AdminNotificationsPageProps) {
  const notificationsPath = getAdminPath(adminBasePath, "notifications");

  await requireAdminSession(getAdminPath(adminBasePath, "login"));
  const params = await searchParams;
  const feedback = getAdminFeedback(params);
  const detailId = getSearchParamValue(params, "recordId");
  const {config, records, retryableRecordIds, detail} = await loadAdminTelegramPushData(detailId);
  const retryableRecordIdSet = new Set(retryableRecordIds);
  const returnTo = detailId
    ? `${notificationsPath}?recordId=${encodeURIComponent(detailId)}`
    : notificationsPath;

  return (
    <div className="space-y-6">
      <AdminPageIntro
        title="Telegram 推送"
        description="配置机器人凭据、发送测试消息，并追踪自动故障/恢复推送记录。"
      />

      {feedback ? <AdminStatusBanner type={feedback.type} message={feedback.message} /> : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <AdminPanel title="保存配置" description="Bot Token 与 Chat ID 会按原文保存并显示。">
          <form action={saveTelegramPushConfigAction} className="space-y-4">
            <input type="hidden" name="returnTo" value={notificationsPath} />

            <AdminField
              label="项目显示名称"
              description={`默认 RKAPI模型状态检测，最多 ${TELEGRAM_PUSH_PROJECT_NAME_MAX_LENGTH} 个字符，用作 Telegram 文本前缀。`}
            >
              <AdminInput
                name="project_name"
                defaultValue={config.project_name}
                maxLength={TELEGRAM_PUSH_PROJECT_NAME_MAX_LENGTH}
                required
              />
            </AdminField>

            <AdminField
              label="Bot Token"
              description="在 Telegram 搜索 @BotFather，发送 /newbot 创建机器人，复制 Bot Token 填到这里。Token 等同机器人密钥，不要发到群组或公开页面。"
            >
              <AdminInput name="bot_token" defaultValue={config.bot_token ?? ""} />
            </AdminField>

            <AdminField label="Chat ID">
              <AdminInput name="chat_id" defaultValue={config.chat_id ?? ""} />
              <div className="space-y-1 text-xs leading-5 text-muted-foreground">
                <p>私聊填管理员 Telegram 用户 ID。</p>
                <p>频道填频道 ID 或 @频道用户名。</p>
                <p>群组填群组 ID。</p>
                <p>私聊用户需先主动给机器人发过消息。</p>
                <p>频道/群组需把机器人加入并授予发消息权限。</p>
              </div>
            </AdminField>

            <AdminCheckbox
              name="auto_push_enabled"
              defaultChecked={config.auto_push_enabled}
              label="启用自动推送"
              description="正常 -> 连续失败 3 次 -> 发故障；故障中 -> 连续成功 1 次 -> 发恢复。"
            />

            <Button type="submit" className="w-full rounded-full">
              保存配置
            </Button>
          </form>
        </AdminPanel>

        <AdminPanel title="测试推送" description="点击后直接向配置的 Chat ID 发送测试消息。">
          <form action={sendTelegramPushTestAction} className="space-y-4">
            <input type="hidden" name="returnTo" value={notificationsPath} />
            <AdminField label="测试文本">
              <AdminTextarea
                name="test_message"
                defaultValue={DEFAULT_TELEGRAM_PUSH_TEST_MESSAGE}
                className="min-h-[110px]"
              />
            </AdminField>
            <Button type="submit" variant="outline" className="w-full rounded-full">
              测试推送
            </Button>
          </form>
        </AdminPanel>
      </div>

      <AdminPanel
        title="自动推送设置"
        description="自动推送使用当前 Bot Token、Chat ID 和项目显示名称。"
      >
        <div className="grid gap-3 text-sm leading-6 text-muted-foreground md:grid-cols-3">
          <div className="rounded-[1.25rem] border border-border/40 bg-background/70 p-4">
            <div className="font-medium text-foreground">故障触发</div>
            <p className="mt-1">同一模型连续失败 3 次后发送“暂不可调用”。</p>
          </div>
          <div className="rounded-[1.25rem] border border-border/40 bg-background/70 p-4">
            <div className="font-medium text-foreground">恢复触发</div>
            <p className="mt-1">已推送故障后，连续成功 1 次发送“已恢复正常调用”。</p>
          </div>
          <div className="rounded-[1.25rem] border border-border/40 bg-background/70 p-4">
            <div className="font-medium text-foreground">当前状态</div>
            <p className="mt-1">
              {config.auto_push_enabled ? "自动推送已启用" : "自动推送已关闭"}
              {config.bot_token && config.chat_id ? "，凭据已配置。" : "，Bot Token 或 Chat ID 未配置。"}
            </p>
          </div>
        </div>
      </AdminPanel>

      <div className="grid gap-6 2xl:grid-cols-[1.35fr_0.8fr]">
        <AdminPanel title="推送记录" description="显示最近 100 条 Telegram 推送记录。">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">记录 ID</th>
                  <th className="px-3 py-2 font-medium">项目显示名称</th>
                  <th className="px-3 py-2 font-medium">标题</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">推送次数</th>
                  <th className="px-3 py-2 font-medium">失败原因</th>
                  <th className="px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="rounded-[1.25rem] border border-dashed border-border/50 px-4 py-8 text-muted-foreground"
                    >
                      当前还没有任何推送记录。
                    </td>
                  </tr>
                ) : (
                  records.map((record) => (
                    <tr key={record.id} className="bg-background/70 shadow-sm">
                      <td className="rounded-l-[1.25rem] border-y border-l border-border/40 px-3 py-3 font-mono text-xs text-muted-foreground">
                        {record.id}
                      </td>
                      <td className="border-y border-border/40 px-3 py-3">{record.project_name}</td>
                      <td className="border-y border-border/40 px-3 py-3 font-medium text-foreground">
                        {record.title}
                      </td>
                      <td className="border-y border-border/40 px-3 py-3">
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1",
                            getRecordStatusTone(record.status)
                          )}
                        >
                          {getRecordStatusLabel(record.status)}
                        </span>
                      </td>
                      <td className="border-y border-border/40 px-3 py-3">{record.push_count}</td>
                      <td className="max-w-[240px] border-y border-border/40 px-3 py-3 text-muted-foreground">
                        {truncateFailureReason(record.failure_reason)}
                      </td>
                      <td className="rounded-r-[1.25rem] border-y border-r border-border/40 px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Link
                            href={`${notificationsPath}?recordId=${encodeURIComponent(record.id)}`}
                            className="inline-flex h-9 items-center rounded-full border border-border/40 bg-background px-3 text-xs font-medium text-foreground transition hover:border-cyan-500/30"
                          >
                            详情
                          </Link>
                          {retryableRecordIdSet.has(record.id) ? (
                            <form action={retryTelegramPushRecordAction}>
                              <input type="hidden" name="id" value={record.id} />
                              <input type="hidden" name="returnTo" value={returnTo} />
                              <Button type="submit" variant="outline" size="sm" className="rounded-full">
                                重试
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </AdminPanel>

        <AdminPanel title="推送记录详情" description="查看单条记录的原始内容和最后失败原因。">
          {detail ? (
            <div className="space-y-4 text-sm">
              <div className="grid gap-3">
                <DetailRow label="记录 ID" value={detail.id} mono />
                <DetailRow label="状态" value={getRecordStatusLabel(detail.status)} />
                <DetailRow label="推送次数" value={String(detail.push_count)} />
                <DetailRow label="Chat ID" value={detail.chat_id ?? "—"} />
                <DetailRow label="项目显示名称" value={detail.project_name} />
                <DetailRow label="事件类型" value={detail.event_type ?? "—"} />
                <DetailRow label="状态键" value={detail.notification_key ?? "—"} mono />
                <DetailRow label="创建时间" value={formatAdminTimestamp(detail.created_at)} />
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">内容原文</div>
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[1.25rem] border border-border/40 bg-background/80 p-4 text-xs leading-6 text-foreground">
                  {detail.content}
                </pre>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">失败原因</div>
                <div className="rounded-[1.25rem] border border-border/40 bg-background/80 p-4 text-sm leading-6 text-muted-foreground">
                  {detail.failure_reason ?? "—"}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-[1.25rem] border border-dashed border-border/50 px-4 py-8 text-sm text-muted-foreground">
              从推送记录中点击“详情”查看完整信息。
            </div>
          )}
        </AdminPanel>
      </div>
    </div>
  );
}

function DetailRow({label, value, mono}: {label: string; value: string; mono?: boolean}) {
  return (
    <div className="rounded-[1.25rem] border border-border/40 bg-background/70 px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 break-all text-foreground", mono ? "font-mono text-xs" : "text-sm")}>
        {value}
      </div>
    </div>
  );
}
