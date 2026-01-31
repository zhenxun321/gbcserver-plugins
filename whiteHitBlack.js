const express = require('express');
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require('path');
const playerSessions = new Map();
const webSessions = new Map();
const sub_process = require('child_process');
const { promisify } = require('util');
const exec = promisify(sub_process.exec);
const nodemailer = require('nodemailer');
const speakeasy = require('speakeasy');
const bodyParser = require('body-parser');
const crypto = require('crypto');

// =============================
// 配置加载（优先级：环境变量 > config.json > 默认值）
// =============================
const CONFIG_PATH = process.env.CONFIG_PATH || 'config.json';

let fileConfig = {};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
} catch (e) {
  console.warn('[WARN] 读取 config.json 失败，将使用环境变量/默认值：', e.message);
}

function cfg(key, defaultValue) {
  // key 支持 'a.b.c'
  const fromEnv = process.env[key.toUpperCase().replace(/\./g, '_')];
  if (fromEnv !== undefined) return fromEnv;

  const seg = key.split('.');
  let cur = fileConfig;
  for (const s of seg) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, s)) cur = cur[s];
    else { cur = undefined; break; }
  }
  return (cur === undefined || cur === null || cur === '') ? defaultValue : cur;
}

function cfgJson(key, defaultValue) {
  const v = cfg(key, undefined);
  if (v === undefined) return defaultValue;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return defaultValue; }
  }
  return v;
}

function genRandomPassword(len = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+=';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}


const EMAIL_LOGO_URL = cfg('mail.logoUrl', '');
const whitelistFile = "whitelist.json";
const whitedataFile = "whitedata.json";
const adminFile = "admin.json";
const signDataFile = "signData.json";
const shopItemsFile = "shopItems.json";
const couponsFile = "coupons.json";
const serverStatusCache = new Map();
const SERVER_TOKEN = cfg('server.token', '');
const net = require('net');
const STATUS_APIS = [
    {
        name: 'api.mcsrvstat.us',
        url: (host, port) => `https://api.mcsrvstat.us/3/${host}:${port}`,
        parser: data => ({
            online: data.online || false,
            players: {
                online: data.players?.online || 0,
                max: data.players?.max || 0
            },
            version: data.version || '未知',
            motd: data.motd?.clean?.join('\n') || ''
        })
    },
    {
        name: 'mcapi.us',
        url: (host, port) => `https://mcapi.us/server/status?ip=${host}&port=${port}`,
        parser: data => ({
            online: data.online || false,
            players: {
                online: data.players?.now || 0,
                max: data.players?.max || 0
            },
            version: data.server?.name || '未知',
            motd: data.motd || ''
        })
    },
    {
        name: 'api.minetools.eu',
        url: (host, port) => `https://api.minetools.eu/ping/${host}/${port}`,
        parser: data => {
            const online = !!(!data || !data.error);

            const players = {
                online: toNumberSafe(data?.players?.online ?? data?.players),
                max: toNumberSafe(data?.players?.max)
            };

            let version = '未知';
            if (data && data.version) {
                if (typeof data.version === 'object') {
                    version = data.version.name || data.version.text || JSON.stringify(data.version);
                } else {
                    version = String(data.version);
                }
                version = cleanMinecraftText(version);
            }

            const motdRaw = data?.description ?? data?.motd ?? '';
            const motd = cleanMinecraftText(motdRaw);

            return {
                online,
                players,
                version: version || '未知',
                motd: motd || ''
            };
        }
    }
];
// 创建Express应用
const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // 使用静态目录public

const maxOnlineTime = 1000 * 60 * 60 * 24 * 31 * 12 * 100;
const onlineMode = false;

// 确保admin.json文件存在并初始化（⚠️开源版不写死默认密码/密钥）
if (!fs.existsSync(adminFile)) {
    const defaultUser = cfg('admin.username', 'admin');
    const defaultPass = cfg('admin.password', genRandomPassword(18));
    const defaultSecret = cfg('admin.totpSecret', speakeasy.generateSecret({ length: 20 }).base32);

    fs.writeFileSync(adminFile, JSON.stringify({
        username: defaultUser,
        password: defaultPass,
        totpSecret: defaultSecret
    }, null, 2));

    console.log(`已创建管理员配置文件: ${adminFile}`);
    console.log(`[IMPORTANT] 初始管理员账号: ${defaultUser}`);
    console.log(`[IMPORTANT] 初始管理员密码: ${defaultPass}`);
    console.log(`[IMPORTANT] 初始TOTP Secret(Base32): ${defaultSecret}`);
    console.log(`[IMPORTANT] 请立刻修改 admin.json 或通过环境变量覆盖，并确保不要把 admin.json 提交到仓库。`);
}

// 确保whitedata.json文件存在并初始化
if (!fs.existsSync(whitedataFile)) {
    fs.writeFileSync(whitedataFile, "[]");
    console.log(`已创建空用户数据文件: ${whitedataFile}`);
}

// 确保whitelist.json文件存在并初始化
if (!fs.existsSync(whitelistFile)) {
    fs.writeFileSync(whitelistFile, "[]");
    console.log(`已创建空白名单文件: ${whitelistFile}`);
}

// 确保签到数据文件存在
if (!fs.existsSync(signDataFile)) {
    fs.writeFileSync(signDataFile, "{}");
    console.log(`已创建签到数据文件: ${signDataFile}`);
}
// 确保商品数据文件存在
if (!fs.existsSync(shopItemsFile)) {
    fs.writeFileSync(shopItemsFile, "[]");
    console.log(`已创建商品数据文件: ${shopItemsFile}`);
}

// 确保兑换码数据文件存在
if (!fs.existsSync(couponsFile)) {
    fs.writeFileSync(couponsFile, "[]");
    console.log(`已创建兑换码数据文件: ${couponsFile}`);
}
// 邮件配置
const transporter = nodemailer.createTransport({
    host: 'smtp.exmail.qq.com',
    port: 465,
    secure: true,
    auth: {
        user: '',
        pass: ''
    },
});

// 验证码存储
const verificationCodes = new Map();
const adminSessions = new Map();

function loger(str) {
    console.log(`[${new Date().toLocaleTimeString()}] ${str}`);
}
// 添加：生成随机会话ID
function generateSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}
// 发送验证邮件
async function sendVerificationEmail(email, code) {
    const mailOptions = {
        from: cfg('mail.from', '"Server" <noreply@example.com>'),
        to: email,
        subject: '邮箱验证',
        html: `<!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { text-align: center; margin-bottom: 30px; }
                    .logo { max-width: 200px; height: auto; }
                    .code { 
                        font-size: 24px; 
                        font-weight: bold; 
                        letter-spacing: 5px; 
                        text-align: center;
                        margin: 30px 0;
                        padding: 15px;
                        background-color: #f5f5f5;
                        border-radius: 5px;
                    }
                    .footer { 
                        margin-top: 30px; 
                        text-align: center; 
                        color: #888;
                        font-size: 12px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <img src="${EMAIL_LOGO_URL}" alt="服务器Logo" class="logo">
                        <h1>嘎嘣脆の小服</h1>
                    </div>
                    
                    <p>尊敬的玩家，您的验证码为：</p>
                    <div class="code">${code}</div>
                    <p>有效期5分钟，请尽快使用。</p>
                    
                    <div class="footer">
                        <p>此为系统自动发送邮件，请勿回复</p>
                        <p>© ${new Date().getFullYear()} 嘎嘣脆服务器官方</p>
                    </div>
                </div>
            </body>
            </html>`
    };
    mailOptions.text = `您的验证码为：${code}，有效期为5分钟。`;
    try {
        await transporter.sendMail(mailOptions);
        loger(`验证码已发送至 ${email}`);
        return true;
    } catch (error) {
        loger(`发送邮件失败: ${error}`);
        return false;
    }
}

