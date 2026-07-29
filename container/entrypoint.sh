#!/bin/bash
# =============================================================================
# SciManage 容器入口（在 tini 之下，作为 PID 1 的直接子进程）
# =============================================================================
# 职责（自包含，不依赖宿主机脚本）：
#   1. 必填配置校验（NEXTAUTH_SECRET）
#   2. schema 同步（幂等）：npx prisma db push --skip-generate（dev.db 不存在自动建）
#   3. 首次初始化 seed（仅 dev.db 新建时，SEED_ON_FIRST_BOOT 默认 true）
#   4. 后台启动 agent-runtime sidecar
#   5. 前台启动 Next.js server（tini 收 SIGTERM 时一并退出）
#
# 所有运行时配置来自 .env / docker-compose env；本脚本不读 .conf。
# 默认值见 Dockerfile 末尾 ENV 与下方 ${VAR:-default}。
# =============================================================================
set -euo pipefail

echo "[entrypoint] SciManage starting..."

# ---------- 0. 必填配置校验 ----------
if [[ -z "${NEXTAUTH_SECRET:-}" ]]; then
  echo "[entrypoint] FATAL: NEXTAUTH_SECRET 未设置。NextAuth JWT 签名密钥必须提供。" >&2
  echo "[entrypoint]   生成方式：openssl rand -base64 32" >&2
  echo "[entrypoint]   在 .env 里设置 NEXTAUTH_SECRET=<上面命令的输出> 后重启。" >&2
  exit 1
fi

DATABASE_URL="${DATABASE_URL:-file:/data/dev.db}"
PORT="${PORT:-3000}"
AGENT_RUNTIME_PORT="${AGENT_RUNTIME_PORT:-3001}"

echo "[entrypoint] config: DATABASE_URL=${DATABASE_URL} PORT=${PORT} AGENT_RUNTIME_PORT=${AGENT_RUNTIME_PORT} PORTAL_CODE=${PORTAL_CODE:-FIELD_SALES}"

# ---------- 1. schema 同步（幂等）----------
# prisma db push 会按 schema 创建/补齐表；dev.db 文件不存在时 prisma 自动创建。
# 这一步对已存在的库是幂等的（只补差异），可安全地在每次启动重跑。
# 不带 --accept-data-loss：一旦升级需要破坏性变更，启动会失败并提示，
# 由运维显式备份后手动执行，而不是在每次启动时静默丢数据。
echo "[entrypoint] syncing database schema (prisma db push)..."
if ! (cd /app && npx --no-install prisma db push --skip-generate); then
  echo "[entrypoint] FATAL: prisma db push 失败，无法初始化/同步数据库 schema。" >&2
  echo "[entrypoint]   请检查 DATABASE_URL=${DATABASE_URL} 与 /data 卷的读写权限。" >&2
  echo "[entrypoint]   若提示需要 --accept-data-loss：先备份 /data/dev.db，再手动执行：" >&2
  echo "[entrypoint]   docker compose exec scimanage npx --no-install prisma db push --skip-generate --accept-data-loss" >&2
  exit 1
fi
echo "[entrypoint] schema sync OK."

# uploads 目录
if [[ ! -w "/app/public/uploads" ]]; then
  echo "[entrypoint] WARNING: /app/public/uploads 不可写，上传功能将失败。"
fi

# 发票 staging（Agent，默认 /data/invoice-staging）
STAGING_DIR="${INVOICE_STAGING_DIR:-/data/invoice-staging}"
mkdir -p "${STAGING_DIR}" 2>/dev/null || true
if [[ ! -w "${STAGING_DIR}" ]]; then
  echo "[entrypoint] WARNING: ${STAGING_DIR} 不可写，Agent 发票 staging 将失败。"
fi

# ---------- 2. 首次初始化 seed ----------
# 用一个 marker 文件记录是否已 seed 过，幂等且跨重启安全（不依赖比较 db 文件时间）。
SEED_MARKER="/data/.scimanage-seeded"
SEED_ON_FIRST_BOOT="${SEED_ON_FIRST_BOOT:-true}"

