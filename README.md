# WhiteHitBlack 服务端（白名单/用户/签到/积分商城/兑换码/服务器状态）

这是一个基于 **Node.js + Express** 的后端服务，提供：

- 用户注册/邮箱验证码验证/找回密码  
- 管理员登录（账号密码 + TOTP 动态验证码）与用户管理（激活/封禁/删除/改邮箱）  
- Minecraft 玩家在线白名单（JSON 文件）与在线时长统计  
- 网页端登录会话（session）  
- 签到系统（北京时间）+ 积分累计 + 排行榜  
- 积分商城（商品管理/兑换/生成兑换码/使用兑换码）  
- Minecraft 服务器状态检测（多 API 兜底 + 缓存）  
- Webhook 动态更新服务器端口  
- 插件交互 HTTP 服务（IP 白名单）

---

## ✨ 小白友好：一步步配置指南（推荐先看这个）

> 目标：让你**不懂后端也能跑起来**。按顺序做，基本不会踩坑。

### 0. 你需要准备什么？

- 一台电脑或服务器（Windows / Linux / macOS 都行）
- 已安装 Node.js（建议 **18+**）
- 一个可用的邮箱 SMTP（用于发验证码邮件）
- （可选）Python：当 `game.onlineMode=false` 时需要 `python getUuid.py <name>` 来生成 UUID

---

### 1. 把项目放到一个文件夹里

假设你的目录像这样：

```
whitehitblack/
  whiteHitBlack.js
```

打开终端/命令行，进入目录：

```bash
cd whitehitblack
```

---

### 2. 安装依赖（只需要做一次）

如果你还没有 `package.json`：

```bash
npm init -y
```

安装依赖：

```bash
npm i express body-parser nodemailer speakeasy
```

---

### 3. 第一次启动：让它自动生成 config.json

直接运行：

```bash
node whiteHitBlack.js
```

你会看到提示生成了 `config.json`，然后程序退出 —— 这是正常的（第一次就是用来生成配置文件的）。

---

### 4. 修改 config.json（最关键）

打开项目根目录的 `config.json`，重点先改这几块：

#### 4.1 端口（强烈建议开发/小白用 3000/3443）

```jsonc
"http": {
  "httpPort": 3000,
  "httpsPort": 3443,
  "pluginPort": 8094
}
```

> 说明：80/443 在 Linux 上通常需要管理员权限（root），小白先用 3000/3443 最省事。

#### 4.2 邮箱 SMTP（否则注册/找回密码发不出验证码）

在 `mail` 里改成你自己的 SMTP 信息：

```jsonc
"mail": {
  "host": "smtp.exmail.qq.com",
  "port": 465,
  "secure": true,
  "auth": {
    "user": "你的邮箱账号",
    "pass": "你的邮箱SMTP授权码/密码"
  },
  "fromName": "服务器官方",
  "fromAddress": "发件人邮箱（一般同user）",
  "verificationSubject": "邮箱验证"
}
```

**常见 SMTP 参考（示例，具体以邮箱服务商为准）：**
- QQ 邮箱：通常 `host=smtp.qq.com`，`port=465`，`secure=true`，密码是“SMTP 授权码”
- 腾讯企业邮箱：常见 `smtp.exmail.qq.com`
- 163 邮箱：常见 `smtp.163.com`（也多用授权码）
- Gmail：通常 `smtp.gmail.com`（需要应用专用密码/安全设置）

> 如果你不确定：先在邮箱后台开启 SMTP，并获取“授权码/应用密码”。

#### 4.3 管理员账号（必须改！）

默认管理员是 `admin/admin123`（非常危险）。请务必改掉：

```jsonc
"admin": {
  "default": {
    "username": "admin",
    "password": "换成强密码",
    "totpSecret": "换成新的TOTP密钥"
  }
}
```

##### 怎么生成一个新的 totpSecret？
你可以用 Node 在本机快速生成（任选一种）：

方式 A（推荐）：
```bash
node -e "console.log(require('speakeasy').generateSecret().base32)"
```

方式 B（随便生成也行，但建议用 speakeasy）：
```bash
node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"
```

> 生成后把结果填进 `totpSecret`。  
> 然后用 **Google Authenticator / Microsoft Authenticator / 1Password** 添加一个“手动输入密钥”的 TOTP 项目（6 位动态码）。

#### 4.4 serverToken（兑换码接口校验用，建议改成随机强字符串）

```jsonc
"security": {
  "serverToken": "换成一个很长的随机字符串"
}
```

---

### 5. 第二次启动：正式运行

```bash
node whiteHitBlack.js
```

