<!-- 本文件面向 AI 编程助手。CLAUDE.md 通过 @AGENTS.md 引用此文件；请直接编辑这里，不要编辑 CLAUDE.md。 -->

# SciManage — AI Agent 驱动的科研 ERP 系统（Agent ERP for Research）

中文界面的 Next.js 全栈应用，面向单细胞测序与空间转录组领域的科研项目全生命周期管理。核心能力：项目/工单、客户/组织、CRM、统一订单与财务、合同出具、供应链与成本核算、AI Agent 工作台、多角色权限与部门隔离。

> 本仓库为公开发布版：不含任何部署拓扑、主机、域名或私有凭据。所有"开发环境/生产环境"均为通用表述，按部署方实际环境配置。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Next.js 16 App Router, React 19 |
| 语言 | TypeScript 5 |
| 样式 | Tailwind CSS v4, shadcn/ui (base-nova), `@base-ui/react` |
| 数据库 | Prisma 5 + SQLite（better-sqlite3） |
| 状态 | TanStack Query v5, Zustand |
| 认证 | NextAuth v4, JWT, Credentials + Representative Magic Link |
| 构建 | `output: "standalone"` |
| Agent runtime | 独立 Node sidecar（`agent-runtime/`），SSE 流式 + GenUI 卡片 |
| 包管理 | npm |

---

## 常用命令

```bash
npm ci                    # 安装依赖（含 prisma generate / better-sqlite3 原生编译）
npm run dev               # 本地开发（读取仓库根 .env，默认 http://localhost:3000）
npm run build             # 生产构建（standalone）
npm run lint              # ESLint
npm run typecheck:app     # 应用代码 tsc 类型检查
npm run typecheck:scripts # scripts/ 下的 TS 类型检查
npm run test              # Vitest 全量（含临时 SQLite）
npx vitest run <file>     # 跑单个测试文件

npx prisma db push        # schema 同步到 SQLite（幂等，dev.db 不存在会自动建）
npx prisma migrate dev --name <name>  # 创建迁移
npx tsx prisma/seed.ts    # 重置并填充种子数据（⚠️ 清空数据；需 ADMIN_SEED_PASSWORD 等环境变量）
```

> ⚠️ **严禁使用 `npm run start`**。验证生产构建用 `node .next/standalone/server.js`。

---

## 项目结构

```
src/
  app/           # Next.js 页面与 API 路由
  components/    # React 组件（ui/、crm/、agent/ 等）
  hooks/         # 自定义 Hooks
  lib/           # 核心业务逻辑
    auth.ts, prisma.ts, permissions.ts, role-guards.ts, app-url.ts
    orders/      # 统一订单系统（application/ 内为 canonical service）
    finance/     # 财务模块
    crm/         # CRM 业务逻辑、权限、常量
    contracts/   # 合同模板与生成
    supply-chain/# 供应链
    costing/     # 成本核算
    agent-actions/ # Agent action registry + public tool surface
    agent-runtime/ # 向量/召回等 Agent runtime 客户端
    draft/       # AI 草稿工作流（含 ASR providers）
    portal/      # 门户配置（PORTAL_CODE、部门隔离、cookie 命名）
    plugins/     # 插件系统
agent-runtime/   # 独立 Node sidecar（SSE 流式服务）
prisma/          # schema、seed、开发数据库
scripts/         # 辅助脚本（含 hooks/pre-commit 密钥扫描）
tests/           # Vitest 测试
container/       # Dockerfile + entrypoint.sh（公共部署）
```

路径别名：`@/*` → `./src/*`。

---

## 关键开发规范

