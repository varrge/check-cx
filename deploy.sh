#!/usr/bin/env bash
set -euo pipefail

BRANCH="${1:-${DEPLOY_BRANCH:-localDev}}"
PROXY="${DEPLOY_PROXY:-http://192.168.110.143:7890}"

if [[ -n "$PROXY" && "$PROXY" != "off" ]]; then
    export HTTP_PROXY="$PROXY"
    export HTTPS_PROXY="$PROXY"
    export http_proxy="$PROXY"
    export https_proxy="$PROXY"
    export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
    export no_proxy="$NO_PROXY"
    echo "=== 使用代理 ${PROXY} ==="
fi

echo "=== 拉取 ${BRANCH} 分支 ==="
git fetch origin "$BRANCH"
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git checkout "$BRANCH"
else
    git checkout -B "$BRANCH" "origin/${BRANCH}"
fi
git pull --ff-only origin "$BRANCH"

echo "=== 构建镜像 ==="
docker compose build --pull

echo "=== 替换容器 ==="
docker compose up -d --force-recreate --remove-orphans

echo "=== 等待服务就绪 ==="
sleep 5

echo "=== 检查服务状态 ==="
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"; then
    echo "服务正常运行"
else
    echo "警告: 服务可能未就绪，请检查日志"
    docker logs check-cx --tail 20
fi

echo "=== 清理旧镜像 ==="
docker image prune -f

echo "=== 部署完成 ==="
