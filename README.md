# gbcserver（Minecraft 私服综合管理 / 面板）

一个 **Node.js 后端 + 静态前端（`public/`）** 的轻量管理面板，用于管理玩家登录、白名单、签到、商店与兑换码等功能，并提供一个“插件交互端口”方便服务端插件对接。

> 面向两类人：  
> - **小白服主**：优先推荐 Docker 一键开服（复制粘贴即可）。  
> - **开发者**：提供完整配置说明、目录结构、接口说明与本地开发方式。

---

## 小白开服（推荐：Docker 一键部署，5 分钟）

### 0) 你需要准备什么
- 已安装 **Docker Desktop**（Windows/macOS）或 Docker Engine（Linux）
- 一台能跑 Docker 的机器（云服务器/本机都可以）

> 不会装 Docker？先装好再回来：  
> - Windows/macOS：Docker Desktop  
> - Linux：Docker Engine + docker compose 插件

### 1) 下载代码

**下载 zip**  
解压到任意目录即可。

### 2) 一键启动
在项目根目录执行：

```bash
chmod +x deploy.sh
./deploy.sh
```

脚本会自动帮你：
- 创建 `./data`（数据持久化）与 `./tls`（证书目录）
- 生成 `config.json`（若不存在）
- 自动生成随机的 **管理员密码 / TOTP 密钥 / server.token**
- 构建并启动 Docker 容器

启动成功后访问（默认）：
- 面板：`http://localhost:8080`

> 如果你是云服务器，把 `localhost` 换成你的服务器 IP。

### 3) 常用运维命令（只记这几个就够了）
```bash
./deploy.sh logs      # 看日志（排错最常用）
./deploy.sh restart   # 重启
./deploy.sh down      # 停止
```

---

## 小白常见问题（FAQ）

### 端口被占用怎么办？
编辑 `config.json` 里的端口（默认是 8080/8443/8094）：
```json
{
  "ports": { "http": 8080, "https": 8443, "plugin": 8094 }
}
```
改完执行：
```bash
./deploy.sh restart
```

### 我想用 80/443（不带端口访问）可以吗？
可以，但注意：
- Linux 上绑定 80/443 可能需要更高权限
- 更推荐用 **Nginx/Caddy 反代**到 8080/8443（更安全，也更常见）

### 怎么开启 HTTPS？
1) 准备证书文件（示例路径）：
- `./tls/server.key`
- `./tls/server.pem`

2) 修改 `config.json`：
```json
{
  "tls": {
    "enable": true,
    "keyPath": "/tls/server.key",
    "certPath": "/tls/server.pem"
  }
}
```

3) 重启：
```bash
./deploy.sh restart
```

> 没有证书也没关系：`tls.enable=false` 时只启 HTTP，不会报错。

### 邮箱验证码收不到 / 想开启邮箱功能
把 `config.json` 的 `mail` 填好（示例见下方“配置说明”），并确保：
- SMTP 主机/端口正确
- 你的邮箱服务允许 SMTP（部分需要“授权码”）
- `from` 格式正确（`"显示名" <email@xx.com>`）

### 数据会丢吗？我怎么备份？
不会（只要你不删 `./data`）。  
**备份方法：直接备份 `./data` 目录** 即可。

---

## 配置说明（小白只改必要项）

首次 `./deploy.sh` 会生成 `config.json`。你可以按需修改：

### 最重要的三项（强烈建议检查）
- `admin.username / admin.password`：管理后台账号密码
- `admin.totpSecret`：管理员二次验证密钥（用于 TOTP）
- `server.token`：服务端 token（用于接口鉴权/内部调用等 PS:用于对接兑换码插件）

### 完整配置字段（config.json）

> 支持两种方式：  
> 1) 直接改 `config.json`（最简单）  
> 2) 用环境变量覆盖（更适合生产部署/CI）

