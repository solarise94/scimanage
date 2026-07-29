# =============================================================================
# SciManage — Next.js standalone + agent-runtime sidecar 单镜像（公共版）
# =============================================================================
# 自包含镜像：启动时 entrypoint 幂等执行 `npx prisma db push --skip-generate`，
# 不再依赖宿主机脚本。多阶段：
#   deps:    npm ci（含 better-sqlite3 原生编译）
#   builder: prisma generate -> next build -> agent-runtime tsc -> esbuild 打包 seed.ts
#            + 为 hashed prisma client 建 shim
#   runner:  拷贝 standalone + prisma CLI/schema + seed bundle + agent-runtime + tini 入口
#
# 关键约束：Next.js 把 @prisma/client 编译成 @prisma/client-<hash> 引用，运行时
# node_modules 必须存在这些 hashed 包名，否则 Module not found。builder 末尾建 shim
# 重导出到标准 @prisma/client（移植自原 deploy-standalone.sh）。
#
# 运行时配置走 .env / docker-compose env（12-factor，配置不入镜像）。
#
# 镜像源 ARG（默认官方源；国内用户可 build-arg 切换）：
#   APT_MIRROR     默认 deb.debian.org（改 aliyun 需 build-arg APT_MIRROR=mirrors.aliyun.com）
#   NPM_REGISTRY   默认 https://registry.npmjs.org（改 npmmirror 需 build-arg NPM_REGISTRY=https://registry.npmmirror.com）
# =============================================================================

ARG APT_MIRROR=deb.debian.org
ARG NPM_REGISTRY=https://registry.npmjs.org
# node-gyp 下载 Node headers 的源（better-sqlite3 等原生模块编译需要）。
# 国内网络访问 nodejs.org 困难时切 npmmirror：
#   --build-arg NODE_DISTURL=https://npmmirror.com/mirrors/node/
ARG NODE_DISTURL=https://nodejs.org/download/release
# 统一构建版本：builder 内联进 bundle，runner 注入进程 env，两侧必须一致。
# 默认固定占位符保证零配置一致性；正式发布建议显式传时间戳/commit：
#   --build-arg APP_BUILD_VERSION=$(date +%s%3N)
ARG APP_BUILD_VERSION=docker-local

# --------- deps ---------
FROM node:20-bookworm-slim AS deps

ARG APT_MIRROR
ARG NPM_REGISTRY
ARG NODE_DISTURL
# node-gyp 经 npm config 读取 disturl；prebuild-install 失败后会回退 node-gyp 编译。
ENV npm_config_disturl=${NODE_DISTURL}

# 装 build 工具（better-sqlite3 等原生模块需要 python3/make/g++）
RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list; \
  fi; \
  apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}

# 主应用依赖。--ignore-scripts：npm ci 会触发根 package.json 的 prepare（git hooks 安装），
# 而镜像里没有 git、scripts/ 也尚未 COPY；原生模块在安装后显式 rebuild。
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=optional --ignore-scripts --no-fund --no-audit
# better-sqlite3 原生二进制（prebuild-install 优先，失败回退 node-gyp 编译；
# 工具链与 headers 镜像已在上方备好）。@prisma/client 的 postinstall 由 builder 的
# `npx prisma generate` 覆盖，无需在此执行。
RUN --mount=type=cache,target=/root/.npm \
    npm rebuild better-sqlite3

# agent-runtime sidecar 依赖
COPY agent-runtime/package.json agent-runtime/package-lock.json ./agent-runtime/
RUN --mount=type=cache,target=/root/.npm \
    cd agent-runtime && npm ci --omit=dev --ignore-scripts --no-fund --no-audit

# --------- builder ---------
FROM node:20-bookworm-slim AS builder

ARG APT_MIRROR
ARG NPM_REGISTRY

RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list; \
  fi; \
  apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}

# 复用 deps 装好的 node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/agent-runtime/node_modules ./agent-runtime/node_modules

# 拷源码（含 prisma；generate 单独一层）
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.scripts.json next.config.ts postcss.config.mjs components.json ./
COPY eslint.config.mjs ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY agent-runtime/src ./agent-runtime/src
COPY agent-runtime/tsconfig.json ./agent-runtime/tsconfig.json
COPY agent-runtime/package.json ./agent-runtime/package.json

# Prisma 客户端生成（必须先于 build，next build 会引用）。
# 默认走官方 binaries.prisma.sh；国内构建传 --build-arg PRISMA_ENGINES_MIRROR=
# https://registry.npmmirror.com/-/binary/prisma（留空时【不】注入该变量，
# 避免空串覆盖默认值）。
ARG PRISMA_ENGINES_MIRROR=
RUN if [ -n "${PRISMA_ENGINES_MIRROR}" ]; then \
      PRISMA_ENGINES_MIRROR="${PRISMA_ENGINES_MIRROR}" npx prisma generate; \
    else \
      npx prisma generate; \
    fi

# Portal code（部门隔离）：getServerPortalConfig 生产 fail-closed，next build 的
# page-data 收集阶段也会评估该模块，构建期必须提供合法值。
# 默认 FIELD_SALES（单门户）；运行时以 .env 的 PORTAL_CODE 为准。
ARG PORTAL_CODE=FIELD_SALES
ENV PORTAL_CODE=${PORTAL_CODE}

# 统一构建版本：next.config.ts 构建期读取并内联进 bundle。
ARG APP_BUILD_VERSION
ENV APP_BUILD_VERSION=${APP_BUILD_VERSION}