// 生成随机验证码
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function getUuid(name) {
    if (onlineMode) {
        try {
            const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${name}`);
            if (!response.ok) {
                console.log("获取UUID失败，检查网络配置: " + response.statusText);
                return null;
            }
            const data = await response.json();
            loger(`玩家 ${name} 的UUID：${data.id}`);
            return data.id;
        } catch (error) {
            console.error("执行命令时出错: " + error);
            return null;
        }
    } else {
        try {
            const { stdout, stderr } = await exec(`python getUuid.py ${name}`);
            if (stderr) {
                console.log("获取UUID失败，请确认python和getUuid.py文件是否存在: " + stderr);
                return null;
            }
            loger(`玩家 ${name} 的UUID：${stdout.trim()}`);
            return stdout.trim();
        } catch (error) {
            console.error("执行命令时出错: " + error);
            return null;
        }
    }
}

function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const remainingSeconds = seconds % 60;
    const remainingMinutes = minutes % 60;
    const remainingHours = hours % 24;
    const parts = [];
    if (days > 0) {
        parts.push(`${days}天`);
    }
    if (remainingHours > 0) {
        parts.push(`${remainingHours}小时`);
    }
    if (remainingMinutes > 0) {
        parts.push(`${remainingMinutes}分钟`);
    }
    if (remainingSeconds > 0) {
        parts.push(`${remainingSeconds}秒`);
    }
    return parts.join(' ');
}

let haveChange = false;
let queryChange = false;
let onlinePlayer = new Map();
onlinePlayer.clear();

setInterval(() => {
    onlinePlayer.forEach((value, key) => {
        if (value.onlineTime <= Date.now()) {
            haveChange = true;
            queryChange = true;
            onlinePlayer.delete(key);

            // 自动登出时更新在线时长
            try {
                const players = JSON.parse(fs.readFileSync(whitedataFile));
                const playerIndex = players.findIndex(p => p.name === key);
                if (playerIndex !== -1) {
                    const loginTime = getPlayerLoginTime(key);
                    const sessionTime = Date.now() - loginTime;
                    players[playerIndex].onlineTime = (players[playerIndex].onlineTime || 0) + sessionTime;
                    players[playerIndex].lastLogin = new Date().toLocaleString();
                    fs.writeFileSync(whitedataFile, JSON.stringify(players));
                    loger(`[自动登出] 玩家 ${key} 在线时长更新: +${formatTime(sessionTime)}`);
                }
            } catch (error) {
                console.error("自动登出更新在线时长错误:", error);
            }
        }
    });
    if (haveChange) {
        let temp = [];
        onlinePlayer.forEach((value, key) => {
            temp.push({
                name: key,
                uuid: value.uuid
            });
        });
        fs.writeFile(whitelistFile, JSON.stringify(temp), (err) => {
            haveChange = false;
            if (err) {
                console.error(`白名单文件写入失败，请检查权限和文件位置 ${new Date().toLocaleTimeString()} ：${err}`);
            } else {
                console.log(`白名单文件已写入 ${new Date().toLocaleTimeString()}`);
            }
        });
    }
}, 1000);

const httpsOptions = {
    key: fs.readFileSync(cfg('tls.keyPath', "server.key")),
    cert: fs.readFileSync(cfg('tls.certPath', "server.pem"))
};

// 创建avatars目录
const avatarsDir = path.join(__dirname, 'avatars');
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir);
}
// 头像上传接口
app.post('/api/uploadAvatar', async (req, res) => {
    const { username, avatar } = req.body;
    if (!username || !avatar) {
        return res.status(400).json({ success: false, message: '参数错误' });
    }
    const base64Data = avatar.replace(/^data:image\/\w+;base64,/, "");
    if (base64Data.length > 10 * 1024 * 1024) { // 10MB
        return res.status(400).json({ success: false, message: '头像图片过大，请压缩后上传' });
    }
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `${username}_${Date.now()}.png`;
    const filePath = path.join(avatarsDir, fileName);

    try {
        await fs.promises.writeFile(filePath, buffer);

        // 更新用户数据
        const players = JSON.parse(fs.readFileSync(whitedataFile));
        const playerIndex = players.findIndex(p => p.name === username);
        if (playerIndex === -1) {
            return res.status(404).json({ success: false, message: '用户不存在' });
        }

        players[playerIndex].avatarPath = filePath;
        fs.writeFileSync(whitedataFile, JSON.stringify(players));

        res.json({ success: true, avatarUrl: `/avatars/${fileName}` });
    } catch (error) {
        res.status(500).json({ success: false, message: '上传失败' });
    }
});

// 头像访问接口
app.use('/avatars', express.static(avatarsDir));
// Webhook端口更新接口
let portConfig = {};

app.post('/webhook/update-port', (req, res) => {
    try {
        const { host, port } = req.body;
        if (host && port) {
            // 读取当前端口配置
            let portConfig = {};
            if (fs.existsSync('ports.json')) {
                portConfig = JSON.parse(fs.readFileSync('ports.json'));
            }

            // 更新指定主机的端口
            portConfig[host] = port;
            fs.writeFileSync('ports.json', JSON.stringify(portConfig));

            res.sendStatus(200);
            loger(`Webhook端口更新: ${host} -> ${port}`);
        } else {
            res.status(400).send('Invalid parameters');
        }
    } catch (error) {
        res.status(400).send('Invalid JSON');
    }
});
function toNumberSafe(val) {
    if (val == null) return 0;
    if (typeof val === 'object') {
        // 如果是对象，尝试从常见字段里取数字
        if ('online' in val) return toNumberSafe(val.online);
        if ('raw' in val) return toNumberSafe(val.raw);
        if ('text' in val) return parseInt(val.text, 10) || 0;
        return 0;
    }
    const num = parseInt(val, 10);
    return isNaN(num) ? 0 : num;
}
function cleanMinecraftText(raw) {
    if (!raw && raw !== 0) return '';
    // 兼容数组或对象
    if (Array.isArray(raw)) {
        raw = raw.join('\n');
    } else if (typeof raw === 'object') {
        // 常见结构可能为 { text: "..."} 或 { extra: [...] } 等
        if (raw.text) raw = raw.text;
        else if (raw.extra && Array.isArray(raw.extra)) {
            raw = raw.extra.map(e => (typeof e === 'string' ? e : (e.text || ''))).join('');
        } else {
            raw = JSON.stringify(raw);
        }
    } else {
        raw = String(raw);
    }
    // 1) 去掉 §x 这类格式码（§ 后面紧跟一个字符）
    raw = raw.replace(/§./g, '');
    // 2) 去掉不可见控制字符（除了换行先保留，再统一空格化）
    raw = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    // 3) 保留中文、字母、数字、空格、常见标点和连字符（保留多连字符 '---'）
    //    （如果你希望保留更多符号可在 [] 内添加）
    raw = raw.replace(/[^\p{Script=Han}\p{L}\p{N}\s\-_,:.()\[\]【】<>\/\\!?~`'"—–]/gu, '');
    // 4) 合并连续空白并 trim
    raw = raw.replace(/\s+/g, ' ').trim();
    return raw;
}
// 添加后端服务器状态检测API
app.get('/api/serverStatus', async (req, res) => {
    try {
        // 确保读取最新的端口配置
        if (fs.existsSync('ports.json')) {
            portConfig = JSON.parse(fs.readFileSync('ports.json'));
        } else {
            portConfig = {};
        }

        // 服务器列表（建议放在 config.json / 环境变量中）
        const servers = cfgJson('servers', [
            { name: '示例线路1', host: 'example.com', defaultPort: 25565 },
            { name: '示例线路2', host: 'example.net', defaultPort: 25565 }
        ]);

        // 检测所有服务器状态
        const serverStatuses = await Promise.all(servers.map(async server => {
            // 优先使用配置中的端口，没有则用默认端口
            const port = portConfig[server.host] || server.defaultPort;
            try {
                const status = await getServerStatus(server.host, port);
                return {
                    name: server.name,
                    host: server.host,
                    port, // 返回实际使用的端口
                    ...status
                };
            } catch (error) {
                return {
                    name: server.name,
                    host: server.host,
                    port,
                    online: false,
                    error: error.message
                };
            }
        }));

        res.json({ success: true, servers: serverStatuses });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取服务器状态失败' });
    }
});

// 服务器状态检测函数
async function getServerStatus(host, port) {
    const cacheKey = `${host}:${port}`;
    const cachedStatus = serverStatusCache.get(cacheKey);

    // 缓存预热：提前刷新即将过期的缓存
    if (cachedStatus && Date.now() - cachedStatus.timestamp < 25000) {
        return cachedStatus.data;
    }

    // 尝试所有API
    const apiPromises = STATUS_APIS.map(api =>
        fetchWithRetry(api.url(host, port), api.parser, api.name, 3)
    );

    try {
        // 获取最快的有效响应
        const result = await Promise.any(apiPromises);

        // 更新缓存
        serverStatusCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        return result;
    } catch (error) {
        loger(`所有API检测均失败: ${error.message}`);

        // 尝试直接端口探测
        try {
            const isReachable = await probePortWithRetry(host, port, 3);
            if (isReachable) {
                const result = {
                    online: true,
                    players: { online: 0, max: 0 },
                    version: '服务可达但未获取详情',
                    motd: '直接端口探测成功',
                    error: null
                };

                serverStatusCache.set(cacheKey, {
                    data: result,
                    timestamp: Date.now()
                });

                return result;
            }
        } catch (portError) {
            loger(`直接端口探测失败: ${portError.message}`);
        }

        // 返回最终失败状态
        return {
            online: false,
            players: { online: 0, max: 0 },
            version: '未知',
            motd: '',
            error: '所有检测方法均失败'
        };
    }
}

// 带重试的API请求函数
async function fetchWithRetry(url, parser, apiName, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) {
                throw new Error(`${apiName}请求失败(状态码:${response.status})`);
            }

            const data = await response.json();
            return parser(data);
        } catch (error) {
            loger(`[${apiName} 尝试${attempt}/${maxRetries}] 失败: ${error.message}`);

            if (attempt < maxRetries) {
                // 指数退避策略
                const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw new Error(`${apiName}所有尝试均失败`);
            }
        }
    }
}

