
## 这是什么？

一个用于 Minecraft 服务器的“综合管理系统”后端（Node.js）+ 简单静态页面（`public/`）：

- 玩家注册 / 登录 / 登出（基于本地 JSON 数据文件）
- 邮箱验证码注册 / 找回密码（Nodemailer）
- 管理员登录（TOTP 二次验证，Speakeasy）
- 兑换码生成 / 使用 / 管理
- 白名单、签到、商店等（以 JSON 文件方式存储）
- 服务器状态聚合查询（调用多个第三方状态 API）
- 额外的“插件交互端口”（默认 `8094`，支持 IP 白名单）

---

## 目录结构

```
.
├── whiteHitBlack.js          # 主服务（HTTP/HTTPS + API + 静态站点）
├── serverAutoRefers.js       # 运行 mc.jar 并自动透传控制台输入
├── getUuid.py                # 离线 UUID 生成小工具（Python）
├── public/                   # 前端静态页面
│   ├── index.html
│   ├── text.html
│   └── images/
│       └── logo.svg          # 占位 LOGO（请替换）
├── config.example.json       # 配置示例（复制为 config.json）
├── .env.example              # 环境变量示例
├── package.json
└── .gitignore                
```

---

## 运行环境

- Node.js **18+**（建议 LTS）
- npm（随 Node 自带）
- Python 3：用于运行 `getUuid.py`

---

## 一键跑起来（最推荐）

### 1）安装依赖

```bash
npm install
```

### 2）准备配置

复制配置模板：

```bash
cp config.example.json config.json
```

然后打开 `config.json`，至少把下面这些改掉：

- `server.token`：服务端令牌（用于 `useCoupon` 等需要“服务器鉴权”的接口）
- `mail.*`：邮箱 SMTP（不发邮件可以先留空，但相关功能会失败）
- `plugin.allowlist`：插件交互端口允许访问的 IP 白名单
- `servers`：你的服务器线路/地址列表（用于状态展示）
- `ports.*`：如果你不想用 80/443（需要 root），可以改成 8080/8443 等高端口

> 也可以不用 `config.json`，直接用环境变量覆盖（见下文）。

### 3）准备 HTTPS 证书（两种方案）

#### 方案 A：本地自签（开发/内网）

在项目根目录生成 `server.key` / `server.pem`：

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout server.key -out server.pem -days 365 \
  -subj "/CN=localhost"
```

然后确认 `config.json` 里的：

```json
"tls": { "keyPath": "server.key", "certPath": "server.pem" }
```

#### 方案 B：生产建议（Nginx/Caddy 终止 TLS）

生产环境通常让 Nginx/Caddy 做 HTTPS，Node 只跑 HTTP 高端口（更安全、更省事）：
- `ports.http` 改成 `8080`
- `ports.https` 可以先不用（或也改成高端口，只用于内网）

> 如果你完全不想开 HTTPS：可以把 `whiteHitBlack.js` 里创建 HTTPS 服务的那几行注释掉（最简单粗暴）。

### 4）启动

```bash
npm start
```

首次启动时，如果没有 `admin.json`，程序会**自动生成管理员账号信息**并打印在控制台。  
请务必：
1. 立即保存输出的初始密码/TOTP Secret
2. 立刻修改 `admin.json` 或用环境变量覆盖

---

## 用环境变量配置（可选）

本项目的配置优先级是：

> **环境变量 > `config.json` > 默认值**

环境变量名规则：把 `config` 的键 `a.b.c` 转成 `A_B_C`（全大写，`.` 变 `_`）。例如：

- `mail.host` → `MAIL_HOST`
- `ports.http` → `PORTS_HTTP`
- `plugin.allowlist` → `PLUGIN_ALLOWLIST`（**JSON 数组字符串**）
- `servers` → `SERVERS`（**JSON 数组字符串**）

你可以参考 `.env.example`，在 Linux 上这样设置：

```bash
export SERVER_TOKEN="CHANGE_ME"
export PORTS_HTTP=8080
export PLUGIN_ALLOWLIST='["127.0.0.1","::1"]'
export SERVERS='[{"name":"线路1","host":"example.com","defaultPort":25565}]'
npm start
```

---

## 管理员登录与 TOTP

管理员登录需要三样东西：

1. 管理员用户名
2. 管理员密码
3. TOTP 动态码（类似 Google Authenticator 的 6 位码）

### 1）获取 TOTP Secret

- 首次运行自动生成（控制台会打印）
- 或者你在 `admin.json` 里手动填 `totpSecret`（Base32）

### 2）把 Secret 导入到 Authenticator

在 Google Authenticator / Microsoft Authenticator / Authy 等 App 里：
- 选择“手动输入密钥”
- 账户名：随便（比如 `gbc-admin`）
- 密钥：`totpSecret` 的 Base32 字符串
- 类型：基于时间（TOTP）

之后 App 会每 30 秒刷新一次 6 位动态码。

---

## 数据文件说明

程序运行过程中会在根目录生成一些 JSON 文件作为“数据库”，例如：

- `whitedata.json`：玩家数据（含邮箱、密码等）
- `whitelist.json`：白名单
- `coupons.json`：兑换码
- `shopItems.json`：商店物品
- `signData.json`：签到数据
- `admin.json`：管理员账号/密码/TOTP Secret（最敏感）

---

## 常见问题（FAQ）

### Q1：为什么启动失败，说 80/443 权限不够？
80/443 是“特权端口”，Linux 下需要 root 才能绑定。

解决方式：
- 推荐：把 `config.json` 里的 `ports.http/ports.https` 改成 `8080/8443` 这种高端口
- 或者：用 Nginx/Caddy 监听 80/443，再反向代理到 Node 高端口
- 不建议：直接用 root 跑 Node

### Q2：我不想发邮件，能用吗？
能启动，但涉及“注册/改密/验证码”的功能会失败。  
如果要用这些功能，请正确填写 `mail.host/user/pass/from`。

### Q3：插件交互端口安全吗？
默认只允许 `plugin.allowlist` 里的 IP 访问。请务必：
- 不要把 `ports.plugin` 直接暴露到公网
- 防火墙屏蔽该端口
- 白名单只写内网/本机地址

---