# SciManage — AI Agent 驱动的科研 ERP 系统

**Agent ERP for Research / 科研 ERP**：面向单细胞测序与空间转录组领域的科研项目全生命周期管理。基于 Next.js 16 + Prisma（SQLite）+ NextAuth 的中文全栈应用，内置 AI Agent 工作台（SSE 流式 + GenUI 卡片）。

> 单细胞测序 / 空间转录组科研团队的项目、客户、订单、财务、合同、供应链与成本一站式管理。

## 核心功能

- **项目 / 工单**：项目全生命周期、工单流转、状态历史、里程碑、项目笔记。
- **CRM 客户与公海**：客户资料、组织与别名、互动记录、跟进任务、拜访签到、公海认领、客户合并、代表运营指标。
- **统一订单 / 财务闭环**：统一 `Order` 模型，订单 → 开票 → 回款 → 成本 → 台账 → 凭证匹配，金额分级与回款核销。
- **合同出具**：Word 模板 + 确定性变量替换，输出 .docx，合同附件与生成记录可追溯。
- **供应链与成本核算**：`ServiceCatalog` → `SupplyPlan` → `CostEntry/CostSnapshot` → 应付 / 付款，供应商报价与询价。
- **AI Agent 工作台**：`/agent`，SSE 流式对话、GenUI 卡片（proposal/preview）、public tool surface、技术负责人 gate、订单草稿。
- **双门户部门隔离**：构建期 `PORTAL_CODE`（FIELD_SALES / ONLINE_OPS）决定门户可见能力，API 权限由门户与部门校验保证。
- **多角色权限**：REPRESENTATIVE / USER / ADMIN / REGIONAL_MANAGER，暴力破解锁定，Magic Link 单次登录。

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Next.js 16 App Router, React 19 |
| 语言 | TypeScript 5 |
| 样式 | Tailwind CSS v4, shadcn/ui, `@base-ui/react` |
| 数据库 | Prisma 5 + SQLite（better-sqlite3） |
| 状态 | TanStack Query v5, Zustand |
| 认证 | NextAuth v4, JWT, Credentials + Magic Link |
| Agent runtime | 独立 Node sidecar（`agent-runtime/`） |
| 部署 | Docker（单镜像，自包含 schema 同步） |

## Docker 快速开始

> 公共部署：`docker compose up -d` 一键拉起（含数据库初始化与可选首次 seed）。

1. 准备环境变量文件：

   ```bash
   cp .env.example .env
   # 编辑 .env，至少设置：
   #   NEXTAUTH_SECRET   <- openssl rand -base64 32 生成
   #   NEXTAUTH_URL      <- 你的访问地址，例如 http://localhost:3000
   #   MINIMAX_API_KEY   <- 启用 AI Agent 工作台时需要
   ```

2. 启动：

   ```bash
   docker compose up -d --build
   ```

3. 访问 `http://localhost:3000`。

**默认配置**（可在 `.env` / `docker-compose.yml` 覆盖）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | Next.js 监听端口 |
| `PORTAL_CODE` | `FIELD_SALES` | 门户（`FIELD_SALES` / `ONLINE_OPS`） |
| `DATABASE_URL` | `file:/data/dev.db` | SQLite 路径（容器内，挂载到命名卷） |
| `AGENT_RUNTIME_PORT` | `3001` | Agent runtime sidecar 端口（容器内） |
| `NEXTAUTH_URL` | `http://localhost:3000` | 对外访问地址 |
| `NEXTAUTH_SECRET` | （必填） | NextAuth JWT 签名密钥，缺失启动失败 |
| `MINIMAX_API_KEY` | （可选） | AI Agent 工作台模型 key |
| `SEED_ON_FIRST_BOOT` | `true` | 首次启动（dev.db 新建）时是否执行 seed（需同时提供 `ADMIN_SEED_PASSWORD` / `SEED_USER1_PASSWORD` / `SEED_USER2_PASSWORD`） |

数据持久化在命名卷 `scimanage-data`（`/data`）。生产环境请务必通过反向代理提供 HTTPS，并设置强随机的 `NEXTAUTH_SECRET`。

更多环境变量见 `.env.example`。

## 本地开发

```bash
cp .env.example .env            # 复制模板，填入本机值（本地开发至少需要 NEXTAUTH_SECRET）
npm ci                          # 安装依赖（含 better-sqlite3 原生编译、prisma generate）
npx prisma db push              # 初始化/同步 SQLite（dev.db 不存在会自动建）
npm run dev                     # http://localhost:3000（webpack 模式）
```

Agent runtime sidecar（启用 AI Agent 工作台时需要，另起终端）：

```bash
cd agent-runtime
npm ci                          # sidecar 有独立 package.json / lockfile
npm run build                   # TypeScript → dist/
npm run dev                     # 默认监听 127.0.0.1:31110（.env 里 AGENT_RUNTIME_URL 保持一致）
```

常用命令：

```bash
npm run lint                    # ESLint
npm run typecheck:app           # 应用代码类型检查
npm run typecheck:scripts       # 脚本类型检查
npm run test                    # Vitest（用临时 SQLite，不污染 dev.db）
npm run build                   # 生产构建（standalone）
node .next/standalone/server.js # 验证生产构建（勿用 npm run start）
```

> ⚠️ `dev` 脚本固定用 `--webpack`（Next.js 16 的 Turbopack 在本项目有 globals.css 解析 bug）。

详细的开发规范、架构边界、Agent 开发要点、安全规则见 [`AGENTS.md`](./AGENTS.md)。

## 环境变量

完整变量清单见 [`.env.example`](./.env.example)。主要分组：

- **基础**：`NEXTAUTH_URL`、`NEXTAUTH_SECRET`、`DATABASE_URL`、`PORT`、`PORTAL_CODE`
- **AI / Agent**：`MINIMAX_API_KEY`、`AGENT_RUNTIME_*`、`AGENT_VECTOR_*`（可选）
- **第三方服务（可选）**：`TENCENTCLOUD_*`（ASR）、`ZHIPU_API_KEY`（OCR）、邮件 `SMTP_*`
- **Seed**：`ADMIN_SEED_PASSWORD`、`SEED_USER1_PASSWORD`、`SEED_USER2_PASSWORD`（仅首次 seed 用）

## License

[MIT](./LICENSE) · Copyright (c) 2026 solarise94