你应该能看到 HTTP 服务启动日志（如果证书配置正确也会启动 HTTPS）。

测试一下（以 3000 为例）：

- 服务器状态：`GET http://127.0.0.1:3000/api/serverStatus`
- 排行榜：`GET http://127.0.0.1:3000/api/leaderboard`

---

### 6. （可选）启用 HTTPS

如果你想启用 HTTPS：

1) 准备证书文件：`server.key` 和 `server.pem`  
2) 在 `config.json` 配置：

```jsonc
"tls": { "keyPath": "server.key", "certPath": "server.pem" }
```

> 没有证书也没关系：程序会自动禁用 HTTPS，只启 HTTP。

---

### 7. （重要）插件交互端口要保护好

插件交互服务会监听 `pluginPort`（默认 8094），并检查来源 IP 是否在白名单 `plugin.allowedIPs` 中。

小白强烈建议：
- **只在内网使用**
- **防火墙禁止公网访问 8094**
- `allowedIPs` 只放你 Minecraft 服务器的内网 IP（以及对应的 `::ffff:` 形式）

---

## 目录

- [运行环境](#运行环境)
- [快速开始](#快速开始)
- [配置文件 config.json](#配置文件-configjson)
- [环境变量（推荐用于敏感信息）](#环境变量推荐用于敏感信息)
- [数据文件与目录结构](#数据文件与目录结构)
- [启动与端口说明](#启动与端口说明)
- [HTTPS/TLS 配置](#httpstls-配置)
- [API 接口概览](#api-接口概览)
- [插件交互服务说明](#插件交互服务说明)
- [安全建议](#安全建议)
- [常见问题](#常见问题)

---

## 运行环境

- Node.js **建议 18+**（代码使用了 `fetch`、`AbortSignal.timeout` 等特性）
- Python **可选**（当 `game.onlineMode=false` 时，会调用 `python getUuid.py <name>` 获取 UUID）
- 邮件 SMTP（用于发送验证码）
- Linux/Windows/macOS 均可运行（注意端口权限）

---

## 快速开始

### 1) 安装依赖

在项目根目录初始化并安装依赖（若你已有 package.json，可跳过 init）：

```bash
npm init -y
npm i express body-parser nodemailer speakeasy
```

---

### 2) 首次启动生成配置

直接启动：

```bash
node whiteHitBlack.js
```

首次运行如果找不到 `config.json`，程序会**自动生成默认配置**并退出，提示你修改后再启动。

---

### 3) 修改 config.json 后再次启动

```bash
node whiteHitBlack.js
```

---

## 配置文件 config.json

默认配置内置在代码中（`DEFAULT_CONFIG`），并支持你在 `config.json` 中覆盖（深度合并）。

### 配置加载逻辑

- 默认读取：`./config.json`
- 支持环境变量指定路径：`CONFIG_PATH=/path/to/config.json`
- 支持环境变量覆盖敏感项：SMTP_USER / SMTP_PASS / SERVER_TOKEN（强烈推荐）

---

### config.json 示例（建议从程序生成的默认文件改）

```jsonc
{
  "email": {
    "logoUrl": "https://image.010831.xyz/gbc/icon.jpg"
  },
  "files": {
    "whitelist": "whitelist.json",
    "whitedata": "whitedata.json",
    "admin": "admin.json",
    "signData": "signData.json",
    "shopItems": "shopItems.json",
    "coupons": "coupons.json"
  },
  "http": {
    "bodyLimit": "10mb",
    "staticDir": "public",
    "httpPort": 3000,
    "httpsPort": 3443,
    "pluginPort": 8094
  },
  "tls": {
    "keyPath": "server.key",
    "certPath": "server.pem"
  },
  "game": {
    "maxOnlineTimeMs": 3214080000000,
    "onlineMode": false
  },
  "admin": {
    "default": {
      "username": "admin",
      "password": "CHANGE_ME",
      "totpSecret": "CHANGE_ME"
    }
  },
  "mail": {
    "host": "smtp.exmail.qq.com",
    "port": 465,
    "secure": true,
    "auth": {
      "user": "CHANGE_ME@example.com",
      "pass": "CHANGE_ME"
    },
    "fromName": "嘎嘣脆服务器官方",
    "fromAddress": "CHANGE_ME@example.com",
    "verificationSubject": "邮箱验证"
  },
  "security": {
    "serverToken": "CHANGE_ME",
    "verificationCodeTtlMs": 300000,
    "adminSessionTtlMs": 3600000,
    "webSessionTtlMs": 3600000,
    "sessionBinding": {
      "admin": { "ip": false, "ua": false },
      "web": { "ip": false, "ua": false }
    }
  },
  "storage": {
    "avatarsDir": "avatars",
    "maxAvatarBytes": 10485760,
    "portsFile": "ports.json"
  },
  "webhook": {
    "updatePortPath": "/webhook/update-port"
  },
  "status": {
    "servers": [
      { "name": "电信线路", "host": "v4.242774835.xyz", "defaultPort": 1259 }
    ],
    "maxRetries": 3,
    "fetchTimeoutMs": 5000,
    "cacheTtlMs": 25000
  },
  "shop": {
    "couponLength": 10,
    "couponValidityMs": 259200000
  },
  "sign": {
    "timezoneOffsetHours": 8
  },
  "plugin": {
    "allowedIPs": [
      "127.0.0.1",
      "::1"
    ]
  }
}
```

---

### 配置项说明（开发者最常改的）

#### `http`
- `staticDir`：静态资源目录（默认 `public`，用于前端静态页面/图片等）
- `httpPort`：HTTP 端口（80 需要 root/管理员权限；开发建议改为 3000/8080）
- `httpsPort`：HTTPS 端口（443 同理）
- `pluginPort`：插件交互服务端口（强烈建议只在内网使用且防火墙屏蔽）

#### `tls`
- `keyPath` / `certPath`：TLS 证书路径；支持相对路径（相对项目根目录）
- 证书不存在会自动禁用 HTTPS，仅启动 HTTP

#### `mail`
用于发送验证码邮件（注册/找回密码等）。  
建议把 `auth.user`、`auth.pass` 放到环境变量中（见下文）。

#### `admin`
管理员登录使用：
- `username` / `password`
- `totpSecret`：TOTP 密钥（配合 Google Authenticator 等）  
> 若未配置 admin（或字段不完整），管理员登录功能不可用。

#### `security`
- `serverToken`：兑换码使用接口 `useCoupon` 会校验 token（用于防止被任意调用）
- `verificationCodeTtlMs`：邮箱验证码有效期（默认 5 分钟）
- `adminSessionTtlMs` / `webSessionTtlMs`：会话过期时间
- `sessionBinding`：是否绑定 IP / UA（更安全，但反代/网络变化可能导致误判）

#### `status`
服务器状态检测 API 使用多个第三方接口轮询，返回最快成功结果并缓存。  
- `servers`：服务器列表（name/host/defaultPort）
- `cacheTtlMs`：缓存有效期（毫秒）

#### `game.onlineMode`
- `true`：通过 Mojang 官方 API 获取 UUID
- `false`：通过本地执行 `python getUuid.py <name>` 获取 UUID（你需要提供 `getUuid.py`）

---

## 环境变量（推荐用于敏感信息）

代码支持用环境变量覆盖敏感项（推荐生产环境使用）：

```bash
export CONFIG_PATH=/path/to/config.json
export SMTP_USER="your_smtp_user"
export SMTP_PASS="your_smtp_pass"
export SERVER_TOKEN="your_strong_token"
node whiteHitBlack.js
```

Windows PowerShell：

```powershell
$env:CONFIG_PATH="C:\path\config.json"
$env:SMTP_USER="your_smtp_user"
$env:SMTP_PASS="your_smtp_pass"
$env:SERVER_TOKEN="your_strong_token"
node whiteHitBlack.js
```

---

## 数据文件与目录结构

程序会自动创建缺失的数据文件（首次启动很常见）：

- `whitedata.json`：用户数据库（数组）
- `whitelist.json`：白名单输出文件（数组）
- `signData.json`：签到/积分数据（对象）
- `shopItems.json`：商品列表（数组）
- `coupons.json`：兑换码列表（数组）
- `ports.json`：主机 -> 端口覆盖配置（对象）
- `avatars/`：头像上传存储目录
- `public/`：静态资源目录（手动）

> 注意：这些文件路径由 `config.files.*`、`config.storage.*` 控制，支持相对/绝对路径；相对路径默认相对项目根目录。

---

## 启动与端口说明

启动后通常会监听三个端口：

1. **HTTP 服务**：`httpPort`  
2. **HTTPS 服务**：`httpsPort`（证书存在才启用）  
3. **插件交互服务**：`pluginPort`  

建议开发环境把端口改为：`3000/3443/8094`。

---

## HTTPS/TLS 配置

如果你希望启用 HTTPS：

1) 准备证书文件，例如 `server.key` 和 `server.pem`  
2) 在 `config.json` 配置路径（支持相对/绝对路径）  
3) 证书缺失或读取失败时，程序会提示并自动禁用 HTTPS，仅启动 HTTP。

---

## API 接口概览

> 你的代码里同时存在“REST 风格接口”和“/api 单入口 query method 接口”。

### A. REST 风格接口

- `POST /api/uploadAvatar`  
  body: `{ username, avatar(base64 dataURL) }`  
  返回：`{ success, avatarUrl }`

- `GET /api/serverStatus`  
  返回服务器在线状态列表（多 API 兜底 + 缓存 + ports 覆盖）

- `POST /api/webLogin`  
  body: `{ username, password }`  
  返回：`{ success, session }`（网页端会话）

- `GET /api/userInfo?username=xxx`  
  返回用户 points/joinDate/onlineTime/lastLogin/avatar/serverStatus 等

- `GET /api/sign?username=xxx`  
  北京时间签到，返回奖励积分、连续天数、总天数等

- `GET /api/leaderboard`  
  排行榜：按积分 > 在线时长 > 用户名排序（前100）

- `GET /api/signHistory?username=xxx`  
  返回签到历史、连续天数、总天数、积分

- `GET /ports`  
  返回当前 `ports.json` 中的端口覆盖表

- `POST <webhook.updatePortPath>`（默认 `/webhook/update-port`）  
  body: `{ host, port }`  
  更新 ports.json 用于 serverStatus 查询时覆盖端口

---

### B. `/api` 单入口（query method）

统一入口：`app.all('/api', ...)`，通过 query 参数 `method=xxx` 选择功能。

#### 管理员相关（返回 JSON）
- `method=adminLogin&name=...&passwd=...&totp=...`
- `method=getAllUsers&session=...`
- `method=activateUser&name=...&session=...`
- `method=banUser&name=...&session=...`
- `method=unbanUser&name=...&session=...`
- `method=deleteUser&name=...&session=...`
- `method=updateEmail&name=...&newEmail=...&session=...`

#### 用户相关
- `method=login&name=...&passwd=...&time=毫秒(可选)`
- `method=logout&name=...&passwd=...`
- `method=regist&name=...&passwd=...&email=...`
- `method=verifyRegist&email=...&code=...`
- `method=repasswd&name=...&newpasswd=...`
- `method=verifyCode&email=...&code=...`
- `method=changePassword&name=...&oldpasswd=...&newpasswd=...`

#### 商城/兑换码
- `method=getShopItems`
- `method=addShopItem&session=...`（参数在 body 中）
- `method=updateShopItem`（body 中传 id/name/points/stock 等）
- `method=deleteShopItem&itemId=...`
- `method=purchaseItem&username=...&itemId=...`
- `method=generateCoupon&session=...`（参数在 body 中）
- `method=useCoupon&username=...&code=...&token=...`
- `method=getCoupons&session=...`
- `method=deleteCoupon&code=...&session=...`

---

## 插件交互服务说明

插件交互服务监听 `pluginPort`，并且**只允许 `config.plugin.allowedIPs` 中的来源 IP 访问**。

接口（均为 HTTP）：

- `GET /` 测试  
- `GET /change` 查询是否需要刷新  
- `GET /check/<name>` 查询玩家是否允许进入（在线列表中存在则 200，否则 404）  
- `GET /login/<name>` 插件通知玩家登录（刷新在线状态/开始计时）  
- `GET /logout/<name>` 插件通知玩家登出（结算在线时长，写入 whitedata.json）

> 重要：插件交互端口请勿转发到公网，防火墙请屏蔽。

---

## 安全建议

1) **务必修改默认管理员密码与 TOTP 密钥**  
2) `security.serverToken` 请设置为强随机字符串，并通过环境变量注入  
3) 插件端口 `pluginPort` 只允许内网访问（防火墙屏蔽公网入站）  
4) 生产环境建议启用 session 绑定（`sessionBinding.admin/web`）  
5) 建议把数据文件放到可备份路径（例如 `/data/...`），避免误删导致数据丢失

---

## 常见问题

### Q1：启动后提示生成了 config.json 并退出
正常行为：首次运行找不到配置文件，会生成默认配置并退出。修改配置后再启动即可。

### Q2：Node 版本低导致 fetch/AbortSignal 报错
升级到 Node 18+。

### Q3：onlineMode=false 时获取 UUID 失败
你需要提供 `getUuid.py`，并确保服务器安装 Python，且命令 `python getUuid.py <name>` 可执行。

### Q4：80/443 端口无法监听
Linux 上 1024 以下端口通常需要 root 权限。开发环境建议改用 3000/3443。
