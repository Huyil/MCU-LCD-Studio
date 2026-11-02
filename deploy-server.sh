#!/bin/bash
# 通用静态站点发布脚本（不包含任何服务器地址/密钥）
#
# 用法:
#   DEPLOY_HOST=your-host.example \
#   DEPLOY_PATH=/var/www/lcd \
#   DEPLOY_URL=https://your-host.example/lcd/ \
#   bash deploy-server.sh
#
# 可选:
#   DEPLOY_USER=deploy       SSH 用户（默认 root）
#   DEPLOY_KEY=~/.ssh/id_rsa SSH 私钥
#   DEPLOY_BASE=/lcd/        Vite base，默认 /lcd/
set -e
cd "$(dirname "$0")"

: "${DEPLOY_HOST:?请设置 DEPLOY_HOST（目标服务器）}"
: "${DEPLOY_PATH:?请设置 DEPLOY_PATH（站点目录）}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_BASE="${DEPLOY_BASE:-/lcd/}"

echo "== 构建 =="
node_modules/.bin/vite build --base="$DEPLOY_BASE"

echo "== 上传 dist/ =="
RSYNC_SSH="ssh"
if [ -n "${DEPLOY_KEY:-}" ]; then
  RSYNC_SSH="ssh -i $DEPLOY_KEY"
fi
rsync -az --delete -e "$RSYNC_SSH" dist/ "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH"

if [ -n "${DEPLOY_URL:-}" ]; then
  echo "== 验证 =="
  WANT=$(grep -o 'index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)
  GOT=$(curl -s --max-time 8 "$DEPLOY_URL" | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1 || true)
  if [ -n "$WANT" ] && [ "$WANT" = "$GOT" ]; then
    echo "bundle: $GOT ✓"
  else
    echo "bundle: 服务器 ${GOT:-无} ≠ 本地 ${WANT:-无}"
  fi
  echo "HTTP: $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$DEPLOY_URL" || true)"
fi