- **无 `middleware.ts`**：每个 API route 内联 `getServerSession(authOptions)`，页面用 `useSession()` + 客户端跳转。
- **Prisma 单例**：始终从 `@/lib/prisma` 导入，禁止 `new PrismaClient()`。
- **Tailwind v4**：无 `tailwind.config.ts`，token 在 `src/app/globals.css` 的 `@theme inline` 中。
- **页面组件**：均为 `"use client"`；使用 `useSearchParams()` 时必须用 `<Suspense>` 包裹。
- **URL 构建**：禁止手动拼 `process.env.NEXTAUTH_URL`，用 `@/lib/app-url`。
- **Scope 查询 AND-composition**：Order/Cost/Invoice API 中 scope WHERE 与搜索/筛选条件必须用 `{ AND: [scopeWhere, searchOR, filters] }` 合并，禁止覆盖 where 对象。
- **批量写入**：涉及多表导入用 `prisma.$transaction()` 包裹，防止产生孤儿数据。
- **测试框架**：已使用 Vitest（`npm run test` / `npx vitest run <测试文件>`）；配置见 `vitest.config.ts`，测试放在 `src/**/__tests__/**/*.test.ts` 或 `tests/**/*.test.ts`。涉及数据库的测试必须使用临时 SQLite（见 `scripts/lib/temp-smoke-db.ts`），不得依赖或修改真实开发/生产数据库。
- **dev 模式 webpack**：`package.json` 的 `dev` 脚本固定用 `--webpack`（Next.js 16 的 Turbopack 在本项目有 `globals.css` 的 `var(--color-*)` 解析 bug）。生产构建走 Turbopack。

### Agent 开发要点

- 保留独立 `/agent` 页面；新增能力优先实现 `src/lib/agent-actions/actions/*.ts`，再暴露到 `/api/agent/**`。
- 复用现有 MiniMax 配置（`src/lib/minimax.ts`），不新增第二套模型配置。
- 遵循 `parseInput -> availability -> execute -> buildProposal/resolveTarget`。
- `safe` 可直接执行，`confirm` 必须持久化 proposal 并由 `/api/agent/proposals/[id]/confirm` 执行。
- 权限边界只在 Next.js 后端、NextAuth session、`AgentRun` 和业务权限函数。
- 所有写操作、proposal 生成/拒绝/确认都要写 `AgentActionLog`。
- **Canonical service 边界（`npm run check:agent-boundaries` 守护 `blocking=0 debt=0 allowlist=0`）**：
  - action / `/api/agent/**` route **禁止直连 Prisma**（无 `prisma.*` / `tx.<model>` / `Prisma.TransactionClient` / 服务端 `fetch("/api/**")`）。
  - 正式业务模型（Order/Project/Ticket/CRM/Finance/Contract 等）只经 actor-aware canonical service（`*ForActor`，位于各领域 `application/` 目录），与 Web route 共用同一权限函数与状态机；adapter 不复制权限、状态机、业务 `where/include`。
  - Agent 自身模型（AgentRun/AgentProposal/AgentActionLog/AgentChat*/AgentMemory*/AgentTaskWorkspace/AgentBackgroundJob*/AgentAttachment*/Notification）只经 `src/lib/application/agent-*.ts` 与 `notifications.ts` 等 runtime canonical service；这些模块是扫描根之外唯一允许的 Prisma 入口。
  - 入口签名统一 `AgentExecutionContext = { actor: BusinessActor, invocation: InvocationContext }`（`availability(actor)` 收 BusinessActor）。
  - 浏览器 `"use client"` 模块对 `/api/agent/**` 的 `fetch` 是合法客户端访问（扫描器自动识别豁免）；服务端模块不得内部 HTTP 复用，同进程执行用 `execute-tool-for-run`。
  - 跨渠道等价性由 `tests/web-agent-parity.test.ts`（service 级，confirm action 走完整 proposal→confirm 链）+ `tests/web-route-mapping.test.ts`（route 级 HTTP 映射）防回归，均用临时 SQLite。