# Next.js 生产构建（output: standalone）
RUN npm run build

# agent-runtime TypeScript 编译
RUN cd agent-runtime && npx tsc -p tsconfig.json

# --------- 编译 prisma/seed.ts 为单文件 bundle（runner 无 tsx，用 node 跑）---------
# seed.ts 用 @/ 路径别名；esbuild 把 @/* 解析到 ./src/* 并打进单文件。
# bundle 失败不阻断构建（entrypoint 会探测 seed.js 是否存在，缺则提示手动 seed）。
RUN set -eux; \
  mkdir -p /app/dist; \
  npx --no-install esbuild prisma/seed.ts \
    --bundle --platform=node --format=cjs --target=node20 \
    --outfile=/app/dist/seed.js \
    --alias:@=./src \
    --log-level=warning \
    || { echo "[builder] WARN: esbuild seed bundle failed; runner 将跳过首次 seed 并提示手动执行"; \
         rm -f /app/dist/seed.js; }

# --------- 为 hashed prisma client 建 shim（移植自 deploy-standalone.sh）---------
RUN <<'SHIM'
set -eu
echo "Building Prisma client shims for hashed package references..."
HASH_PKGS=$(grep -roh '@prisma/client-[0-9a-f]\+' /app/.next/standalone/.next/server/ 2>/dev/null | sort -u || true)
for HASH_PKG in ${HASH_PKGS}; do
  SHIM_DIR="/app/.next/standalone/node_modules/${HASH_PKG}"
  echo "  shim: ${HASH_PKG}"
  mkdir -p "${SHIM_DIR}"
  cat > "${SHIM_DIR}/package.json" <<EOF
{"name":"${HASH_PKG}","version":"0.0.0","main":"index.js"}
EOF
  cat > "${SHIM_DIR}/index.js" <<'EOF'
module.exports = require("@prisma/client");
EOF
  cat > "${SHIM_DIR}/default.js" <<'EOF'
module.exports = require("@prisma/client");
EOF
done
SHIM

# 确保 @prisma/client 和 .prisma 在 standalone node_modules 里
# （next.config serverExternalPackages 已排除，需手动补）
RUN mkdir -p /app/.next/standalone/node_modules/@prisma /app/.next/standalone/node_modules/.prisma \
 && cp -r /app/node_modules/@prisma/client /app/.next/standalone/node_modules/@prisma/ \
 && cp -r /app/node_modules/.prisma /app/.next/standalone/node_modules/

# --------- runner ---------
FROM node:20-bookworm-slim AS runner

ARG APT_MIRROR

# tini 做 PID 1；openssl 供 Prisma engine 检测；ca-certificates 出站 HTTPS。
# （公共版不再内嵌 ffmpeg 静态包，按需自行挂载或扩展。）
RUN set -eux; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources; \
  fi; \
  if [ -f /etc/apt/sources.list ]; then \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
      /etc/apt/sources.list; \
  fi; \
  apt-get update && apt-get install -y --no-install-recommends \
    tini openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 拷贝 standalone（含已补全的 prisma client + shim）
COPY --from=builder /app/.next/standalone ./
# static 资源（standalone 不含）
COPY --from=builder /app/.next/static ./.next/static
# public（不含 uploads，uploads 是运行时数据，由 volume 挂载）
COPY --from=builder /app/public ./public

# ── 自包含 schema 同步：把 prisma CLI + schema 带进 runner ──
# 这样 entrypoint 能执行 `npx prisma db push --skip-generate`。
# prisma CLI 本体 + @prisma 命名空间（含 @prisma/client、.prisma 生成产物、internals/sdk/engines）
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# prisma CLI 的 .bin 软链（npx / 直接调用 prisma 都需要）
COPY --from=builder /app/node_modules/.bin ./node_modules/.bin
# schema 本体（prisma db push 需要）
COPY --from=builder /app/prisma ./prisma

# seed bundle（可能不存在，见 builder 注释）
COPY --from=builder /app/dist ./dist

# agent-runtime sidecar 产物
COPY --from=builder /app/agent-runtime/dist ./agent-runtime/dist
COPY --from=builder /app/agent-runtime/node_modules ./agent-runtime/node_modules
COPY --from=builder /app/agent-runtime/package.json ./agent-runtime/package.json

# 入口脚本
COPY container/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 数据/上传目录（运行时由 volume 覆盖）
RUN mkdir -p /data /data/invoice-staging /app/public/uploads

# 容器内固定：app 监听 3000，agent-runtime 监听 3001；宿主机映射由 docker compose / -p 决定
# APP_BUILD_VERSION：runner 进程（app + agent-runtime）运行时读取，与 builder 阶段
# 内联进 bundle 的值来自同一个顶部 ARG（默认 docker-local），天然一致；
# 不一致会触发 AgentTurnRunner 版本校验 503 STREAM_TRANSPORT_MISMATCH。
ARG APP_BUILD_VERSION
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PORTAL_CODE=FIELD_SALES \
    AGENT_RUNTIME_HOST=127.0.0.1 \
    AGENT_RUNTIME_PORT=3001 \
    AGENT_RUNTIME_URL=http://127.0.0.1:3001 \
    AGENT_RUNTIME=pi \
    DATABASE_URL=file:/data/dev.db \
    NEXTAUTH_URL=http://localhost:3000 \
    APP_BUILD_VERSION=${APP_BUILD_VERSION}

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
