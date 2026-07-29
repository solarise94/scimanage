#!/usr/bin/env bash
# 安装 git hooks 到本地 .git/hooks/。
# 由 package.json 的 "prepare" 脚本调用：npm install 后自动执行。
# 也可手动执行：bash scripts/install-hooks.sh
#
# Husky 会引入额外依赖，本项目改用纯 bash 脚本 + prepare 钩子实现零依赖安装。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_SRC="$SCRIPT_DIR/hooks"

# 非 git 目录（rsync 运行镜像、容器构建等）无 hooks 可装，优雅跳过而不是让
# npm prepare 失败。git rev-parse 失败时 GIT_DIR 为空。
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || true)"
if [ -z "$GIT_DIR" ]; then
  echo "非 git 目录，跳过 git hooks 安装（rsync 镜像/容器构建场景）"
  exit 0
fi
HOOKS_DST="$GIT_DIR/hooks"

mkdir -p "$HOOKS_DST"

installed=0
for hook_src in "$HOOKS_SRC"/*; do
  [ -f "$hook_src" ] || continue
  hook_name=$(basename "$hook_src")
  hook_dst="$HOOKS_DST/$hook_name"

  # 如果已存在且内容相同，跳过
  if [ -f "$hook_dst" ] && diff -q "$hook_src" "$hook_dst" >/dev/null 2>&1; then
    continue
  fi

  cp "$hook_src" "$hook_dst"
  chmod +x "$hook_dst"
  echo "✓ 已安装 git hook: $hook_name"
  installed=1
done

if [ "$installed" -eq 1 ]; then
  echo "git hooks 安装完成（pre-commit 密钥扫描已激活）"
else
  echo "git hooks 已是最新"
fi