- **Public tool surface（分层 `Model → public tool → internal action(s) → canonical service → Prisma`）**：
  - public facade（`src/lib/agent-actions/public/`）零 Prisma，只调已登记 internal action，绝不直连 canonical service。
  - 真实 id 直传：公开面直接传真实资源 id（`customerId`/`orderId` 等），授权 100% 由 canonical service 的 `id AND actorScope` gate 承担；资源不存在与越权合并为同一 404（防存在性泄露）。
  - Public manifest（`public/manifest.ts`）+ exposure 台账（`public/exposure-ledger.ts`）+ parity 断言（`public/manifest-parity.ts`，启动期经 `instrumentation.ts` 校验 manifest↔facade↔action 一致）。
  - Public executor（`public/public-executor.ts`）：只认 manifest `publicToolKey`，拒未知 key / 拒 internal actionKey 直提交 / 拒角色不符；facade 前 Zod strict 校验；execute-public 按 mode 映射 200/202。
  - allowProposal 可信事件（`src/lib/application/agent-confirmation-events.ts`）：channel=agent 的 proposal 创建必须在同事务内消费一次性 `AgentUserConfirmationEvent`（经 NextAuth 颁发，绑定 actor+run+confirm actionKey+幂等键），无事件 → 409 `NEEDS_USER_CONFIRMATION`；channel=web（GenUI 点击）不变。
  - Bundle selector（`public/bundle-selector.ts`）：确定性动态工具载入，单轮 ≤15 工具硬上限；selector 不是安全边界，不承担权限判断。
  - Technical owner gate（`src/lib/orders/application/technical-owner-gate.ts`）：Agent 写 Order/Project 要求 `actor.userId === resource.technicalOwnerUserId`（USER/ADMIN）；owner=null fail-closed；在最终写事务内复核（防 TOCTOU）。Web channel 保留既有 role policy。
  - Order draft（`src/lib/orders/application/order-drafts.ts`）：server-owned `OrderDraft`/`OrderDraftLine`（关系表，非 JSON），GenUI PATCH 仅允许产品/项目类型/数量/单价（乐观锁）；`propose_order` 不在 propose 阶段落单，只在 confirm 执行。

---

## 认证与权限

- **Provider**：Credentials（邮箱+密码，bcryptjs）；Representative（Magic Link，24h、单次使用）。
- **角色等级**：`REPRESENTATIVE` < `USER` < `ADMIN`。`REGIONAL_MANAGER` 可见下辖代表资料。
- **部门隔离 / 双门户**（`PORTAL_CODE`，产品能力）：构建期 `PORTAL_CODE=FIELD_SALES|ONLINE_OPS` 决定本门户可见能力；`getServerPortalConfig()` 生产 fail-closed。`src/lib/portal/` 负责门户配置、部门 scope、cookie 命名。API 权限由 `assertPortalAccess` + 部门校验保证。
- **暴力破解**：5 次失败锁定 15 分钟，触发时邮件通知所有 ADMIN。
- **项目权限**：见 `src/lib/permissions.ts`。
- **CRM 权限**：见 `src/lib/crm/permissions.ts`（按 `ownerUserId` 隔离，ADMIN 全量）。

---

## 数据模型

核心实体见 `prisma/schema.prisma`（约 130+ 模型，主要分组）：

- **用户/角色**：`User`, `Representative`, `FailedLoginAttempt`, `UserInvitation`
- **客户/组织**：`CrmCustomerProfile`, `Organization`, `OrganizationAlias`, `OrganizationSite`, `CustomerRepTag`, `CustomerMergeLog`
- **项目/工单**：`Project`, `ProjectMember`, `Ticket`, `TicketReply`, `ProjectNote`, `Milestone`
- **统一订单**：`Order`, `OrderLine`, `OrderSourceRecord`, `OrderProjectLink`, `OrderStatusHistory`, `OrderMerge`, `OrderInvoiceCoverage`, `OrderDraft`, `OrderDraftLine`
- **发票**：`BillingProfile`, `ProjectInvoice`, `ExternalOrderInvoiceRequest`, `InvoiceAdjustment`, `InvoiceDocument`, `IssuedInvoiceNumberClaim`, `IssuedInvoiceFileHashClaim`
- **财务**：`FinanceCost`, `FinanceReceipt`, `FinanceReceiptAllocation`, `FinanceAdvance`, `FinancePayable`, `FinancePayment`, `FinancePaymentAllocation`, `FinanceCommission`
- **CRM**：`CrmInteraction`, `CrmFollowUpTask`, `CrmVisitCheckin`, `CrmCustomerAddress`, `CrmCustomerRelation`, `CrmCustomerApplication`, `CrmRegionManager`, `CrmCustomerAssignmentLog`, `CrmCustomerPreference`, `CrmComplaint`, `CrmComplaintEvent`
- **合同**：`ContractTemplate`, `ContractDocument`, `OrderContractCoverage`, `ContractAttachment`
- **供应链/成本**：`ServiceCatalog`, `OrderLineServiceMapping`, `Supplier*`, `SupplyPlan*`, `SupplyRequirement`, `CostEntry`, `CostSnapshot`, `CostRule`
- **产品**：`Product`, `ProductSku`, `ProductAlias`, `ProductSkuComponent`, `ProductChangeLog`
- **Agent staging/job**：`AgentInvoiceStagingFile`, `AgentImportStagingFile`, `AgentTaskWorkspace`, `AgentBackgroundJob`, `AgentBackgroundJobItem`, `AgentRun`, `AgentChatSession`, `AgentChatMessage`, `AgentProposal`, `AgentActionLog`, `AgentMemory`, `AgentEntityMemory`, `AgentProactiveTask`