// 带重试的端口探测
async function probePortWithRetry(host, port, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            loger(`尝试端口探测(${attempt}/${maxRetries}): ${host}:${port}`);
            const isReachable = await probePort(host, port);
            return isReachable;
        } catch (error) {
            loger(`端口探测失败: ${error.message}`);

            if (attempt < maxRetries) {
                // 随机延迟避免同步请求
                const delay = 500 + Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error(`所有端口探测尝试均失败`);
}

// 优化端口探测函数
function probePort(host, port) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let timeoutId;

        const cleanup = () => {
            clearTimeout(timeoutId);
            socket.destroy();
        };

        socket.on('connect', () => {
            cleanup();
            resolve(true);
        });

        socket.on('error', (err) => {
            cleanup();
            resolve(false);
        });

        socket.connect(port, host);

        timeoutId = setTimeout(() => {
            cleanup();
            resolve(false);
        }, 5000);
    });
}
// 端口配置接口
app.get('/ports', (req, res) => {
    try {
        if (fs.existsSync('ports.json')) {
            portConfig = JSON.parse(fs.readFileSync('ports.json'));
        } else {
            portConfig = {};
        }
        res.json(portConfig);
    } catch (error) {
        res.status(500).send('Internal Server Error');
    }
});
// 修改：添加新的网页登录API
app.post('/api/webLogin', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: "用户名和密码不能为空" });
    }

    try {
        const players = JSON.parse(fs.readFileSync(whitedataFile));
        const player = players.find(p => p.name === username);

        if (!player) {
            return res.json({ success: false, message: "用户不存在" });
        }

        if (player.status === "banned") {
            return res.json({ success: false, message: "账号已被封禁" });
        }

        if (player.status === "inactive") {
            return res.json({ success: false, message: "账号未激活" });
        }

        if (player.passwd === password) {
            // 更新最后登录时间
            player.lastLogin = new Date().toLocaleString();
            fs.writeFileSync(whitedataFile, JSON.stringify(players));

            // 创建网页会话
            const sessionId = generateSessionId();
            webSessions.set(sessionId, {
                username: username,
                expire: Date.now() + 3600000 // 1小时有效期
            });

            return res.json({
                success: true,
                session: sessionId,
                message: "登录成功"
            });
        } else {
            return res.json({ success: false, message: "密码错误" });
        }
    } catch (error) {
        console.error("网页登录错误:", error);
        return res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});
