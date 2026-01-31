#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# gbcserver 一键部署脚本（面向小白 + 兼顾开发者）
#
# 最常用：
#   ./deploy.sh            # 等同于 ./deploy.sh up
#
# 其他命令：
#   ./deploy.sh up         # 初始化并启动（默认）
#   ./deploy.sh down       # 停止并移除容器
#   ./deploy.sh restart    # 重启
#   ./deploy.sh logs       # 跟踪日志
#   ./deploy.sh update     # 拉取最新代码后重新构建并启动（适合 git clone 用户）
#
# 需要：
#   Docker Desktop / Docker Engine
#   docker compose（或 docker-compose）
# ------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

CMD="${1:-up}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少依赖：$1"
    return 1
  fi
}

echo "[0/5] 检查 Docker..."
need_cmd docker || { echo "请先安装 Docker（Windows/macOS 推荐 Docker Desktop）。"; exit 1; }

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "未找到 docker compose / docker-compose，请先安装（Docker Desktop 通常自带）。"
  exit 1
fi

init_files() {
  echo "[1/5] 初始化目录与配置..."
  mkdir -p data tls

  if [ ! -f config.json ]; then
    cp config.example.json config.json
    echo "已生成 config.json（来自 config.example.json）"
  fi

  # 生成随机口令 / token，并写入 config.json（如果仍是占位符）
  python3 - <<'PY'
import json, secrets, string, pathlib, base64

def rand_str(n=32):
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(n))

def rand_base32(n_bytes=20):
    return base64.b32encode(secrets.token_bytes(n_bytes)).decode('utf-8').strip('=')

p = pathlib.Path("config.json")
cfg = json.loads(p.read_text(encoding="utf-8"))

changed = False

cfg.setdefault("server", {})
if str(cfg["server"].get("token","")).startswith("CHANGE_ME"):
    cfg["server"]["token"] = rand_str(48); changed = True

admin = cfg.setdefault("admin", {})
if str(admin.get("username","")).strip() == "":
    admin["username"] = "admin"; changed = True
if str(admin.get("password","")).startswith("CHANGE_ME"):
    admin["password"] = rand_str(20); changed = True
if str(admin.get("totpSecret","")).startswith(("BASE32_", "CHANGE_ME", "")):
    admin["totpSecret"] = rand_base32(20); changed = True

ports = cfg.setdefault("ports", {})
# 小白友好：默认非特权端口，避免 Linux 需要 sudo
if str(ports.get("http", "80")) in ("80",):
    ports["http"] = 8080; changed = True
if str(ports.get("https", "443")) in ("443",):
    ports["https"] = 8443; changed = True
# 插件端口也给默认
if "plugin" not in ports:
    ports["plugin"] = 8094; changed = True

tls = cfg.setdefault("tls", {})
tls.setdefault("enable", False)
tls.setdefault("keyPath", "/tls/server.key")
tls.setdefault("certPath", "/tls/server.pem")

runtime = cfg.setdefault("runtime", {})
runtime.setdefault("dataDir", "/data")

if changed:
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

print("\n==== 初始化完成（请妥善保存） ====")
print("管理后台账号：admin.username =", cfg["admin"]["username"])
print("管理后台密码：admin.password =", cfg["admin"]["password"])
print("管理员 TOTP 密钥：admin.totpSecret =", cfg["admin"]["totpSecret"])
print("服务端 token：server.token =", cfg["server"]["token"])
print("================================\n")
PY
}

up() {
  init_files
  echo "[2/5] 构建并启动容器..."
  $COMPOSE up -d --build

  echo "[3/5] 完成！"
  echo ""
  echo "访问（默认）："
  echo "  http://localhost:8080"
  echo ""
  echo "数据目录："
  echo "  ./data   （admin.json / whitelist.json / signData.json / shopItems.json / coupons.json 等）"
  echo ""
  echo "启用 HTTPS："
  echo "  1) 把证书放到 ./tls/server.key 与 ./tls/server.pem"
  echo "  2) 在 config.json 把 tls.enable 改为 true"
  echo "  3) 重新执行：./deploy.sh restart"
  echo ""
  echo "查看日志：./deploy.sh logs"
}

down() {
  echo "[1/1] 停止并移除容器..."
  $COMPOSE down
  echo "已停止。数据仍保留在 ./data"
}

restart() {
  echo "[1/2] 重启..."
  $COMPOSE restart
  echo "[2/2] 完成。"
}

logs() {
  echo "按 Ctrl+C 退出日志。"
  $COMPOSE logs -f --tail=200
}

update() {
  echo "提示：update 适合 git clone 用户（会 git pull）。如果你是下载 zip 的，请自行替换目录。"
  if command -v git >/dev/null 2>&1 && [ -d .git ]; then
    git pull --rebase
  else
    echo "当前目录不是 git 仓库或未安装 git，跳过拉取。"
  fi
  up
}

case "$CMD" in
  up) up ;;
  down) down ;;
  restart) restart ;;
  logs) logs ;;
  update) update ;;
  *)
    echo "未知命令：$CMD"
    echo "可用：up | down | restart | logs | update"
    exit 1
    ;;
esac