> `ExternalOrder` 及旧写 API 已废弃（410 Gone），新订单读写必须走 `Order` 模型。

---

## 数据库环境（通用约定）

- 各环境严格隔离；本仓库默认只维护开发库 `prisma/dev.db`。
- 生产/预发布环境的数据目录命名建议遵循 `.../task-manager-data/{prod,demo}/` 约定（仅作为 `src/lib/runtime-info.ts` 的运行环境识别提示，不绑定任何具体主机/域名/端口）。
- 开发数据库路径 `prisma/dev.db` 会被 `runtime-info.ts` 识别为 DEV 环境。

### 停服迁移规范（涉及不可逆 schema/数据迁移时）

1. 顺序：开发 → 预发布 → 生产，**严禁并行**。
2. 流程：停服务 → 备份 .db → 检测异常 → 跑迁移脚本 → `npx prisma db push` → 部署新代码 → 重启 → smoke test。
3. 数据迁移与新代码部署必须在**同一停服窗口**完成。
4. 迁移后抽样校验，确保金额正确。

---

## 开发环境

### 本地开发

```bash
cp .env.example .env            # 复制环境变量模板，填入本机值
npm ci                          # 安装依赖（含 better-sqlite3 原生编译、prisma generate）
npx prisma db push              # 初始化/同步 SQLite（dev.db 不存在会自动建）
npm run dev                     # http://localhost:3000（webpack 模式）
```

随用随停。涉及数据库的测试用 Vitest 临时 SQLite，不要污染 `prisma/dev.db`。

### 生产 / 公共部署

见 `README.md` 的 Docker 快速开始，以及 `container/Dockerfile` + `container/entrypoint.sh`。镜像自包含 schema 同步与可选首次 seed；`docker compose up -d` 一键起。生产配置（PORTAL_CODE / NEXTAUTH_URL / NEXTAUTH_SECRET / MINIMAX_API_KEY 等）通过 `.env` 注入，配置不入镜像。

---

## 核心子系统

- **CRM**：客户资料、互动、跟进任务、拜访签到、关系网络、客户申请、代表运营指标、公海认领。API 在 `src/app/api/crm/`，逻辑在 `src/lib/crm/`。
- **统一订单**：`/orders`，`Order` 家族模型，新订单唯一主路径。权限 `src/lib/orders/permissions.ts`。
- **财务**：发票、回款、成本、台账、凭证匹配。见 `src/lib/finance/`。凭证匹配支持 GLM-OCR 回单预填（`src/lib/finance/glm-ocr.ts` + `POST /api/finance/payment-vouchers/ocr`），**不改匹配算法、不自动核销**。
- **合同**：Word 模板 + 确定性变量替换，输出 .docx。见 `src/lib/contracts/`。
- **供应链与成本核算**：`ServiceCatalog` → `SupplyPlan` → `CostEntry/CostSnapshot` → `FinancePayable/Payment`。见 `src/lib/supply-chain/`、`src/lib/costing/`。
- **AI Agent 工作台**：`/agent`，SSE 流式 + GenUI 卡片，public tool surface（见上文 Agent 开发要点）。runtime sidecar 在 `agent-runtime/`。
- **AI / 草稿**：两段式 LLM、实体解析、搜索补齐、多模态输入。见 `src/lib/draft/`。
- **语音识别（ASR）**：默认**仅腾讯云** SentenceRecognition（`TENCENTCLOUD_SECRET_ID/KEY`）。`local-asr` / asr-fast 代码保留但不进入默认链（稳定优先）。
- **技术支持**：`Project.techSupport` 为人名字符串；内部员工（ADMIN/USER）新建订单生成项目/新建项目时为空则默认当前用户名（谁填谁负责），可搜索转交给其他内部员工。
- **插件**：`src/lib/plugins/registry.ts`。