// 添加获取用户信息API
app.get('/api/userInfo', (req, res) => {
    const username = req.query.username;
    if (!username) {
        return res.status(400).json({ success: false, message: "用户名不能为空" });
    }

    try {
        const users = JSON.parse(fs.readFileSync(whitedataFile, 'utf8'));
        const user = users.find(u => u.name === username);
        if (!user) {
            return res.json({ success: false, message: "用户不存在" });
        }
        // 添加：检查服务器登录状态
        const serverStatus = onlinePlayer.has(username) ? "online" : "offline";
        // 从用户数据中提取所需信息
        const { points, joinDate, onlineTime, lastLogin } = user;
        res.json({
            success: true,
            points,
            joinDate,
            onlineTime,
            lastLogin,
            avatarPath: user.avatarPath ? `/avatars/${path.basename(user.avatarPath)}` : null,
            serverStatus: serverStatus // 添加服务器状态字段
        });
    } catch (error) {
        console.error("获取用户信息错误:", error);
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});
// 修改签到API处理逻辑
app.get('/api/sign', async (req, res) => {
    const username = req.query.username;
    console.log(`签到请求: ${username}`);

    if (!username) {
        return res.status(400).json({ success: false, message: "用户名不能为空" });
    }

    try {
        // 确保文件存在
        if (!fs.existsSync(signDataFile)) {
            fs.writeFileSync(signDataFile, "{}");
        }

        // 读取签到数据
        let signData = {};
        try {
            const data = fs.readFileSync(signDataFile, 'utf8');
            signData = JSON.parse(data);
        } catch (e) {
            console.error("解析签到数据文件错误:", e);
            signData = {};
        }

        // 获取北京时间今天日期 (YYYY-MM-DD)
        const today = new Date();
        const beijingTime = new Date(today.getTime() + (8 * 60 * 60 * 1000)); // UTC+8
        const todayStr = beijingTime.toISOString().split('T')[0].substring(0, 10);

        // 检查用户数据是否存在
        if (!signData[username]) {
            signData[username] = {
                totalDays: 0,
                consecutiveDays: 0,
                lastSign: "",
                signHistory: {},
                points: 0
            };
        }

        // 检查今日是否已签到
        if (signData[username].signHistory[todayStr]) {
            return res.json({ success: false, message: "今天已经签到过了" });
        }

        // 计算连续签到天数（关键修复）
        let consecutiveDays = 1;
        const lastSignDate = signData[username].lastSign;

        if (lastSignDate) {
            // 转换为北京时间对象
            const lastDate = new Date(lastSignDate + "T00:00:00+08:00");
            const timeDiff = beijingTime - lastDate;
            const daysDiff = Math.floor(timeDiff / (1000 * 60 * 60 * 24));

            console.log(`日期计算: 上次签到 ${lastSignDate}, 今天 ${todayStr}, 天数差: ${daysDiff}`);

            // 如果是连续签到（昨天签到）
            if (daysDiff === 1) {
                consecutiveDays = signData[username].consecutiveDays + 1;
            }
            // 如果超过1天，重置连续天数
            else if (daysDiff >= 2) {
                consecutiveDays = 1;
                console.log(`连续签到重置`);
            }
        }

        // 计算奖励积分 (10基础分 + 连续天数奖励)
        const basePoints = 10;
        const consecutiveBonus = Math.min(consecutiveDays, 7) * 5;
        const points = basePoints + consecutiveBonus;

        // 更新签到数据
        signData[username].totalDays++;
        signData[username].consecutiveDays = consecutiveDays;
        signData[username].lastSign = todayStr;
        signData[username].signHistory[todayStr] = true;
        signData[username].points += points;

        // 保存签到数据
        try {
            fs.writeFileSync(signDataFile, JSON.stringify(signData, null, 2));
            console.log(`签到数据已保存: ${username} 于 ${todayStr}`);
            console.log(`用户积分已更新: ${username} +${points}分，总积分: ${signData[username].points}`);
            console.log(`连续签到天数: ${consecutiveDays}`);

            return res.json({
                success: true,
                message: "签到成功",
                points: points,
                totalPoints: signData[username].points,
                consecutiveDays: consecutiveDays,
                totalDays: signData[username].totalDays
            });
        } catch (err) {
            console.error("写入签到数据文件失败:", err);
            return res.status(500).json({ success: false, message: "写入签到数据失败" });
        }
    } catch (error) {
        console.error("签到系统错误:", error);
        return res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});
// 修改点7：更新排行榜API，添加积分计算
app.get('/api/leaderboard', (req, res) => {
    try {
        // 读取用户数据
        const players = JSON.parse(fs.readFileSync(whitedataFile, 'utf8'));
        // 读取签到数据
        let signData = {};
        if (fs.existsSync(signDataFile)) {
            signData = JSON.parse(fs.readFileSync(signDataFile, 'utf8'));
        }

        // 构建排行榜数据
        const leaderboardData = players
            .filter(player => player.status === "active") // 只包含激活用户
            .map(player => {
                const userSignData = signData[player.name] || {};
                return {
                    name: player.name,
                    avatar: player.avatarPath ? `/avatars/${path.basename(player.avatarPath)}` : null,
                    onlineTime: player.onlineTime || 0,
                    lastLogin: player.lastLogin,
                    consecutiveDays: userSignData.consecutiveDays || 0,
                    points: userSignData.points || 0 // 添加积分字段
                };
            })
            // 排序：积分 > 在线时长 > 用户名
            .sort((a, b) => {
                if (b.points !== a.points) return b.points - a.points;
                if (b.onlineTime !== a.onlineTime) return b.onlineTime - a.onlineTime;
                return a.name.localeCompare(b.name);
            })
            .slice(0, 100); // 只取前100名

        res.json({ success: true, players: leaderboardData });
    } catch (error) {
        console.error("获取排行榜数据错误:", error);
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

// 修改后的签到历史API
app.get('/api/signHistory', (req, res) => {
    const username = req.query.username;
    if (!username) {
        return res.status(400).json({ success: false, message: "用户名不能为空" });
    }

    try {
        let signData = {};
        if (fs.existsSync(signDataFile)) {
            signData = JSON.parse(fs.readFileSync(signDataFile, 'utf8'));
        }

        const userData = signData[username] || {};
        return res.json({
            success: true,
            signHistory: userData.signHistory || {},
            consecutiveDays: userData.consecutiveDays || 0,
            totalDays: userData.totalDays || 0,
            points: userData.points || 0 // 添加积分字段
        });
    } catch (error) {
        console.error("获取签到历史错误:", error);
        return res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});
// 在文件顶部添加辅助函数
function getPlayerLoginTime(name) {
    if (playerSessions.has(name)) {
        return playerSessions.get(name);
    }
    if (onlinePlayer.has(name)) {
        return onlinePlayer.get(name).loginTime;
    }
    return Date.now(); // 默认返回当前时间
}
// 在文件顶部添加日期格式化函数
function formatDate(date) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}
// 修复文件读取逻辑
function readCouponsFile() {
    try {
        if (fs.existsSync(couponsFile)) {
            const data = fs.readFileSync(couponsFile, 'utf8');
            return JSON.parse(data);
        }
        return [];
    } catch (error) {
        console.error('读取兑换码文件错误:', error);
        return [];
    }
}

function writeCouponsFile(data) {
    try {
        fs.writeFileSync(couponsFile, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('写入兑换码文件错误:', error);
        return false;
    }
}
// API请求处理
app.all('/api', async (req, res) => {
    const p = req.query;

    // 检查参数
    for (let key in p) {
        if (p[key].indexOf(" ") != -1) {
            return res.status(400).send("禁止传入空格！");
        }
    }
    if (p.uuid) {
        return res.status(400).send("禁止传入UUID！");
    }
    if (p.loginTime || p.onlineTime) {
        return res.status(400).send("禁止传入时间参数！");
    }

    // 管理员登录
    if (p.method == "adminLogin" && p.name && p.passwd && p.totp) {
        try {
            if (!fs.existsSync(adminFile)) {
                const defaultUser = cfg('admin.username', 'admin');
                const defaultPass = cfg('admin.password', genRandomPassword(18));
                const defaultSecret = cfg('admin.totpSecret', speakeasy.generateSecret({ length: 20 }).base32);

                fs.writeFileSync(adminFile, JSON.stringify({
                    username: defaultUser,
                    password: defaultPass,
                    totpSecret: defaultSecret
                }));

                console.log(`[IMPORTANT] admin.json 不存在，已自动生成。请尽快修改管理员密码并避免提交到仓库。`);
            }

            const adminData = JSON.parse(fs.readFileSync(adminFile));

            if (p.name !== adminData.username || p.passwd !== adminData.password) {
                return res.json({ success: false, message: "管理员账号或密码错误" });
            }

            const verified = speakeasy.totp.verify({
                secret: adminData.totpSecret,
                encoding: 'base32',
                token: p.totp,
                window: 1
            });

            if (!verified) {
                return res.json({ success: false, message: "验证码错误" });
            }

            const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
            adminSessions.set(sessionId, { username: p.name, expire: Date.now() + 3600000 });

            return res.json({
                success: true,
                session: sessionId,
                message: "管理员登录成功"
            });

        } catch (error) {
            console.error("管理员登录错误:", error);
            return res.json({ success: false, message: "管理员登录失败: " + error.message });
        }
    }

    // 获取所有用户
    if (p.method == "getAllUsers" && p.session) {
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            const users = JSON.parse(fs.readFileSync(whitedataFile));
            return res.json({ success: true, users });
        } catch (error) {
            console.error("读取用户数据错误:", error);
            return res.json({ success: false, message: "读取用户数据失败: " + error.message });
        }
    }

    // 激活用户
    if (p.method == "activateUser" && p.name && p.session) {
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            const users = JSON.parse(fs.readFileSync(whitedataFile));
            const userIndex = users.findIndex(u => u.name === p.name);

            if (userIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            users[userIndex].status = "active";
            fs.writeFileSync(whitedataFile, JSON.stringify(users));
            return res.json({ success: true, message: "用户已激活" });
        } catch (error) {
            console.error("激活用户错误:", error);
            return res.json({ success: false, message: "激活用户失败: " + error.message });
        }
    }

    // 封禁用户
    if (p.method == "banUser" && p.name && p.session) {
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            const users = JSON.parse(fs.readFileSync(whitedataFile));
            const userIndex = users.findIndex(u => u.name === p.name);

            if (userIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            users[userIndex].status = "banned";
            fs.writeFileSync(whitedataFile, JSON.stringify(users));
            return res.json({ success: true, message: "用户已封禁" });
        } catch (error) {
            console.error("封禁用户错误:", error);
            return res.json({ success: false, message: "封禁用户失败: " + error.message });
        }
    }

    // 解封用户
    if (p.method == "unbanUser" && p.name && p.session) {
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            const users = JSON.parse(fs.readFileSync(whitedataFile));
            const userIndex = users.findIndex(u => u.name === p.name);

            if (userIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            users[userIndex].status = "active";
            fs.writeFileSync(whitedataFile, JSON.stringify(users));
            return res.json({ success: true, message: "用户已解封" });
        } catch (error) {
            console.error("解封用户错误:", error);
            return res.json({ success: false, message: "解封用户失败: " + error.message });
        }
    }
    // 在API处理部分添加删除用户方法
    if (p.method == "deleteUser" && p.name && p.session) {
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            // 读取用户数据
            let players = JSON.parse(fs.readFileSync(whitedataFile));

            // 查找并删除用户
            const initialLength = players.length;
            players = players.filter(player => player.name !== p.name);

            if (players.length === initialLength) {
                return res.json({ success: false, message: "用户不存在" });
            }

            // 保存更新后的用户数据
            fs.writeFileSync(whitedataFile, JSON.stringify(players));

            // 从白名单中移除（如果存在）
            if (onlinePlayer.has(p.name)) {
                onlinePlayer.delete(p.name);
                haveChange = true;
                queryChange = true;
            }

            return res.json({ success: true, message: "用户已删除" });
        } catch (error) {
            console.error("删除用户错误:", error);
            return res.json({ success: false, message: "删除用户失败: " + error.message });
        }
    }
    // 在API处理部分添加修改邮箱方法
    if (p.method == "updateEmail" && p.name && p.newEmail && p.session) {
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            // 读取用户数据
            const players = JSON.parse(fs.readFileSync(whitedataFile));
            const playerIndex = players.findIndex(u => u.name === p.name);

            if (playerIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            // 检查邮箱是否已被使用
            if (players.some((player, index) =>
                index !== playerIndex && player.email === p.newEmail)) {
                return res.json({ success: false, message: "该邮箱已被其他用户使用" });
            }

            // 更新邮箱
            players[playerIndex].email = p.newEmail;
            fs.writeFileSync(whitedataFile, JSON.stringify(players));

            return res.json({ success: true, message: "邮箱更新成功" });
        } catch (error) {
            console.error("更新邮箱错误:", error);
            return res.json({ success: false, message: "更新邮箱失败: " + error.message });
        }
    }
    // 添加密码修改API - 需要原密码验证
    if (p.method == "changePassword" && p.name && p.oldpasswd && p.newpasswd) {
        try {
            const players = JSON.parse(fs.readFileSync(whitedataFile));
            const playerIndex = players.findIndex(player => player.name === p.name);

            if (playerIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            // 验证原密码
            if (players[playerIndex].passwd !== p.oldpasswd) {
                return res.json({ success: false, message: "原密码错误" });
            }

            // 更新密码
            players[playerIndex].passwd = p.newpasswd;
            fs.writeFileSync(whitedataFile, JSON.stringify(players));

            return res.json({ success: true, message: "密码修改成功" });
        } catch (error) {
            console.error("修改密码错误:", error);
            return res.json({ success: false, message: "服务器内部错误" });
        }
    }
    // 添加商品
    if (p.method == "addShopItem" && p.session) {
        // 新增：管理员会话验证
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            // 关键修改：从请求体获取参数
            const { name, itemId, points, stock, image, description } = req.body;

            const items = JSON.parse(fs.readFileSync(shopItemsFile));

            // 创建新商品对象
            const newItem = {
                id: Date.now().toString(),
                name,
                itemId,
                points: parseInt(points),
                stock: parseInt(stock),
                image: image || 'images/default_item.png',
                description: description || '暂无描述',
                createdAt: new Date().toISOString()
            };

            items.push(newItem);
            fs.writeFileSync(shopItemsFile, JSON.stringify(items, null, 2));
            return res.json({ success: true, message: "商品添加成功" });
        } catch (error) {
            console.error("添加商品错误:", error);
            return res.json({ success: false, message: "添加商品失败" });
        }
    }

    // 更新商品
    if (p.method == "updateShopItem" && p.session) {
        const { id, name, itemId, points, stock, image, description } = req.body;
        // 类似添加商品逻辑，根据ID更新
    }

    // 删除商品
    if (p.method == "deleteShopItem" && p.itemId && p.session) {
        // 新增：管理员会话验证
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }
    }

    // 获取商品列表
    if (p.method == "getShopItems") {
        try {
            const items = JSON.parse(fs.readFileSync(shopItemsFile));
            return res.json({ success: true, items });
        } catch (error) {
            console.error("获取商品列表错误:", error);
            return res.json({ success: false, message: "获取商品列表失败" });
        }
    }

    // 更新商品
    if (p.method == "updateShopItem") {
        try {
            const { id, name, itemId, points, stock, image, description } = req.body;
            const items = JSON.parse(fs.readFileSync(shopItemsFile));
            const itemIndex = items.findIndex(item => item.id === id);

            if (itemIndex === -1) {
                return res.json({ success: false, message: "商品不存在" });
            }

            items[itemIndex] = {
                ...items[itemIndex],
                name,
                itemId,
                points: parseInt(points),
                stock: parseInt(stock),
                image: image || items[itemIndex].image,
                description: description || items[itemIndex].description
            };

            fs.writeFileSync(shopItemsFile, JSON.stringify(items));
            return res.json({ success: true, message: "商品更新成功" });
        } catch (error) {
            console.error("更新商品错误:", error);
            return res.json({ success: false, message: "更新商品失败" });
        }
    }

    // 删除商品
    if (p.method == "deleteShopItem" && p.itemId) {
        try {
            const items = JSON.parse(fs.readFileSync(shopItemsFile));
            const newItems = items.filter(item => item.id !== p.itemId);

            if (newItems.length === items.length) {
                return res.json({ success: false, message: "商品不存在" });
            }

            fs.writeFileSync(shopItemsFile, JSON.stringify(newItems));
            return res.json({ success: true, message: "商品删除成功" });
        } catch (error) {
            console.error("删除商品错误:", error);
            return res.json({ success: false, message: "删除商品失败" });
        }
    }

    // 在兑换商品函数中添加二次确认和兑换码显示
    if (p.method == "purchaseItem" && p.username && p.itemId) {
        try {
            const username = p.username;
            const itemId = p.itemId;
            const items = JSON.parse(fs.readFileSync(shopItemsFile));
            const item = items.find(i => i.id === itemId);

            if (!item) {
                return res.json({ success: false, message: "商品不存在" });
            }

            if (item.stock <= 0) {
                return res.json({ success: false, message: "商品已售罄" });
            }

            // 获取玩家积分
            const signData = JSON.parse(fs.readFileSync(signDataFile));
            const userPoints = signData[username]?.points || 0;

            if (userPoints < item.points) {
                return res.json({ success: false, message: "积分不足" });
            }

            // 扣减积分
            signData[username].points -= item.points;
            fs.writeFileSync(signDataFile, JSON.stringify(signData));

            // 扣减库存
            item.stock -= 1;
            fs.writeFileSync(shopItemsFile, JSON.stringify(items));

            // 生成兑换码
            const couponCode = generateCouponCode();
            const coupons = JSON.parse(fs.readFileSync(couponsFile));

            coupons.push({
                code: couponCode,
                type: 'item',
                items: [{
                    itemId: item.itemId,
                    amount: item.amount || 1
                }],
                designatedPlayer: username, // 指定玩家
                oneTimeUse: true, // 一次性使用
                expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
                createdAt: new Date().toISOString(),
                used: false,
                usedBy: []
            });

            fs.writeFileSync(couponsFile, JSON.stringify(coupons));

            return res.json({
                success: true,
                coupon: couponCode,
                item: item,
                message: "兑换成功！有效期3天，请尽快使用"
            });
        } catch (error) {
            console.error("兑换商品错误:", error);
            return res.json({ success: false, message: "兑换失败" });
        }
    }
    // 修改兑换码生成逻辑
    if (p.method == "generateCoupon" && p.session) {
        // 新增：管理员会话验证
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }
        try {
            const session = p.session;
            // 从请求体中获取参数
            const { type, items, expiresAt, designatedPlayer, oneTimeUse } = req.body;

            // 验证管理员会话
            if (!adminSessions.has(session)) {
                return res.json({ success: false, message: "管理员会话无效" });
            }

            // 读取兑换码数据
            let coupons = [];
            if (fs.existsSync(couponsFile)) {
                coupons = JSON.parse(fs.readFileSync(couponsFile));
            }

            // 生成兑换码
            const couponCode = generateCouponCode();

            // 创建新兑换码对象
            const newCoupon = {
                code: couponCode,
                type, // 类型：item 或 bundle
                items, // 物品数组 [{itemId, amount}]
                designatedPlayer: designatedPlayer || null,
                expiresAt: new Date(expiresAt).toISOString(),
                oneTimeUse: oneTimeUse === "true",
                createdAt: new Date().toISOString(),
                used: false,
                usedBy: []
            };

            // 添加到列表并保存
            coupons.push(newCoupon);
            fs.writeFileSync(couponsFile, JSON.stringify(coupons, null, 2));

            return res.json({
                success: true,
                couponCode,
                message: "兑换码生成成功"
            });
        } catch (error) {
            console.error("生成兑换码错误:", error);
            return res.json({ success: false, message: "生成兑换码失败" });
        }
    }

    // 在API处理部分修改兑换码使用逻辑
    if (p.method == "useCoupon" && p.username && p.code && p.token) {
        // 验证服务器令牌
        if (p.token !== SERVER_TOKEN) {
            return res.json({ success: false, message: "无效的服务器令牌" });
        }

        try {
            const coupons = readCouponsFile();
            const couponIndex = coupons.findIndex(c => c.code === p.code);

            if (couponIndex === -1) {
                return res.json({ success: false, message: "兑换码无效" });
            }

            const coupon = coupons[couponIndex];
            const now = new Date();

            // 检查是否过期
            if (new Date(coupon.expiresAt) < now) {
                return res.json({ success: false, message: "兑换码已过期" });
            }

            // 检查是否指定玩家
            if (coupon.designatedPlayer && coupon.designatedPlayer !== p.username) {
                return res.json({ success: false, message: "该兑换码不属于您" });
            }

            // 检查使用限制
            if (coupon.oneTimeUse && coupon.used) {
                return res.json({ success: false, message: "兑换码已被使用" });
            }

            if (!coupon.oneTimeUse && coupon.usedBy.includes(p.username)) {
                return res.json({ success: false, message: "您已使用过该兑换码" });
            }

            // 更新兑换码状态
            if (coupon.oneTimeUse) {
                coupons[couponIndex].used = true;
            } else {
                coupons[couponIndex].usedBy.push(p.username);
            }

            // 确保写入文件
            writeCouponsFile(coupons);
            // 返回物品列表
            return res.json({
                success: true,
                message: "兑换成功",
                items: coupon.items
            });

        } catch (error) {
            console.error("使用兑换码错误:", error);
            return res.json({ success: false, message: "兑换失败" });
        }
    }
    // 获取兑换码
    if (p.method == "getCoupons") {
        try {
            const coupons = JSON.parse(fs.readFileSync(couponsFile));
            const enhancedCoupons = coupons.map(coupon => {
                return {
                    ...coupon,
                    usedBy: coupon.usedBy || []
                };
            });
            return res.json({ success: true, coupons: enhancedCoupons });
        } catch (error) {
            console.error("获取兑换码错误:", error);
            return res.json({ success: false, message: "获取兑换码失败" });
        }
    }

    // 删除兑换码
    if (p.method == "deleteCoupon" && p.code && p.session) {
        if (!adminSessions.has(p.session)) {
            return res.json({ success: false, message: "管理员会话无效" });
        }

        try {
            const coupons = JSON.parse(fs.readFileSync(couponsFile));
            const initialLength = coupons.length;

            // 关键修复：统一转换为大写比较
            const codeToDelete = p.code.toUpperCase();
            const newCoupons = coupons.filter(coupon =>
                coupon.code.toUpperCase() !== codeToDelete
            );

            if (newCoupons.length === initialLength) {
                return res.json({ success: false, message: "兑换码不存在" });
            }

            fs.writeFileSync(couponsFile, JSON.stringify(newCoupons));
            return res.json({ success: true, message: "兑换码删除成功" });
        } catch (error) {
            console.error("删除兑换码错误:", error);
            return res.json({ success: false, message: "删除兑换码失败" });
        }
    }

    // 生成随机兑换码函数
    function generateCouponCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 10; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    if (p.name && p.passwd && p.method == "login") {
        // 新增：拦截管理员账号的玩家登录
        if (p.name.toLowerCase() === "admin") {
            return res.send("管理员账号请使用管理员登录");
        }
        // 新增：检查用户名是否包含@
        if (p.name.includes('@')) {
            return res.send("用户名不能包含@符号！");
        }
        try {
            const players = JSON.parse(fs.readFileSync(whitedataFile));
            const player = players.find(player => player.name === p.name);

            if (!player) {
                return res.send("您不在数据库中，请注册！");
            }

            if (player.status === "banned") {
                return res.send("登录失败：账号已被封禁！");
            }

            if (player.status === "inactive") {
                return res.send("登录失败：账号未激活，请联系管理员！");
            }

            if (player.passwd === p.passwd) {
                loger(`玩家 ${p.name} 登录`);

                // 更新最后登录时间
                player.lastLogin = new Date().toLocaleString();
                fs.writeFileSync(whitedataFile, JSON.stringify(players));

                if (onlinePlayer.has(p.name)) {
                    const onlineTime = p.time && p.time < maxOnlineTime ? p.time : maxOnlineTime;
                    onlinePlayer.get(p.name).onlineTime = Date.now() + onlineTime;
                    return res.send(`你的再次登录已确认，时间已延长，当前在线时间${formatTime(onlineTime)}`);
                } else {
                    const onlineTime = p.time && p.time <= maxOnlineTime ? p.time : maxOnlineTime;
                    onlinePlayer.set(p.name, {
                        uuid: player.uuid,
                        name: player.name,
                        loginTime: Date.now(),
                        onlineTime: Date.now() + onlineTime
                    });
                    haveChange = true;
                    queryChange = true;
                    return res.send(`玩家名称${p.name}已确认登录${formatTime(onlineTime)}`);
                }
            } else {
                return res.send("登录失败：密码错误！");
            }
        } catch (error) {
            console.error("登录错误:", error);
            return res.send("服务器内部错误");
        }
    }
    // 修改密码逻辑 - 仅需邮箱验证码
    else if (p.method == "repasswd" && p.name && p.newpasswd) {
        try {
            const players = JSON.parse(fs.readFileSync(whitedataFile));
            const player = players.find(player => player.name === p.name);

            if (!player) {
                return res.send("该用户不存在！");
            }

            const code = generateVerificationCode();
            verificationCodes.set(player.email, {
                code,
                expire: Date.now() + 300000,
                name: player.name,
                newpasswd: p.newpasswd
            });

            await sendVerificationEmail(player.email, code);

            return res.send("验证码已发送至您的注册邮箱，请使用验证码完成密码修改。");
        } catch (error) {
            console.error("修改密码错误:", error);
            return res.send("服务器内部错误");
        }
    }
    else if (p.method == "verifyCode" && p.email && p.code) {
        const record = verificationCodes.get(p.email);
        if (!record || record.expire < Date.now()) {
            return res.send("验证码无效或已过期");
        }

        if (record.code !== p.code) {
            return res.send("验证码错误");
        }

        try {
            const players = JSON.parse(fs.readFileSync(whitedataFile));
            const playerIndex = players.findIndex(u => u.name === record.name);

            if (playerIndex === -1) {
                return res.send("用户不存在");
            }

            players[playerIndex].passwd = record.newpasswd;
            fs.writeFileSync(whitedataFile, JSON.stringify(players));
            verificationCodes.delete(p.email);
            return res.send("密码修改成功！");
        } catch (error) {
            console.error("验证码修改密码错误:", error);
            return res.send("服务器内部错误");
        }
    }
    else if (p.name && p.passwd && p.method == "regist" && p.email) {
        // 新增：禁止注册admin账号
        if (p.name.toLowerCase() === "admin") {
            return res.send("禁止注册管理员账号");
        }
        // 新增：检查用户名是否包含@
        if (p.name.includes('@')) {
            return res.send("用户名不能包含@符号！");
        }
        try {
            const players = JSON.parse(fs.readFileSync(whitedataFile));

            if (players.some(player => player.name === p.name)) {
                return res.send("请勿重复注册！");
            }

            if (players.some(player => player.email === p.email)) {
                return res.send("该邮箱已被注册！");
            }

            const id = await getUuid(p.name);
            if (!id) {
                return res.send("获取uuid失败，请联系腐竹或管理员！");
            }

            const code = generateVerificationCode();
            verificationCodes.set(p.email, {
                code,
                expire: Date.now() + 300000,
                name: p.name,
                passwd: p.passwd,
                uuid: id
            });

            if (await sendVerificationEmail(p.email, code)) {
                return res.send("验证码已发送至您的邮箱，请使用验证码完成注册。");
            } else {
                return res.send("发送验证邮件失败，请稍后再试。");
            }
        } catch (error) {
            console.error("注册错误:", error);
            return res.send("服务器内部错误");
        }
    }
    else if (p.method == "verifyRegist" && p.email && p.code) {
        const record = verificationCodes.get(p.email);
        if (!record || record.expire < Date.now()) {
            return res.json({
                success: false,
                message: "验证码无效或已过期"
            });
        }

        if (record.code !== p.code) {
            return res.json({
                success: false,
                message: "验证码错误"
            });
        }

        // 新增：再次检查用户名格式
        if (record.name.includes('@')) {
            return res.json({
                success: false,
                message: "用户名不能包含@符号！"
            });
        }

        try {
            // 修复：使用正确的文件路径
            const players = JSON.parse(fs.readFileSync(whitedataFile));

            // 新增：再次检查用户名是否已被注册
            if (players.some(player => player.name === record.name)) {
                return res.json({
                    success: false,
                    message: "该用户名已被注册，请更换用户名！"
                });
            }

            // 新增：再次检查邮箱是否已被使用
            if (players.some(player => player.email === p.email)) {
                return res.json({
                    success: false,
                    message: "该邮箱已被注册！"
                });
            }

            players.push({
                name: record.name,
                uuid: record.uuid,
                passwd: record.passwd,
                email: p.email,
                status: "inactive",
                points: 0,
                joinDate: new Date().toLocaleDateString(),
                onlineTime: 0,
                lastLogin: ''
            });

            // 修复：使用正确的文件路径
            fs.writeFileSync(whitedataFile, JSON.stringify(players));

            // 仅在成功注册后删除验证码
            verificationCodes.delete(p.email);

            return res.json({
                success: true,
                message: "注册成功！您的账号需要管理员激活后方可使用。"
            });
        } catch (error) {
            console.error("验证注册错误:", error);

            // 修复：保留验证码以便重试
            return res.json({
                success: false,
                message: "服务器内部错误，请重试或联系管理员"
            });
        }
    }
    else if (p.name && p.passwd && p.method == "logout") {
        try {
            const players = JSON.parse(fs.readFileSync(whitedataFile));
            const player = players.find(player => player.name === p.name);

            if (!player) {
                return res.send("您不在数据库中，请注册！");
            }

            if (player.passwd === p.passwd) {
                loger(`玩家 ${p.name} 登出`);

                if (onlinePlayer.has(p.name)) {
                    onlinePlayer.delete(p.name);
                    haveChange = true;
                    queryChange = true;
                    return res.send(`玩家${p.name}已退出登录！`);
                } else {
                    return res.send(`玩家${p.name}现在不是登录状态！`);
                }
            } else {
                return res.send("登出失败：密码错误！");
            }
        } catch (error) {
            console.error("登出错误:", error);
            return res.send("服务器内部错误");
        }
    }
    else {
        return res.send("传入参数错误！");
    }
});

// 创建HTTPS服务器
https.createServer(httpsOptions, app).listen(parseInt(cfg('ports.https', '443'), 10), () => {
    console.log(`HTTPS服务器运行在端口 ${cfg("ports.https","443")}`);
});

http.createServer(app).listen(parseInt(cfg('ports.http', '80'), 10), () => {
    console.log(`HTTP服务器运行在端口 ${cfg("ports.http","80")}`);
});
// 插件交互HTTP服务器
http.createServer((req, res) => {
    loger(`<插件操作> IP: ${req.socket.remoteAddress} 请求方法: ${req.method} 操作: ${req.url}`);
    const pluginAllowlist = cfgJson('plugin.allowlist', ['127.0.0.1', '::1']);
// 插件交互：仅允许白名单 IP 访问（可在 config.json / 环境变量中配置）
function isAllowedPluginIP(ip) {
  if (!ip) return false;
  // 兼容 IPv4-mapped IPv6
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return pluginAllowlist.includes(ip) || pluginAllowlist.includes(normalized);
}

    if (isAllowedPluginIP(req.socket.remoteAddress)) {
        if (req.url == "/") {
            loger(`<插件操作> IP: ${req.socket.remoteAddress} 访问了 测试链接`);
            res.writeHead(200);
            res.end();
            return;
        }
        if (req.url == "/change") {
            loger(`<插件操作> IP: ${req.socket.remoteAddress} 访问了 查询是否需要刷新`);
            if (queryChange) {
                queryChange = false;
                res.writeHead(200);
                res.end();
                return;
            } else {
                res.writeHead(404);
                res.end();
                return;
            }
        }
        if (req.url.slice(0, 7) == "/check/") {
            loger(`<插件操作> IP: ${req.socket.remoteAddress} 访问了 查询玩家是否允许进入`);
            let name = req.url.slice(7);
            if (onlinePlayer.has(name)) {
                res.writeHead(200);
                res.end();
                return;
            } else {
                res.writeHead(404);
                res.end();
                return;
            }
        }
        if (req.url.slice(0, 7) == "/login/") {
            loger(`<插件操作> IP: ${req.socket.remoteAddress} 访问了 登录玩家`);
            let name = req.url.slice(7);
            try {
                const players = JSON.parse(fs.readFileSync(whitedataFile));
                // 重置玩家会话开始时间（关键修改）
                playerSessions.set(name, Date.now());
                if (onlinePlayer.has(name)) {
                    onlinePlayer.get(name).onlineTime = Date.now() + maxOnlineTime;
                    res.writeHead(200);
                    res.end();
                    return;
                }
                const player = players.find(p => p.name === name);
                if (player) {
                    onlinePlayer.set(name, {
                        uuid: player.uuid,
                        name: player.name,
                        loginTime: Date.now(),
                        onlineTime: Date.now() + maxOnlineTime
                    });
                    haveChange = true;
                    queryChange = true;
                    res.writeHead(200);
                    res.end();
                } else {
                    res.writeHead(404);
                    res.end();
                }
            } catch (error) {
                console.error("插件登录错误:", error);
                res.writeHead(500);
                res.end();
            }
        }
        // 修改登出处理逻辑
        if (req.url.slice(0, 8) == "/logout/") {
            loger(`<插件操作> IP: ${req.socket.remoteAddress} 访问了 登出玩家`);
            const name = req.url.slice(8);

            if (!name || name.trim() === "") {
                res.writeHead(400);
                res.end();
                return;
            }

            // 获取正确的登录时间（优先从playerSessions获取）
            const loginTime = getPlayerLoginTime(name);
            const sessionTime = Date.now() - loginTime;

            try {
                // 读取玩家数据 - 在移除onlinePlayer之前
                const players = JSON.parse(fs.readFileSync(whitedataFile));
                const playerIndex = players.findIndex(p => p.name === name);

                if (playerIndex !== -1) {
                    // 累加在线时长（确保数值类型）
                    players[playerIndex].onlineTime = parseInt(players[playerIndex].onlineTime || 0) + sessionTime;
                    players[playerIndex].lastLogin = new Date().toLocaleString();

                    // 保存更新后的数据
                    fs.writeFileSync(whitedataFile, JSON.stringify(players));
                    loger(`玩家 ${name} 在线时长更新: +${formatTime(sessionTime)}，总时长: ${formatTime(players[playerIndex].onlineTime)}`);
                }
            } catch (error) {
                console.error("更新在线时长错误:", error);
            }

            // 清除会话记录
            if (playerSessions.has(name)) {
                playerSessions.delete(name);
            }

            // 从在线玩家列表中移除
            if (onlinePlayer.has(name)) {
                onlinePlayer.delete(name);
                haveChange = true;
                queryChange = true;
                res.writeHead(200);
                res.end();
                return;
            } else {
                res.writeHead(404);
                res.end();
                return;
            }
        }
    } else {
        loger(`<插件操作> IP: ${req.socket.remoteAddress} 访问被拒绝`);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("bad request");
    }
}).listen(parseInt(cfg('ports.plugin', '8094'), 10), () => {
    console.log(`插件交互端口：${cfg("ports.plugin","8094")}，请勿转发此端口，防火墙请屏蔽此端口`);
});
