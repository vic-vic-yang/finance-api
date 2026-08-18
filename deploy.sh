#!/usr/bin/env bash
# 司库后端 一键部署脚本（在服务器上、backend 目录下执行）
# 用法：chmod +x deploy.sh && sudo ./deploy.sh
set -e

echo "=============================================="
echo " 司库后端部署：装 Docker → 加 swap → 起服务"
echo "=============================================="

# ── 1. 安装 Docker（阿里云 Ubuntu 通用）──────────────
if ! command -v docker >/dev/null 2>&1; then
  echo ">>> 安装 Docker ..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo ">>> Docker 已安装，跳过"
fi

# ── 2. 加 2G swap（2核2G 内存防 OOM）──────────────
if [ ! -f /swapfile ]; then
  echo ">>> 加 2G swap ..."
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo ">>> swap 已存在，跳过"
fi

# ── 3. 生成 .env（强随机密钥，只生成一次）────────────
if [ ! -f .env ]; then
  echo ">>> 生成 .env ..."
  cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 12)
JWT_SECRET=$(openssl rand -base64 48)
SM_KEK=$(openssl rand -hex 16)
CORS_ORIGINS=https://finance.equitick.top
EOF
  echo ">>> .env 已生成（请记下下面打印的密钥）"
else
  echo ">>> .env 已存在，跳过（如需重新生成请先删除）"
fi

# ── 4. 启动后端 + 数据库 ─────────────────────────────
echo ">>> 构建并启动容器 ..."
docker compose up -d --build

# ── 5. 每日备份 cron（凌晨 3 点，保留 30 天）──────────
echo ">>> 配置每日备份 ..."
mkdir -p /backup
cat > /usr/local/bin/siku-backup.sh <<'EOF'
#!/bin/bash
cd "$(dirname "$0")/../.." 2>/dev/null || cd /root/finance/backend
set -a; . ./.env 2>/dev/null; set +a
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db pg_dump -U postgres finance 2>/dev/null | gzip > "/backup/finance_$(date +%F).sql.gz"
find /backup -name '*.sql.gz' -mtime +30 -delete 2>/dev/null
EOF
chmod +x /usr/local/bin/siku-backup.sh
(crontab -l 2>/dev/null | grep -v siku-backup; echo "0 3 * * * /usr/local/bin/siku-backup.sh") | crontab -

echo ""
echo "=============================================="
echo " 部署完成！"
echo "=============================================="
echo " 你的密钥（务必记下，丢失无法找回）："
grep -E '^(POSTGRES_PASSWORD|JWT_SECRET|SM_KEK)=' .env
echo ""
echo " 验证：curl http://localhost:3000/api/app/version"
echo " 查看日志：docker compose logs -f api"
