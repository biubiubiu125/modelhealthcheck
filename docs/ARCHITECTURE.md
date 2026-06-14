# Check CX 架构说明

本文档描述当前仓库的整体架构、核心数据流以及模块边界。它对应的是**带后台管理、可切换存储后端、单进程轮询**的当前实现，而不是上游早期的 Supabase-only / 多节点租约版本。

## 1. 总览

Check CX 当前可分为四个运行时层：

1. **Next.js App Router**：提供 Dashboard、后台管理页与 API 路由。
2. **后台轮询器**：在单个进程内定时执行健康检查与官方状态抓取。
3. **控制面存储层**：通过 `lib/storage/resolver.ts` 在 Supabase、直连 Postgres、SQLite 之间解析后端。
4. **聚合与缓存层**：负责历史快照、统计聚合、ETag 与前端缓存。

核心数据流：

```text
check_configs / request_templates / site_settings
            ↓
         轮询器
            ↓
    可用能力范围内的持久化写入
            ↓
   聚合快照 / Dashboard API / Admin UI
```

## 2. 运行时组件

### 2.1 页面与 API

- `app/page.tsx`：Dashboard 首屏 SSR。
- `app/admin/**`：后台管理控制面，包括登录、配置、模板、Telegram 推送、存储诊断、站点设置等。
- `app/api/dashboard/route.ts`：Dashboard 数据 API（ETag + 缓存）。
- `app/api/v1/status/route.ts`：对外只读状态 API。

### 2.2 后台轮询器

- `lib/core/poller.ts`：单进程轮询器，负责周期性执行健康检查并写入可用后端。
- `lib/core/official-status-poller.ts`：轮询 OpenAI / Anthropic 官方状态并做内存缓存。
- `lib/core/polling-config.ts`：统一管理轮询间隔、官方状态轮询间隔和并发默认值。

### 2.3 控制面存储层

- `lib/storage/resolver.ts`：解析 `supabase | postgres | sqlite`，并输出当前能力矩阵。
- `lib/storage/supabase.ts`：完整能力后端，支持控制面、历史快照、可用性统计，以及 Supabase 专属诊断 / 运行时迁移。
- `lib/storage/postgres.ts` / `lib/storage/sqlite.ts`：完整单实例后端，支持控制面、`check_history`、可用性统计聚合与自动建表；仍不提供租约选主与 Supabase 专属诊断 / 运行时迁移能力。

### 2.4 管理与诊断层

- `lib/admin/auth.ts`：管理员账户、Session、Turnstile 集成。
- `lib/admin/data.ts`：后台数据读写聚合入口。
- `lib/admin/storage-diagnostics.ts`：存储能力矩阵、运行时迁移与后端诊断信息。
- `lib/supabase/runtime-migrations.ts`：读取 `RUNTIME_MIGRATIONS` 列出的迁移文件，并执行运行时迁移检查 / 补齐。

## 3. 后端能力矩阵

当前后端已经能覆盖同一套单实例运行时，但仍保留少量平台专属能力差异：

| 能力 | Supabase | Postgres | SQLite |
|---|---|---|---|
| 管理员认证 | ✅ | ✅ | ✅ |
| 检测配置 / 模板 / Telegram 推送 / 通知 / 站点设置 | ✅ | ✅ | ✅ |
| 自动建表（控制面） | ❌ | ✅ | ✅ |
| 历史快照写入 | ✅ | ✅ | ✅ |
| 可用性统计 | ✅ | ✅ | ✅ |
| 运行时迁移诊断 / 自动修复 | ✅ | ❌ | ❌ |
| Supabase 专属诊断 | ✅ | ❌ | ❌ |
| 可配置站点图标（favicon） | ✅ | ✅ | ✅ |

因此，当前仓库的推荐理解是：

- **Supabase / Postgres / SQLite**：都可以承接单实例下的完整运行路径（后台管理、历史写入、可用性统计、站点图标配置）
- **Supabase**：额外提供运行时迁移诊断 / 自动修复与 Supabase 专属诊断，适合需要这些托管能力的部署
- **Postgres / SQLite**：更适合本地、自托管或轻量部署；切库时会导入并校验当前数据（含历史记录），但仍不是双写或 active-active

## 4. 关键数据流

### 4.1 配置加载

- `lib/database/config-loader.ts` 从当前活动控制面后端读取 `check_configs`。
- 请求模板、Telegram 推送、通知、站点设置等后台数据通过 `lib/admin/data.ts` 汇总。

### 4.2 健康检查执行

- `lib/providers/ai-sdk-check.ts` 统一发起 Provider 检查。
- `lib/providers/challenge.ts` 负责挑战题验证，目前包含 yes/no 与算术类验证逻辑。
- `lib/providers/endpoint-utils.ts` / `endpoint-ping.ts` 负责端点层与网络层辅助逻辑。

### 4.3 历史与统计

- `lib/database/history.ts` 通过当前活动后端的 `storage.runtime.history` 读写历史。
- `lib/database/availability.ts` 通过当前活动后端的 `storage.runtime.availability` 读取 7/15/30 天统计。
- 可用性统计在 Supabase、Postgres、SQLite 上都由历史记录派生；只有 Supabase 保留额外的迁移诊断 / 自动修复能力。

### 4.4 前端聚合与缓存

- `lib/core/health-snapshot-service.ts` 负责统一刷新与快照读取。
- `lib/core/dashboard-data.ts` 生成 Dashboard 所需聚合结构。
- `lib/core/frontend-cache.ts` 在客户端侧做 SWR 风格缓存。

## 5. 模块边界

- `app/`：页面、API 路由与后台入口
- `components/`：Dashboard、后台 UI 组件
- `lib/core/`：轮询、聚合、缓存与运行参数解析
- `lib/providers/`：各 Provider 检查能力与请求验证
- `lib/storage/`：后端解析、能力矩阵、控制面持久化实现，以及 runtime history / availability 适配层
- `lib/database/`：对当前活动后端的历史、统计与聚合读取做统一 facade
- `lib/admin/`：后台认证、写操作、诊断与反馈视图
- `lib/supabase/`：Supabase 客户端与运行时迁移逻辑

## 6. 单进程轮询模型

- 当前实现默认按**单进程**模式运行：同一个应用实例直接启动轮询器。
- Dashboard / API 路径会确保轮询器被拉起，并在必要时补跑刷新。
- 上游版本中的数据库租约选主已不再是当前默认路径；如果未来要恢复多节点部署，需要重新设计明确的去重/选主机制。

## 7. 关键约束

- `enabled = false` 的配置不会被轮询。
- `is_maintenance = true` 会保留卡片，但不执行真实检查。
- 非 Supabase 后端下，不应假设运行时迁移诊断 / 自动修复与 Supabase 专属诊断能力存在；但可以假设历史写入与可用性统计已经可用。
- 容器镜像若需要支持 Supabase 运行时迁移，必须把 `supabase/migrations/` 一起打包到镜像中。
- 站点图标通过 `app/layout.tsx` 的 `generateMetadata()` 从站点设置读取，`app/favicon.*` 不能再作为动态图标来源，否则会覆盖数据库驱动的 metadata icons。