if [[ "${SEED_ON_FIRST_BOOT}" == "true" && ! -f "${SEED_MARKER}" ]]; then
  if [[ -f "/app/dist/seed.js" ]]; then
    if [[ -z "${ADMIN_SEED_PASSWORD:-}" || -z "${SEED_USER1_PASSWORD:-}" || -z "${SEED_USER2_PASSWORD:-}" ]]; then
      echo "[entrypoint] WARNING: SEED_ON_FIRST_BOOT=true 但缺少 seed 密码环境变量" >&2
      echo "[entrypoint]   （需同时提供 ADMIN_SEED_PASSWORD / SEED_USER1_PASSWORD / SEED_USER2_PASSWORD），跳过首次 seed。" >&2
      echo "[entrypoint]   首次登录请自建管理员账号，或手动执行 seed：" >&2
      echo "[entrypoint]     docker compose exec scimanage node /app/dist/seed.js  (需先 export 上述三个密码变量)" >&2
    else
      echo "[entrypoint] running first-boot seed..."
      if (cd /app && node dist/seed.js); then
        touch "${SEED_MARKER}"
        echo "[entrypoint] seed completed."
      else
        echo "[entrypoint] WARNING: 首次 seed 失败（不阻断启动）。schema 已就绪，可手动重跑：" >&2
        echo "[entrypoint]   docker compose exec scimanage node /app/dist/seed.js" >&2
      fi
    fi
  else
    echo "[entrypoint] NOTE: 未找到编译后的 seed bundle (/app/dist/seed.js)，跳过首次 seed。" >&2
    echo "[entrypoint]   手动 seed：在本机跑 'npx tsx prisma/seed.ts'（需 ADMIN_SEED_PASSWORD 等环境变量，指向同一 DATABASE_URL）。" >&2
    # 标记已尝试，避免每次启动重复打印
    touch "${SEED_MARKER}" 2>/dev/null || true
  fi
fi

# ---------- 3. 后台启动 agent-runtime sidecar ----------
# agent-runtime 监听容器内 3001，主 app 通过 AGENT_RUNTIME_URL 访问。
echo "[entrypoint] starting agent-runtime sidecar on :${AGENT_RUNTIME_PORT}..."
cd /app/agent-runtime
nohup node dist/server.js > /var/log/agent-runtime.log 2>&1 &
AGENT_PID=$!
echo "[entrypoint] agent-runtime pid=${AGENT_PID}"

# 给 sidecar 一点启动时间
sleep 2
if ! kill -0 "$AGENT_PID" 2>/dev/null; then
  echo "[entrypoint] WARNING: agent-runtime 启动后立即退出，日志：" >&2
  tail -20 /var/log/agent-runtime.log >&2 || true
  # 不致命：主 app 能在没有 agent 时优雅降级
fi

# ---------- 3.5 后台启动 contract-recovery 循环（可选）----------
if [[ -n "${REMINDER_CRON_TOKEN:-}" ]]; then
  (
    while true; do
      sleep 600
      curl -fsS -X POST \
        -H "Authorization: Bearer ${REMINDER_CRON_TOKEN}" \
        http://127.0.0.1:${PORT}/api/internal/contract-recovery/run \
        > /dev/null 2>&1 || true
    done
  ) &
  RECOVERY_PID=$!
  echo "[entrypoint] contract-recovery loop pid=${RECOVERY_PID}"
else
  RECOVERY_PID=""
  echo "[entrypoint] REMINDER_CRON_TOKEN not set, skipping contract-recovery loop"
fi

# ---------- 4. 前台启动 Next.js server ----------
echo "[entrypoint] starting Next.js server on :${PORT}..."
cd /app

# 捕获信号：tini 收到 SIGTERM/SIGINT 后转发到这里，先停 sidecar 再退
cleanup() {
  echo "[entrypoint] received signal, shutting down..."
  kill "$AGENT_PID" 2>/dev/null || true
  [ -n "$RECOVERY_PID" ] && kill "$RECOVERY_PID" 2>/dev/null || true
  wait "$AGENT_PID" 2>/dev/null || true
}
trap cleanup TERM INT

node server.js &
APP_PID=$!
echo "[entrypoint] next-server pid=${APP_PID}"

# 等任一进程退出
wait "$APP_PID"
EXIT_CODE=$?
echo "[entrypoint] next-server exited with ${EXIT_CODE}"
cleanup
exit "$EXIT_CODE"