| 字段 | 类型 | 作用 | 默认/示例 |
|---|---|---|---|
| `ports.http` | number | HTTP 端口 | 8080 |
| `ports.https` | number | HTTPS 端口 | 8443 |
| `ports.plugin` | number | 插件交互端口 | 8094 |
| `runtime.dataDir` | string | 运行数据目录（容器内） | `/data` |
| `server.token` | string | 服务端 token（敏感） | 自动生成 |
| `admin.username` | string | 管理员用户名 | `admin` |
| `admin.password` | string | 管理员密码（敏感） | 自动生成 |
| `admin.totpSecret` | string | TOTP Base32 密钥（敏感） | 自动生成 |
| `tls.enable` | bool | 是否启用 HTTPS | `false` |
| `tls.keyPath` | string | TLS 私钥路径（容器内） | `/tls/server.key` |
| `tls.certPath` | string | TLS 证书路径（容器内） | `/tls/server.pem` |
| `mail.host` | string | SMTP 主机 | `smtp.example.com` |
| `mail.port` | number | SMTP 端口 | 465 |
| `mail.secure` | bool | SMTP 是否 SSL | `true` |
| `mail.user` | string | SMTP 用户名 | `your_smtp_user` |
| `mail.pass` | string | SMTP 密码/授权码（敏感） | `your_smtp_password` |
| `mail.from` | string | 发件人显示 | `"Server" <noreply@example.com>` |
| `mail.logoUrl` | string | 邮件里可选 Logo URL | `""` |
| `plugin.allowlist` | string[] | 允许访问插件端口的 IP 白名单 | `["127.0.0.1","::1"]` |
| `servers[]` | object[] | 服务器状态聚合显示用 | 见示例 |

---

## 安全建议（开公网前务必看）

- 插件端口（默认 8094）建议：
  - 只在内网使用，或
  - 配好 `plugin.allowlist` + 防火墙限制来源 IP。
- 管理员建议开启二次验证（本项目使用 TOTP；`admin.totpSecret` 即密钥）。
- 公网部署建议使用反代（Nginx/Caddy）并配置 HTTPS。

---

## 开发者指南

### 目录结构
```
.
├── whiteHitBlack.js          # 主服务：HTTP/HTTPS + API + 静态站点 + 插件端口
├── serverAutoRefers.js       # 可选：运行 mc.jar 并自动透传控制台输入（已弃用）
├── public/                   # 前端静态页面
├── config.example.json       # 配置示例（复制为 config.json）
├── deploy.sh                 # 一键部署脚本（Docker Compose）
├── docker-compose.yml        # Compose 定义（数据/证书挂载）
├── Dockerfile                # 容器镜像构建
└── data/                     #（运行后生成）业务数据持久化目录
```

### 本地开发（不使用 Docker）
> 适合二次开发/调试。生产环境更建议 Docker。

1) 安装依赖
```bash
npm install
```

2) 准备配置
```bash
cp config.example.json config.json
# 然后按需修改 config.json
```

3) 启动
```bash
node whiteHitBlack.js
```

> 若你需要热重载，可自行接入 nodemon（仓库默认未强制依赖）。

### 运行时数据文件说明（`runtime.dataDir`）
项目会在数据目录里读写（若不存在会自动创建）：
- `admin.json`：管理员信息（含哈希/密钥等）
- `whitelist.json` / `whitedata.json`：白名单/玩家数据
- `signData.json`：签到数据
- `shopItems.json`：商店数据
- `coupons.json`：兑换码数据
- `avatar/`：上传头像等静态资源

### HTTP API（前端调用）
以下接口在 `whiteHitBlack.js` 中实现（路径以 `/api/` 开头）：
- `POST /api/webLogin`：网页登录
- `GET  /api/userInfo`：用户信息
- `GET  /api/sign`：签到
- `GET  /api/signHistory`：签到历史
- `GET  /api/leaderboard`：排行榜/统计（视实现而定）
- `GET  /api/serverStatus`：服务器状态聚合
- `POST /api/uploadAvatar`：上传头像

> 具体请求/响应字段请以代码为准（建议开发者直接搜对应路由实现）。

### 插件交互端口（给 Minecraft 插件对接）
默认端口：`ports.plugin`（默认 8094）  
默认仅允许 `plugin.allowlist` 内 IP 访问（支持 IPv4-mapped IPv6）。

已实现的简单交互路由（HTTP）：
- `GET /`：测试连通
- `GET /change`：查询是否需要刷新（内部状态）
- `GET /check/<playerName>`：检查玩家是否允许进入
- `GET /login/<playerName>`：玩家登录上报
- `GET /logout/<playerName>`：玩家登出上报并结算在线时长

---