---

## 安全

- 凭据（密码、token、API key）**必须来自环境变量**，严禁硬编码到源码、seed、脚本、注释。
- `NEXTAUTH_SECRET` 是 NextAuth JWT 签名密钥，生产必须设置（缺失时容器启动会失败并提示 `openssl rand -base64 32`）。
- 向量服务鉴权 `AGENT_VECTOR_API_KEY`、智谱 OCR 鉴权 `ZHIPU_API_KEY`（可选 `ZHIPU_API_BASE`）、ASR 鉴权 `ASR_LOCAL_API_KEY` 等第三方密钥只能从环境变量 / `.env` 注入；未配置时相关能力优雅降级或隐藏入口。
- `.env` / `.env.secrets` 被 `.gitignore` 的 `.env*` 规则忽略，绝不入库；只有 `.env.example` / `.env.secrets.example`（键名 + 占位空值 + 说明）作为模板提交。
- `bcrypt.hash` 的第一个参数必须是变量或 `process.env`，禁止硬编码明文。
- 测试账号由测试脚本临时自建、跑完删除；禁止在测试中使用真实账号或读取真实密码。
- 发现现有明文凭据必须主动提示并建议修复。
- `*.db` 已加入 `.gitignore`，禁止进 git。
- pre-commit 钩子（`scripts/hooks/pre-commit`，由 `npm run prepare` 安装）扫描暂存区拦截硬编码凭据与疑似高熵 token；已知泄露密码用 SHA-256 黑名单比对（只存哈希，不存明文）。
- 媒体文件存 `.draft-media/`，Vision provider 只接受本地路径，拒绝 HTTP/data URL。
- Magic Link 24h 单次有效，代表归档后禁止登录。

---

## 关键文件速查

| 目的 | 文件 |
|------|------|
| 入口布局 | `src/app/layout.tsx` |
| 全局样式 | `src/app/globals.css` |
| Next.js 配置 | `next.config.ts` |
| Schema | `prisma/schema.prisma` |
| 认证 | `src/lib/auth.ts` |
| Prisma 单例 | `src/lib/prisma.ts` |
| 项目权限 | `src/lib/permissions.ts` |
| 角色判断 | `src/lib/role-guards.ts` |
| URL 构建 | `src/lib/app-url.ts` |
| 运行环境识别 | `src/lib/runtime-info.ts` |
| 门户配置/部门隔离 | `src/lib/portal/` |
| 邮件 | `src/lib/mail.ts` |
| 订单常量/权限/类型 | `src/lib/orders/constants.ts`, `permissions.ts`, `types.ts` |
| 订单 canonical service | `src/lib/orders/application/` |
| 财务 | `src/lib/finance/` |
| CRM 常量/权限/Query | `src/lib/crm/constants.ts`, `permissions.ts`, `query-keys.ts` |
| 合同 | `src/lib/contracts/` |
| 供应链 | `src/lib/supply-chain/` |
| 成本核算 | `src/lib/costing/` |
| Agent actions | `src/lib/agent-actions/` |
| Agent runtime sidecar | `agent-runtime/` |
| Docker 部署 | `container/Dockerfile`, `container/entrypoint.sh`, `docker-compose.yml` |
| pre-commit 密钥扫描 | `scripts/hooks/pre-commit` |
| 临时 SQLite 测试库 | `scripts/lib/temp-smoke-db.ts` |
