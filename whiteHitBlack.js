const express = require('express');
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const BetterSqlite3 = require('better-sqlite3');
function httpGetJson(urlStr, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(urlStr);
        } catch (e) {
            return reject(new Error(`Invalid URL: ${urlStr}`));
        }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(
            {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'whiteHitBlack/1.0',
                    'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8'
                }
            },
            (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => (raw += chunk));
                res.on('end', () => {
                    const status = res.statusCode || 0;
                    const ok = status >= 200 && status < 300;
                    let data = null;
                    if (raw) {
                        try {
                            data = JSON.parse(raw);
                        } catch (_) {
                        }
                    }
                    resolve({
                        ok,
                        status,
                        statusText: res.statusMessage || '',
                        data,
                        raw
                    });
                });
            }
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', reject);
        req.end();
    });
}
function promiseAnyCompat(promises) {
    if (typeof Promise.any === 'function') return Promise.any(promises);
    return new Promise((resolve, reject) => {
        const errors = [];
        let pending = promises.length;
        if (pending === 0) {
            const err = typeof AggregateError === 'function'
                ? new AggregateError([], 'All promises were rejected')
                : new Error('All promises were rejected');
            return reject(err);
        }
        promises.forEach((p, idx) => {
            Promise.resolve(p).then(resolve).catch((e) => {
                errors[idx] = e;
                pending -= 1;
                if (pending === 0) {
                    const err = typeof AggregateError === 'function'
                        ? new AggregateError(errors, 'All promises were rejected')
                        : new Error('All promises were rejected');
                    reject(err);
                }
            });
        });
    });
}

// -------------------- 配置加载 --------------------
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

function resolveMaybeRelativePath(pth) {
    if (!pth) return pth;
    return path.isAbsolute(pth) ? pth : path.join(__dirname, pth);
}


function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(base, extra) {
    const out = { ...base };
    for (const [k, v] of Object.entries(extra || {})) {
        if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
        else out[k] = v;
    }
    return out;
}

// 代码内置默认值
const DEFAULT_CONFIG = {
    email: {
        logoUrl: "https://image.010831.xyz/gbc/icon.jpg"
    },
    files: {
        whitelist: "whitelist.json",
        whitedata: "whitedata.json",
        signData: "signData.json",
        shopItems: "shopItems.json",
        coupons: "coupons.json"
    },
    http: {
        bodyLimit: "10mb",
        responseLimitBytes: 20 * 1024 * 1024,
        staticDir: "public",
        httpPort: 80,
        httpsPort: 443,
        pluginPort: 8094
    },
    tls: {
        keyPath: "server.key",
        certPath: "server.pem"
    },
    game: {
        maxOnlineTimeMs: 1000 * 60 * 60 * 24 * 31 * 12 * 100,
        onlineMode: false
    },
    admin: {
        default: {
            username: "admin",
            password: "admin123",
            totpSecret: "GSEWY3DPEHPK3DHJ"
        }
    },
    mail: {
        host: "smtp.exmail.qq.com",
        port: 465,
        secure: true,
        auth: {
            user: "CHANGE_ME@example.com",
            pass: "CHANGE_ME"
        },
        fromName: "嘎嘣脆服务器官方",
        fromAddress: "CHANGE_ME@example.com",
        verificationSubject: "邮箱验证"
    },
    security: {
        serverToken: "CHANGE_ME",
        verificationCodeTtlMs: 5 * 60 * 1000,
        adminSessionTtlMs: 60 * 60 * 1000,
        webSessionTtlMs: 60 * 60 * 1000,
        sessionBinding: {
            admin: { ip: false, ua: false },
            web: { ip: false, ua: false }
        }
    },
    storage: {
        avatarsDir: "avatars",
        maxAvatarBytes: 10 * 1024 * 1024,
        databasePath: "data.sqlite",
        portsFile: "ports.json"
    },
    webhook: {
        updatePortPath: "/webhook/update-port"
    },
    status: {
        servers: [
            { name: "电信线路", host: "v4.242774835.xyz", defaultPort: 1259 },
            { name: "电信IPv6", host: "ipv6.242774835.xyz", defaultPort: 25565 }
        ],
        maxRetries: 3,
        fetchTimeoutMs: 5000,
        cacheTtlMs: 25000
    },
    shop: {
        couponLength: 10,
        couponValidityMs: 3 * 24 * 60 * 60 * 1000
    },
    sign: {
        timezoneOffsetHours: 8
    },
    plugin: {
        allowedIPs: [
            "127.0.0.1",
            "::ffff:127.0.0.1",
            "::1"
        ]
    }
};

function loadConfig() {
    let cfg = DEFAULT_CONFIG;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const userCfg = JSON.parse(raw);
            cfg = deepMerge(DEFAULT_CONFIG, userCfg);
        } else {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
            console.log(`已生成默认配置文件: ${CONFIG_PATH}，请按需修改后重新启动服务`);
            process.exit(0);
        }
    } catch (e) {
        console.error("读取/解析配置文件失败，将使用默认配置:", e);
    }

    // 用环境变量覆盖敏感项（可选，但强烈推荐）
    if (process.env.SMTP_USER) cfg.mail.auth.user = process.env.SMTP_USER;
    if (process.env.SMTP_PASS) cfg.mail.auth.pass = process.env.SMTP_PASS;
    if (process.env.SERVER_TOKEN) cfg.security.serverToken = process.env.SERVER_TOKEN;
    try {
        const adminObj = cfg && cfg.admin ? (cfg.admin.default && typeof cfg.admin.default === 'object' ? cfg.admin.default : cfg.admin) : null;
        if (adminObj && adminObj.password && !adminObj.passwordHash) {
            if (typeof adminObj.password === 'string' && adminObj.password.startsWith('$2')) {
                adminObj.passwordHash = adminObj.password;
            } else {
                adminObj.passwordHash = bcrypt.hashSync(String(adminObj.password), 12);
            }
            delete adminObj.password;

            if (fs.existsSync(CONFIG_PATH)) {
                const ok = saveConfig(cfg);
                if (ok) console.warn('安全提示：检测到管理员明文密码，已转换为 passwordHash 并写回 config.json。');
                else console.warn('安全提示：检测到管理员明文密码，已在内存中转换为 passwordHash，但写回 config.json 失败，请手动更新配置。');
            }
        }
    } catch (e) {
        console.warn("管理员密码安全迁移失败（将继续使用原配置）:", e);
    }


    return cfg;
}


function saveConfig(cfg) {
    try {
        const tmpPath = CONFIG_PATH + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { encoding: "utf8" });
        try { fs.chmodSync(tmpPath, 0o600); } catch (e) { /* ignore */ }
        fs.renameSync(tmpPath, CONFIG_PATH);
        try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (e) { /* ignore */ }
        return true;
    } catch (e) {
        console.error("写入配置文件失败:", e);
        return false;
    }
}

const config = loadConfig();
const SQLITE_PATH = resolveMaybeRelativePath((config.storage && config.storage.databasePath) || "data.sqlite");
let DB = null;
let dbTxnDepth = 0;
// filePath -> key 映射（稍后在路径解析完毕后填充）
const dbPathToKey = new Map();

function initSqliteKv() {
    try {
        const dir = path.dirname(SQLITE_PATH);
        if (dir && dir !== '.' && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        DB = new BetterSqlite3(SQLITE_PATH);
        try { DB.exec("PRAGMA journal_mode = WAL;"); } catch (_) { }
        try { DB.exec("PRAGMA foreign_keys = ON;"); } catch (_) { }

        DB.exec(`
            CREATE TABLE IF NOT EXISTS kv_json (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
    } catch (e) {
        console.error("SQLite 初始化失败，已终止启动（数据库为必需）:", e);
        process.exit(1);
    }
}

function withDbTransactionSync(fn) {
    if (!DB) return fn();
    if (dbTxnDepth > 0) return fn(); // 简单嵌套：外层开启，内层复用
    dbTxnDepth++;
    DB.exec("BEGIN IMMEDIATE;");
    try {
        const r = fn();
        DB.exec("COMMIT;");
        return r;
    } catch (e) {
        try { DB.exec("ROLLBACK;"); } catch (_) { }
        throw e;
    } finally {
        dbTxnDepth--;
    }
}

function dbGetJsonText(key) {
    if (!DB) return null;
    try {
        const row = DB.prepare("SELECT v FROM kv_json WHERE k = ?").get(String(key));
        return row ? String(row.v) : null;
    } catch (e) {
        console.error("SQLite 读取失败:", key, e);
        return null;
    }
}

function dbSetJsonText(key, jsonText) {
    if (!DB) return false;
    const now = Date.now();
    try {
        DB.prepare(`
            INSERT INTO kv_json (k, v, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at
        `).run(String(key), String(jsonText), now);
        return true;
    } catch (e) {
        console.error("SQLite 写入失败:", key, e);
        return false;
    }
}

function ensureKvKeyFromFile(filePath, key, defaultValue) {
    if (!DB) return;
    const existed = dbGetJsonText(key);
    if (existed !== null) return;

    // 若旧 JSON 文件存在则迁移
    try {
        if (filePath && fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf8");
            if (raw && raw.trim()) {
                JSON.parse(raw); // 校验 JSON
                withDbTransactionSync(() => dbSetJsonText(key, raw));
                console.log(`已从旧文件迁移到 SQLite: ${path.basename(filePath)} -> ${key}`);
                return;
            }
        }
    } catch (e) {
        console.warn(`迁移旧文件失败，将使用默认值 key=${key}:`, e);
    }

    const dv = JSON.stringify(defaultValue ?? null);
    withDbTransactionSync(() => dbSetJsonText(key, dv));
}

// 初始化 SQLite
initSqliteKv();

function withFileLockSync(_filePath, fn) {
    // 已弃用文件锁：全部由 SQLite 事务保证一致性
    return withDbTransactionSync(fn);
}

function withMultiFileLocksSync(_filePaths, fn) {
    // 已弃用文件锁：全部由 SQLite 事务保证一致性
    return withDbTransactionSync(fn);
}

function readJsonSafeSync(filePath, defaultValue) {
    try {
        const key = dbPathToKey.get(filePath);
        if (!DB || !key) return defaultValue;
        const raw = dbGetJsonText(key);
        if (!raw) return defaultValue;
        return JSON.parse(raw);
    } catch (e) {
        // 关键改动：读取/解析异常必须抛出，阻止后续写入流程（避免用默认值覆盖坏数据）
        const err = new Error(`READ_JSON_FAILED: ${filePath}: ${e && e.message ? e.message : String(e)}`);
        try { err.cause = e; } catch (_) { /* ignore */ }
        throw err;
    }
}

function writeTextAtomicSync(filePath, text) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, text, { encoding: 'utf8' });
    fs.renameSync(tmp, filePath);
}

function writeJsonAtomicSync(filePath, obj, indent = 2) {
    const key = dbPathToKey.get(filePath);
    if (!DB || !key) {
        // 已弃用 JSON 文件存储：除必要文件外，禁止落盘
        throw new Error(`JSON_FILE_STORAGE_DISABLED: ${filePath}`);
    }
    const text = JSON.stringify(obj, null, indent);
    return withDbTransactionSync(() => dbSetJsonText(key, text));
}

function writeJsonAtomicLockedSync(filePath, obj, indent = 2) {
    // 已弃用文件锁：直接复用 SQLite 事务
    return writeJsonAtomicSync(filePath, obj, indent);
}

// -------------------- 时区日期工具（按固定 UTC offset 计算 YYYY-MM-DD） --------------------
function getISODateInOffsetHours(offsetHours, ms = Date.now()) {
    const offsetMs = Number(offsetHours || 0) * 60 * 60 * 1000;
    // ms 本身就是 UTC epoch 毫秒数；直接加固定 offset 后取 ISO 日期即可
    const d = new Date(ms + offsetMs);
    return d.toISOString().slice(0, 10);
}

// -------------------- 基础输入校验 --------------------
function isValidMinecraftName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

const UUID_SCRIPT_PATH = path.join(__dirname, 'getUuid.py');
// -------------------- 配置加载结束 --------------------

const playerSessions = new Map();
const webSessions = new Map();
const sub_process = require('child_process');
const { promisify } = require('util');
const exec = promisify(sub_process.exec);
const execFileAsync = promisify(sub_process.execFile);
const nodemailer = require('nodemailer');
const speakeasy = require('speakeasy');
const bodyParser = require('body-parser');
const EMAIL_LOGO_URL = config.email.logoUrl;
const whitelistFile = resolveMaybeRelativePath(config.files.whitelist);
const whitedataFile = resolveMaybeRelativePath(config.files.whitedata);
const signDataFile = resolveMaybeRelativePath(config.files.signData);
const shopItemsFile = resolveMaybeRelativePath(config.files.shopItems);
const couponsFile = resolveMaybeRelativePath(config.files.coupons);
try {
    dbPathToKey.set(whitedataFile, "whitedata");
    dbPathToKey.set(signDataFile, "signData");
    dbPathToKey.set(shopItemsFile, "shopItems");
    dbPathToKey.set(couponsFile, "coupons");
    ensureKvKeyFromFile(whitedataFile, "whitedata", []);
    ensureKvKeyFromFile(signDataFile, "signData", {});
    ensureKvKeyFromFile(shopItemsFile, "shopItems", []);
    ensureKvKeyFromFile(couponsFile, "coupons", []);
} catch (e) {
    console.error("初始化 SQLite KV 映射失败:", e);
}

// -------------------- 用户存在性缓存（用于删除用户后立即失效 session） --------------------
const userExistCache = new Map(); // username -> { ok: boolean, expire: number }
const USER_EXIST_CACHE_TTL_MS = 5000;

function userExistsCached(username) {
    const u = String(username || '').trim();
    if (!u) return false;
    const now = Date.now();
    const cached = userExistCache.get(u);
    if (cached && typeof cached.expire === 'number' && cached.expire > now) return !!cached.ok;

    const players = readJsonSafeSync(whitedataFile, []);
    const ok = Array.isArray(players) && players.some(p => p && p.name === u);
    userExistCache.set(u, { ok, expire: now + USER_EXIST_CACHE_TTL_MS });
    return ok;
}

const serverStatusCache = new Map();
const SERVER_TOKEN = config.security.serverToken;
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
            const online = !!(data && !data.error);

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
app.use(bodyParser.json({ limit: config.http.bodyLimit }));

// -------------------- 响应大小限制（避免超大响应导致资源消耗） --------------------
const RESPONSE_LIMIT_BYTES = (() => {
    const v = Number(config?.http?.responseLimitBytes);
    return Number.isFinite(v) && v > 0 ? v : (20 * 1024 * 1024);
})();

app.use((req, res, next) => {
    const limit = RESPONSE_LIMIT_BYTES;
    const origSend = res.send.bind(res);
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    let sentBytes = 0;
    let killed = false;

    function tooLargeResponse() {
        if (killed) return;
        killed = true;
        const payload = JSON.stringify({ success: false, message: `Response too large (>${limit} bytes)` });
        try {
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return origEnd(payload);
            }
        } catch (_) { /* ignore */ }
        try { res.destroy(); } catch (_) { /* ignore */ }
    }

    function chunkLen(chunk, encoding) {
        if (!chunk) return 0;
        return Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding || 'utf8');
    }

    // 兜底：拦截所有 write/end（包括静态文件流）并累计输出字节数
    res.write = function (chunk, encoding, cb) {
        if (killed) return false;
        const len = chunkLen(chunk, encoding);
        if ((sentBytes + len) > limit) return tooLargeResponse();
        sentBytes += len;
        return origWrite(chunk, encoding, cb);
    };
    res.end = function (chunk, encoding, cb) {
        if (killed) return;
        const len = chunkLen(chunk, encoding);
        if ((sentBytes + len) > limit) return tooLargeResponse();
        sentBytes += len;
        return origEnd(chunk, encoding, cb);
    };

    // 包装 res.json：先 stringify 再检查大小（可在发送前提前拦截）
    res.json = function (body) {
        let text;
        try {
            text = JSON.stringify(body);
        } catch (e) {
            return next(e);
        }
        if (chunkLen(text, 'utf8') > limit) return tooLargeResponse();
        try { res.setHeader('Content-Type', 'application/json; charset=utf-8'); } catch (_) { /* ignore */ }
        return origSend(text);
    };

    // 包装 res.send：对 object 转为 json，其它直接检查
    res.send = function (body) {
        if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
            return res.json(body);
        }
        if (chunkLen(body, 'utf8') > limit) return tooLargeResponse();
        return origSend(body);
    };

    next();
});

app.use(express.static(path.join(__dirname, config.http.staticDir))); // 使用静态目录public

const maxOnlineTime = config.game.maxOnlineTimeMs;
const onlineMode = config.game.onlineMode;

// --------------------- 管理员配置 --------------------
function normalizeAdminConfig(adminCfg) {
    if (!adminCfg) return null;
    const cfg = (adminCfg.default && typeof adminCfg.default === 'object') ? adminCfg.default : adminCfg;

    if (!cfg.username || (!cfg.password && !cfg.passwordHash) || !cfg.totpSecret) return null;
    return cfg;
}

const ADMIN = normalizeAdminConfig(config.admin);
if (!ADMIN) {
    console.warn("未在 config.json 中配置 admin（username/password/totpSecret），管理员登录将不可用。");
}

if (ADMIN) {
    if ((ADMIN.username === 'admin' && ADMIN.password === 'admin123') || ADMIN.totpSecret === 'GSEWY3DPEHPK3DHJ') {
        console.error('安全错误：检测到默认管理员账号/密码或默认TOTP秘钥，请先修改 config.json 后再启动。');
        process.exit(1);
    } if (ADMIN.password && !ADMIN.passwordHash) {
        console.warn('安全提示：管理员密码仍为明文（password）。建议改为 passwordHash 并移除 password。');
    }
}

// -------------------- 管理员配置结束 --------------------


// 确保whitelist.json文件存在并初始化
if (!fs.existsSync(whitelistFile)) {
    fs.writeFileSync(whitelistFile, "[]");
    console.log(`已创建空白名单文件: ${whitelistFile}`);
}

// whitelist.json 属于 Minecraft 服务器的必要文件：数据库为主，文件为派生输出（不再作为存储）
function writeWhitelistFileAtomic(list) {
    const arr = Array.isArray(list) ? list : [];
    const text = JSON.stringify(arr, null, 0);
    writeTextAtomicSync(whitelistFile, text);
}

// 邮件配置
const transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: {
        user: config.mail.auth.user,
        pass: config.mail.auth.pass
    },
});

// 验证码存储
const verificationCodes = new Map();
const adminSessions = new Map();

function pruneMapByExpire(map, field = 'expire') {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of map.entries()) {
        if (!v || typeof v[field] !== 'number' || v[field] < now) {
            map.delete(k);
            removed += 1;
        }
    }
    return removed;
}

function purgeSessionsForUser(username, email) {
    const u = String(username || '').trim();
    const em = String(email || '').trim().toLowerCase();

    if (u) {
        for (const [sid, s] of webSessions.entries()) {
            if (s && s.username === u) webSessions.delete(sid);
        }
        if (playerSessions.has(u)) playerSessions.delete(u);
        userExistCache.delete(u);

        // 在线状态残留
        try {
            if (typeof onlinePlayer !== 'undefined' && onlinePlayer && onlinePlayer.has(u)) {
                onlinePlayer.delete(u);
                if (typeof haveChange !== 'undefined') haveChange = true;
                if (typeof queryChange !== 'undefined') queryChange = true;
            }
        } catch (_) { /* ignore */ }
    }

    // 验证码残留（可能以邮箱为 key，也可能 record.name 匹配）
    for (const [k, v] of verificationCodes.entries()) {
        const kk = String(k || '').trim().toLowerCase();
        if ((em && kk === em) || (v && u && v.name === u)) {
            verificationCodes.delete(k);
        }
    }
}

// -------------------- 会话/验证码清理机制（避免 Map 无限增长） --------------------
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
setInterval(() => {
    try {
        pruneMapByExpire(verificationCodes, 'expire');
        pruneMapByExpire(webSessions, 'expire');
        pruneMapByExpire(adminSessions, 'expire');
        pruneMapByExpire(userExistCache, 'expire');

        // 玩家会话计时残留：离线且超过 maxOnlineTime 的，直接丢弃
        const now = Date.now();
        const ttl = Number(config?.game?.maxOnlineTimeMs) || (1000 * 60 * 60);
        for (const [name, loginAt] of playerSessions.entries()) {
            if (typeof loginAt !== 'number') {
                playerSessions.delete(name);
                continue;
            }
            let isOnline = false;
            try { isOnline = onlinePlayer && onlinePlayer.has(name); } catch (_) { isOnline = false; }
            if (!isOnline && (now - loginAt) > (ttl + 60 * 1000)) {
                playerSessions.delete(name);
            }
        }
    } catch (e) {
        console.error('会话清理任务异常:', e);
    }
}, SESSION_SWEEP_INTERVAL_MS);

function loger(str) {
    console.log(`[${new Date().toLocaleTimeString()}] ${str}`);
}
// 生成随机会话ID
function generateSessionId() {
    // 使用加密安全随机数生成会话ID，避免可预测
    return crypto.randomBytes(32).toString('hex');
}


// 验证TOTP（兼容旧逻辑），默认允许±1个时间窗口
function verifyTOTP(token, secret) {
    try {
        return speakeasy.totp.verify({
            secret: String(secret),
            encoding: 'base32',
            token: String(token).trim(),
            window: 1
        });
    } catch (e) {
        return false;
    }
}

// 提取请求指纹
function getClientFingerprint(req) {
    const xf = (req.headers['x-forwarded-for'] || '').toString();
    const ip = (xf.split(',')[0] || '').trim() || req.ip || (req.socket && req.socket.remoteAddress) || '';
    const ua = (req.headers['user-agent'] || '').toString();
    return { ip, ua };
}

function getValidAdminSession(sessionId, req) {
    if (!sessionId) return null;
    const s = adminSessions.get(sessionId);
    if (!s) return null;
    if (typeof s.expire === 'number' && s.expire < Date.now()) {
        adminSessions.delete(sessionId);
        return null;
    }

    const fp = getClientFingerprint(req);
    // 默认不绑定IP/UA，可在 config.security.sessionBinding 中开启
    const bind = (config.security && config.security.sessionBinding && config.security.sessionBinding.admin) || { ip: false, ua: false };
    if (bind.ip && s.ip && fp.ip && s.ip !== fp.ip) return null;
    if (bind.ua && s.ua && fp.ua && s.ua !== fp.ua) return null;

    // 滑动过期：每次校验成功就续期
    s.expire = Date.now() + config.security.adminSessionTtlMs;
    adminSessions.set(sessionId, s);
    return s;
}

// 校验玩家 Web Session，返回 session 对象（含 username）或 null
function getValidWebSession(sessionId) {
    if (!sessionId) return null;
    const s = webSessions.get(sessionId);
    if (!s) return null;
    if (typeof s.expire === 'number' && s.expire < Date.now()) {
        webSessions.delete(sessionId);
        return null;
    }

    // 删除用户后：旧 session 立即失效（避免会话残留）
    if (s.username && !userExistsCached(s.username)) {
        webSessions.delete(sessionId);
        return null;
    }

    // 滑动过期
    s.expire = Date.now() + config.security.webSessionTtlMs;
    webSessions.set(sessionId, s);
    return s;
}

// 发送验证邮件
async function sendVerificationEmail(email, code) {
    const mailOptions = {
        from: `"${config.mail.fromName}" <${config.mail.fromAddress}>`,
        to: email,
        subject: config.mail.verificationSubject,
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
                        <h1>${config.mail.fromName}</h1>
                    </div>
                    
                    <p>尊敬的玩家，您的验证码为：</p>
                    <div class="code">${code}</div>
                    <p>有效期5分钟，请尽快使用。</p>
                    
                    <div class="footer">
                        <p>此为系统自动发送邮件，请勿回复</p>
                        <p>© ${new Date().getFullYear()} ${config.mail.fromName}</p>
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
            const timeoutMs = (config && config.status && config.status.fetchTimeoutMs) ? config.status.fetchTimeoutMs : 5000;
            const response = await httpGetJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, timeoutMs);
            if (!response.ok) {
                console.log("获取UUID失败，检查网络配置: " + (response.statusText || `HTTP ${response.status}`));
                return null;
            }
            const data = response.data;
            if (!data || !data.id) {
                console.log("获取UUID失败：返回内容不是预期 JSON");
                return null;
            }
            loger(`玩家 ${name} 的UUID：${data.id}`);
            return data.id;
        } catch (error) {
            console.error("执行命令时出错: " + error);
            return null;
        }

    } else {
        try {
            if (!isValidMinecraftName(name)) {
                console.log("获取UUID失败：用户名不合法");
                return null;
            }
            const { stdout, stderr } = await execFileAsync('python', [UUID_SCRIPT_PATH, name], { windowsHide: true });
            if (stderr) {
                console.log("获取UUID失败，请确认python和getUuid.py文件是否存在: " + stderr);
                return null;
            }
            const uuid = String(stdout || '').trim();
            if (!uuid) {
                console.log("获取UUID失败：脚本未返回UUID");
                return null;
            }
            loger(`玩家 ${name} 的UUID：${uuid}`);
            return uuid;
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

            // 注意：必须在删除 onlinePlayer 之前获取 loginTime，否则可能导致 sessionTime=0
            const loginTime = (value && typeof value.loginTime === 'number') ? value.loginTime : getPlayerLoginTime(key);
            const sessionTime = Math.max(0, Date.now() - loginTime);

            // 自动登出时更新在线时长（仅在确实有会话时累计）
            try {
                if (sessionTime > 0) {
                    withDbTransactionSync(() => {
                        const players = readJsonSafeSync(whitedataFile, []);
                        const playerIndex = players.findIndex(p => p && p.name === key);
                        if (playerIndex !== -1) {
                            players[playerIndex].onlineTime = Number(players[playerIndex].onlineTime || 0) + sessionTime;
                            players[playerIndex].lastLogin = new Date().toLocaleString();
                            writeJsonAtomicSync(whitedataFile, players, 0);
                            loger(`[自动登出] 玩家 ${key} 在线时长更新: +${formatTime(sessionTime)}`);
                        }
                    });
                }
            } catch (error) {
                console.error("自动登出更新在线时长错误:", error);
            }

            // 清理会话记录，避免后续误计时
            if (playerSessions.has(key)) {
                playerSessions.delete(key);
            }

            // 从在线玩家列表中移除
            onlinePlayer.delete(key);
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
        try {
            writeWhitelistFileAtomic(temp);
            console.log(`白名单文件已写入 ${new Date().toLocaleTimeString()}`);
        } catch (err) {
            console.error(`白名单文件写入失败，请检查权限和文件位置 ${new Date().toLocaleTimeString()} ：${err}`);
        } finally {
            haveChange = false;
        }
    }
}, 1000);

function resolveMaybeRelative_DEPRECATED(pth) {
    if (!pth) return pth;
    return path.isAbsolute(pth) ? pth : path.join(__dirname, pth);
}

const portsFilePath = resolveMaybeRelativePath(config.storage.portsFile);
try {
    dbPathToKey.set(portsFilePath, "ports");
    ensureKvKeyFromFile(portsFilePath, "ports", {});
} catch (e) {
    console.error("初始化 ports SQLite KV 映射失败:", e);
}

function tryLoadHttpsOptions() {
    const keyPath = resolveMaybeRelativePath(config.tls && config.tls.keyPath);
    const certPath = resolveMaybeRelativePath(config.tls && config.tls.certPath);

    if (!keyPath || !certPath) {
        console.warn("TLS配置缺失，已禁用HTTPS");
        return null;
    }
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        console.warn(`未检测到TLS证书文件，已禁用HTTPS。key: ${keyPath} cert: ${certPath}`);
        return null;
    }
    try {
        return {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
    } catch (e) {
        console.error("读取TLS证书失败，已禁用HTTPS：", e);
        return null;
    }
}

const httpsOptions = tryLoadHttpsOptions();

// 创建avatars目录
const avatarsDir = resolveMaybeRelativePath(config.storage.avatarsDir);
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
}
// 头像上传接口
app.post('/api/uploadAvatar', async (req, res) => {
    const { username, avatar } = req.body || {};
    const sessionId = (req.headers['x-web-session'] || req.body?.session || req.query?.session || '').toString();

    if (!username || !avatar) {
        return res.status(400).json({ success: false, message: '参数错误' });
    }
    const wsAvatar = getValidWebSession(sessionId);
    if (!wsAvatar || wsAvatar.username !== username) {
        return res.status(401).json({ success: false, message: '会话无效或已过期，请重新登录' });
    }

    // 仅允许 PNG dataURL，避免 SVG/data 注入
    const m = /^data:image\/png;base64,(.*)$/i.exec(String(avatar));
    if (!m || !m[1]) {
        return res.status(400).json({ success: false, message: '仅支持PNG格式头像（data:image/png;base64,...)' });
    }

    const base64Data = m[1];
    const estimatedBytes = Math.ceil(base64Data.length * 3 / 4);
    if (estimatedBytes > config.storage.maxAvatarBytes) {
        return res.status(400).json({ success: false, message: '头像图片过大，请压缩后上传' });
    }

    let buffer;
    try {
        buffer = Buffer.from(base64Data, 'base64');
    } catch (_) {
        return res.status(400).json({ success: false, message: '头像数据不合法' });
    }
    if (!buffer || buffer.length === 0 || buffer.length > config.storage.maxAvatarBytes) {
        return res.status(400).json({ success: false, message: '头像数据不合法或过大' });
    }

    // PNG 魔数校验：89 50 4E 47 0D 0A 1A 0A
    const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(pngSig)) {
        return res.status(400).json({ success: false, message: '头像不是有效的PNG文件' });
    }

    const fileName = `${crypto.randomBytes(16).toString('hex')}_${Date.now()}.png`;
    const filePath = path.join(avatarsDir, fileName);

    try {
        // 写头像文件
        await fs.promises.writeFile(filePath, buffer, { flag: 'wx' });

        // 更新用户数据
        withFileLockSync(whitedataFile, () => {
            const players = readJsonSafeSync(whitedataFile, []);
            const playerIndex = players.findIndex(p => p && p.name === username);
            if (playerIndex === -1) {
                throw new Error('USER_NOT_FOUND');
            }
            // 仅保存文件名，避免路径泄露/路径穿越
            players[playerIndex].avatarPath = fileName;
            writeJsonAtomicSync(whitedataFile, players, 0);
        });

        return res.json({ success: true, avatarUrl: `/avatars/${fileName}` });
    } catch (error) {
        if (error && error.message === 'USER_NOT_FOUND') {
            try { await fs.promises.unlink(filePath); } catch (_) { /* ignore */ }
            return res.status(404).json({ success: false, message: '用户不存在' });
        }
        console.error("上传头像失败:", error);
        return res.status(500).json({ success: false, message: '上传失败' });
    }
});


// 头像访问接口
app.use('/avatars', express.static(avatarsDir));
// Webhook端口更新接口
let portConfig = {};

app.post(config.webhook.updatePortPath, (req, res) => {
    try {
        const { name, host, port } = req.body || {};
        if (!name || !host || port === undefined || port === null) {
            return res.status(400).send('Invalid parameters');
        }
        const portNum = Number.parseInt(String(port), 10);
        if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
            return res.status(400).send('Invalid port');
        }

        const servers = (config.status && Array.isArray(config.status.servers)) ? config.status.servers : [];
        const matched = servers.find(s => s && s.name === name);
        if (!matched) {
            loger(`Webhook拒绝: 未在配置中找到 name=${name}`);
            return res.status(403).send('Unknown server name');
        }
        if (String(matched.host) !== String(host)) {
            loger(`Webhook拒绝: host 不匹配 name=${name} expected=${matched.host} got=${host}`);
            return res.status(403).send('Host mismatch');
        }

        // 以“名称”为主键存储端口（已弃用 ports.json：全部写入数据库）
        withDbTransactionSync(() => {
            const currentPorts = readJsonSafeSync(portsFilePath, {});
            currentPorts[String(name)] = Number(port);
            writeJsonAtomicSync(portsFilePath, currentPorts, 2);
        });
        res.sendStatus(200);
        loger(`Webhook端口更新: ${name} (${host}) -> ${port}`);
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
function extractMinecraftText(node) {
    if (node === null || typeof node === 'undefined') return '';
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (Array.isArray(node)) return node.map(extractMinecraftText).join('');
    if (typeof node === 'object') {
        let out = '';
        if (typeof node.text !== 'undefined') out += extractMinecraftText(node.text);
        if (Array.isArray(node.extra)) out += node.extra.map(extractMinecraftText).join('');
        if (Array.isArray(node.with)) out += node.with.map(extractMinecraftText).join('');
        // 某些服务器会返回 translate 形式的组件；无法本地翻译时至少保留 key
        if (!out && typeof node.translate === 'string') out += node.translate;
        return out;
    }
    return '';
}

function cleanMinecraftText(raw) {
    if (raw === null || typeof raw === 'undefined') return '';

    // 兼容：部分服务端会把聊天组件 JSON 作为字符串返回
    if (typeof raw === 'string') {
        const s = raw.trim();
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
            try { raw = JSON.parse(s); } catch (_) { /* keep as string */ }
        }
    }

    let text = extractMinecraftText(raw);
    text = String(text);

    // 1) 去掉 §x 这类格式码（§ 后面紧跟一个字符）
    text = text.replace(/§./g, '');

    // 2) 规范化换行
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 3) 去掉不可见控制字符（保留换行与制表符）
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');

    // 4) 过滤奇怪符号（保留常见标点、空格与换行）
    //    如需保留更多符号，可在 [] 内追加
    text = text.replace(/[^\p{Script=Han}\p{L}\p{N}\n\t _\-.,:;(){}\[\]【】<>\/\\!?~`'"|+*=&%^$#@—–]/gu, '');

    // 5) 合并空白：行内空白合并为单空格；连续空行压缩
    text = text.split('\n')
        .map(line => line.replace(/[\t ]+/g, ' ').trim())
        .filter(line => line.length > 0)
        .join('\n');

    // 6) 防止超长输出（避免 UI/日志被刷屏）
    if (text.length > 300) text = text.slice(0, 300);

    return text;
}
// 添加后端服务器状态检测API
app.get('/api/serverStatus', async (req, res) => {
    try {
        // 读取最新的端口配置（已弃用 ports.json：全部从数据库读取）
        portConfig = readJsonSafeSync(portsFilePath, {});

        // 服务器列表（配置缺失时返回空）
        const servers = (config.status && Array.isArray(config.status.servers)) ? config.status.servers : [];
        // 检测所有服务器状态
        const serverStatuses = await Promise.all(servers.map(async server => {
            // 优先使用配置中的端口，没有则用默认端口
            const port = portConfig[server.name] || portConfig[server.host] || server.defaultPort;
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
    if (cachedStatus && Date.now() - cachedStatus.timestamp < config.status.cacheTtlMs) {
        return cachedStatus.data;
    }

    // 尝试所有API
    const apiPromises = STATUS_APIS.map(api =>
        fetchWithRetry(api.url(host, port), api.parser, api.name, config.status.maxRetries)
    );

    try {
        // 获取最快的有效响应
        const result = await promiseAnyCompat(apiPromises);

        // 更新缓存
        serverStatusCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        return result;
    } catch (error) {
        loger(`所有API检测均失败: ${error.message}`);

        // 返回最终失败状态
        return {
            online: false,
            players: { online: 0, max: 0 },
            version: '未知',
            motd: '',
            error: '所有状态API均失败'
        };
    }
}

// 带重试的API请求函数
async function fetchWithRetry(url, parser, apiName, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const timeoutMs = (config && config.status && config.status.fetchTimeoutMs) ? config.status.fetchTimeoutMs : 5000;
            const response = await httpGetJson(url, timeoutMs);

            if (!response.ok) {
                throw new Error(`${apiName}请求失败(状态码:${response.status})`);
            }
            if (!response.data) {
                throw new Error(`${apiName}返回内容不是JSON`);
            }
            return parser(response.data);
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

// 端口配置接口
app.get('/ports', (req, res) => {
    try {
        res.json(readJsonSafeSync(portsFilePath, {}));
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
        const players = readJsonSafeSync(whitedataFile, []);
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

        // 安全：密码使用 bcrypt 哈希存储。兼容旧数据（明文）并在首次登录后自动升级为哈希。
        const storedPass = String(player.passwd || '');
        const isHash = storedPass.startsWith('$2a$') || storedPass.startsWith('$2b$') || storedPass.startsWith('$2y$');
        const passOk = isHash ? bcrypt.compareSync(String(password), storedPass) : (storedPass === String(password));

        if (passOk) {
            if (!isHash) {
                // 旧明文密码自动升级为哈希
                player.passwd = bcrypt.hashSync(String(password), 10);
            }
            // 更新最后登录时间
            player.lastLogin = new Date().toLocaleString();
            writeJsonAtomicLockedSync(whitedataFile, players, 0);

            // 创建网页会话
            const sessionId = generateSessionId();
            webSessions.set(sessionId, {
                username: username,
                expire: Date.now() + config.security.webSessionTtlMs // 配置项
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
    const session = (req.headers['x-web-session'] || req.query.session || '').toString();
    if (!username) {
        return res.status(400).json({ success: false, message: "用户名不能为空" });
    }
    const wsInfo = getValidWebSession(session);
    if (!wsInfo || wsInfo.username !== username) {
        return res.status(401).json({ success: false, message: "会话无效或已过期，请重新登录" });
    }

    try {
        const users = readJsonSafeSync(whitedataFile, []);
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
app.get('/api/sign', (req, res) => {
    const username = req.query.username;
    const sessionId = (req.headers['x-web-session'] || req.query.session || '').toString();
    console.log(`签到请求: ${username}`);

    if (!username) {
        return res.status(400).json({ success: false, message: "用户名不能为空" });
    }
    const wsSign = getValidWebSession(sessionId);
    if (!wsSign || wsSign.username !== username) {
        return res.status(401).json({ success: false, message: "会话无效或已过期，请重新登录" });
    }

    try {
        const result = withFileLockSync(signDataFile, () => {
            // 读取签到数据
            let signData = readJsonSafeSync(signDataFile, {});

            // 今日日期（按配置 offset，避免服务器本地时区影响）
            const offset = (config && config.sign && typeof config.sign.timezoneOffsetHours === 'number')
                ? config.sign.timezoneOffsetHours
                : 8;

            const todayStr = getISODateInOffsetHours(offset);
            const yesterdayStr = getISODateInOffsetHours(offset, Date.now() - 24 * 60 * 60 * 1000);

            if (!signData[username]) {
                signData[username] = {
                    totalDays: 0,
                    consecutiveDays: 0,
                    lastSign: "",
                    signHistory: {},
                    points: 0
                };
            }

            if (signData[username].signHistory && signData[username].signHistory[todayStr]) {
                return { success: false, message: "今天已经签到过了" };
            }

            // 连续签到：只以“昨天是否签到”为准
            let consecutiveDays = 1;
            const lastSignDate = String(signData[username].lastSign || '');
            if (lastSignDate === yesterdayStr) {
                consecutiveDays = (Number(signData[username].consecutiveDays) || 0) + 1;
            } else {
                consecutiveDays = 1;
            }

            const basePoints = 10;
            const consecutiveBonus = Math.min(consecutiveDays, 7) * 5;
            const points = basePoints + consecutiveBonus;

            signData[username].totalDays = (Number(signData[username].totalDays) || 0) + 1;
            signData[username].consecutiveDays = consecutiveDays;
            signData[username].lastSign = todayStr;
            signData[username].signHistory = signData[username].signHistory || {};
            signData[username].signHistory[todayStr] = true;
            signData[username].points = (Number(signData[username].points) || 0) + points;

            // 保存签到数据（原子写）
            writeJsonAtomicSync(signDataFile, signData, 2);

            return {
                success: true,
                message: "签到成功",
                points,
                totalPoints: signData[username].points,
                consecutiveDays,
                totalDays: signData[username].totalDays
            };
        });

        return res.json(result);
    } catch (error) {
        console.error("签到系统错误:", error);
        return res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});


// 修改点7：更新排行榜API，添加积分计算
app.get('/api/leaderboard', (req, res) => {
    const session = (req.headers['x-web-session'] || req.headers['x-admin-session'] || req.query.session || '').toString();
    const wsLB = getValidWebSession(session);
    const admLB = getValidAdminSession(session, req);
    if (!wsLB && !admLB) {
        return res.status(401).json({ success: false, message: "会话无效或已过期，请重新登录" });
    }
    try {
        // 读取用户数据
        const players = readJsonSafeSync(whitedataFile, []);
        // 读取签到数据
        const signData = readJsonSafeSync(signDataFile, {});

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
    const session = (req.headers['x-web-session'] || req.query.session || '').toString();
    if (!username) {
        return res.status(400).json({ success: false, message: "用户名不能为空" });
    }
    const wsHistory = getValidWebSession(session);
    if (!wsHistory || wsHistory.username !== username) {
        return res.status(401).json({ success: false, message: "会话无效或已过期，请重新登录" });
    }

    try {
        const signData = readJsonSafeSync(signDataFile, {});

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
    // 已弃用 JSON 文件存储：兑换码全部从数据库读取
    return readJsonSafeSync(couponsFile, []);
}

function writeCouponsFile(data) {
    // 已弃用 JSON 文件存储：兑换码全部写入数据库
    writeJsonAtomicSync(couponsFile, Array.isArray(data) ? data : [], 2);
    return true;
}
// API请求处理

// 安全：管理员登录改为 POST /api/adminLogin，避免密码/TOTP出现在URL中
app.post('/api/adminLogin', async (req, res) => {
    const p = Object.assign({}, req.body || {});
    if (!p.name || !p.passwd || !p.totp) {
        return res.status(400).json({ success: false, message: "参数不完整" });
    }
    try {
        const adminData = ADMIN;
        if (!adminData || !adminData.username || (!adminData.passwordHash && !adminData.password) || !adminData.totpSecret) {
            return res.json({ success: false, message: "管理员配置缺失，请在config.json中配置admin字段" });
        }

        const passwordOk = (adminData.passwordHash)
            ? bcrypt.compareSync(String(p.passwd), String(adminData.passwordHash))
            : (String(p.passwd) === String(adminData.password));

        if (p.name !== adminData.username || !passwordOk) {
            return res.json({ success: false, message: "管理员账号或密码错误" });
        }

        // 验证TOTP
        const verified = verifyTOTP(p.totp, adminData.totpSecret);
        if (!verified) {
            return res.json({ success: false, message: "TOTP验证码错误" });
        }

        // 创建管理员session
        const sessionId = generateSessionId();
        const fp = getClientFingerprint(req);
        const bindCfg = (config.security && config.security.sessionBinding && config.security.sessionBinding.admin) || { ip: false, ua: false };
        adminSessions.set(sessionId, {
            createdAt: Date.now(),
            expire: Date.now() + config.security.adminSessionTtlMs,
            ip: bindCfg.ip ? req.ip : null,
            ua: bindCfg.ua ? req.headers['user-agent'] : null
        });

        return res.json({ success: true, session: sessionId, message: "管理员登录成功" });
    } catch (error) {
        console.error("管理员登录错误:", error);
        return res.json({ success: false, message: "管理员登录失败: " + error.message });
    }
});

app.all('/api', async (req, res) => {
    const p = Object.assign({}, req.query || {}, req.body || {});
    // 支持从 Header 读取 session
    if (!p.session) {
        const hAdmin = req.headers['x-admin-session'];
        const hWeb = req.headers['x-web-session'];
        p.session = (hAdmin || hWeb || '').toString();
    }

    // 检查参数
    const noSpaceFields = ['method', 'name', 'username', 'session', 'code', 'token', 'itemId', 'id'];
    for (const k of noSpaceFields) {
        if (typeof p[k] === 'string' && p[k].includes(' ')) {
            return res.status(400).send("禁止在关键参数中传入空格！");
        }
    }
    if (p.uuid) {
        return res.status(400).send("禁止传入UUID！");
    }
    if (p.loginTime || p.onlineTime) {
        return res.status(400).send("禁止传入时间参数！");
    }

    // 获取所有用户
    if (p.method == "getAllUsers" && p.session) {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            const users = readJsonSafeSync(whitedataFile, []);
            // 不下发敏感字段
            const safeUsers = users.map(u => ({
                name: u?.name,
                email: u?.email,
                status: u?.status,
                joinDate: u?.joinDate,
                onlineTime: u?.onlineTime || 0,
                lastLogin: u?.lastLogin,
                avatarPath: u?.avatarPath ? `/avatars/${path.basename(u.avatarPath)}` : null
            }));
            return res.json({ success: true, users: safeUsers });
        } catch (error) {
            console.error("读取用户数据错误:", error);
            return res.json({ success: false, message: "读取用户数据失败: " + error.message });
        }
    }

    // 激活用户
    if (p.method == "activateUser" && p.name && p.session) {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            const users = readJsonSafeSync(whitedataFile, []);
            const userIndex = users.findIndex(u => u.name === p.name);

            if (userIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            users[userIndex].status = "active";
            writeJsonAtomicLockedSync(whitedataFile, users, 0);
            return res.json({ success: true, message: "用户已激活" });
        } catch (error) {
            console.error("激活用户错误:", error);
            return res.json({ success: false, message: "激活用户失败: " + error.message });
        }
    }

    // 封禁用户
    if (p.method == "banUser" && p.name && p.session) {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            const users = readJsonSafeSync(whitedataFile, []);
            const userIndex = users.findIndex(u => u.name === p.name);

            if (userIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            users[userIndex].status = "banned";
            writeJsonAtomicLockedSync(whitedataFile, users, 0);
            return res.json({ success: true, message: "用户已封禁" });
        } catch (error) {
            console.error("封禁用户错误:", error);
            return res.json({ success: false, message: "封禁用户失败: " + error.message });
        }
    }

    // 解封用户
    if (p.method == "unbanUser" && p.name && p.session) {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            const users = readJsonSafeSync(whitedataFile, []);
            const userIndex = users.findIndex(u => u.name === p.name);

            if (userIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            users[userIndex].status = "active";
            writeJsonAtomicLockedSync(whitedataFile, users, 0);
            return res.json({ success: true, message: "用户已解封" });
        } catch (error) {
            console.error("解封用户错误:", error);
            return res.json({ success: false, message: "解封用户失败: " + error.message });
        }
    }
    // 在API处理部分添加删除用户方法
    if (p.method == "deleteUser" && p.name && p.session) {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            // 读取用户数据
            let players = readJsonSafeSync(whitedataFile, []);

            // 先记录待删除用户（用于清理会话/验证码残留）
            const removedUser = Array.isArray(players) ? players.find(player => player && player.name === p.name) : null;

            // 查找并删除用户
            const initialLength = players.length;
            players = players.filter(player => player.name !== p.name);

            if (players.length === initialLength) {
                return res.json({ success: false, message: "用户不存在" });
            }

            // 保存更新后的用户数据
            writeJsonAtomicLockedSync(whitedataFile, players, 0);

            // 删除用户后：清理其会话/验证码/在线状态残留
            purgeSessionsForUser(p.name, removedUser && removedUser.email);

            return res.json({ success: true, message: "用户已删除" });
        } catch (error) {
            console.error("删除用户错误:", error);
            return res.json({ success: false, message: "删除用户失败: " + error.message });
        }
    }
    // 在API处理部分添加修改邮箱方法
    if (p.method == "updateEmail" && p.name && p.newEmail && p.session) {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            // 读取用户数据
            const players = readJsonSafeSync(whitedataFile, []);
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
            writeJsonAtomicLockedSync(whitedataFile, players, 0);

            return res.json({ success: true, message: "邮箱更新成功" });
        } catch (error) {
            console.error("更新邮箱错误:", error);
            return res.json({ success: false, message: "更新邮箱失败: " + error.message });
        }
    }
    // 添加密码修改API - 需要原密码验证 + webSession
    if (p.method == "changePassword" && p.name && p.oldpasswd && p.newpasswd) {
        // 验证 webSession，防止未登录用户或他人修改密码
        const wsCP = getValidWebSession(p.session);
        if (!wsCP || wsCP.username !== p.name) {
            return res.json({ success: false, message: "会话无效或已过期，请重新登录" });
        }
        try {
            const players = readJsonSafeSync(whitedataFile, []);
            const playerIndex = players.findIndex(player => player.name === p.name);

            if (playerIndex === -1) {
                return res.json({ success: false, message: "用户不存在" });
            }

            // 验证原密码（bcrypt），兼容旧明文并升级
            const storedPassCP = String(players[playerIndex].passwd || '');
            const isHashCP = storedPassCP.startsWith('$2a$') || storedPassCP.startsWith('$2b$') || storedPassCP.startsWith('$2y$');
            const oldOk = isHashCP ? bcrypt.compareSync(String(p.oldpasswd), storedPassCP) : (storedPassCP === String(p.oldpasswd));
            if (!oldOk) {
                return res.json({ success: false, message: "原密码错误" });
            }

            // 更新密码
            players[playerIndex].passwd = bcrypt.hashSync(String(p.newpasswd), 10);
            writeJsonAtomicLockedSync(whitedataFile, players, 0);

            return res.json({ success: true, message: "密码修改成功" });
        } catch (error) {
            console.error("修改密码错误:", error);
            return res.json({ success: false, message: "服务器内部错误" });
        }
    }
    // 添加商品
    if (p.method == "addShopItem") {
        // 管理员会话验证（支持 query/body/header）
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            const { name, itemId, points, stock, amount, image, description } = req.body || {};

            if (!name || !itemId) {
                return res.json({ success: false, message: "参数不完整" });
            }

            const pts = parseInt(points, 10);
            if (!Number.isFinite(pts) || pts < 0) {
                return res.json({ success: false, message: "积分(points)不合法" });
            }

            const amt = parseInt(amount, 10);
            const finalAmount = (Number.isFinite(amt) && amt > 0) ? amt : 1;

            // stock 允许为空：表示无限库存（存 null）
            let finalStock = null;
            if (stock !== undefined && stock !== null && String(stock).trim() !== "") {
                const st = parseInt(stock, 10);
                if (!Number.isFinite(st) || st < 0) {
                    return res.json({ success: false, message: "库存(stock)不合法" });
                }
                finalStock = st;
            }

            const newItem = {
                id: Date.now().toString(),
                name: String(name),
                itemId: String(itemId),
                amount: finalAmount,
                points: pts,
                stock: finalStock,
                image: (image && String(image).trim()) ? String(image).trim() : 'images/default_item.png',
                description: (description && String(description).trim()) ? String(description).trim() : '暂无描述',
                createdAt: new Date().toISOString()
            };

            // 读-改-写：锁住 shopItemsFile，避免并发覆盖
            const items = withFileLockSync(shopItemsFile, () => {
                const arr = readJsonSafeSync(shopItemsFile, []);
                arr.push(newItem);
                writeJsonAtomicSync(shopItemsFile, arr, 2);
                return arr;
            });

            return res.json({ success: true, message: "商品添加成功", item: newItem, total: items.length });
        } catch (error) {
            console.error("添加商品错误:", error);
            return res.json({ success: false, message: "添加商品失败" });
        }
    }

    // 更新商品
    if (p.method == "updateShopItem") {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }
        try {
            const { id, name, itemId, points, stock, amount, image, description } = req.body || {};
            if (!id) return res.json({ success: false, message: "缺少商品ID" });

            const pts = parseInt(points, 10);
            if (!Number.isFinite(pts) || pts < 0) {
                return res.json({ success: false, message: "积分(points)不合法" });
            }

            const amt = parseInt(amount, 10);
            const finalAmount = (Number.isFinite(amt) && amt > 0) ? amt : 1;

            let finalStock = null;
            if (stock !== undefined && stock !== null && String(stock).trim() !== "") {
                const st = parseInt(stock, 10);
                if (!Number.isFinite(st) || st < 0) {
                    return res.json({ success: false, message: "库存(stock)不合法" });
                }
                finalStock = st;
            }

            const updated = withFileLockSync(shopItemsFile, () => {
                const items = readJsonSafeSync(shopItemsFile, []);
                const itemIndex = items.findIndex(item => item && item.id === String(id));
                if (itemIndex === -1) return null;

                items[itemIndex] = {
                    ...items[itemIndex],
                    name: String(name ?? items[itemIndex].name),
                    itemId: String(itemId ?? items[itemIndex].itemId),
                    amount: finalAmount,
                    points: pts,
                    stock: finalStock,
                    image: (image && String(image).trim()) ? String(image).trim() : (items[itemIndex].image || 'images/default_item.png'),
                    description: (description && String(description).trim()) ? String(description).trim() : (items[itemIndex].description || '暂无描述'),
                    updatedAt: new Date().toISOString()
                };

                writeJsonAtomicSync(shopItemsFile, items, 2);
                return items[itemIndex];
            });

            if (!updated) return res.json({ success: false, message: "商品不存在" });
            return res.json({ success: true, message: "商品更新成功", item: updated });
        } catch (error) {
            console.error("更新商品错误:", error);
            return res.json({ success: false, message: "更新商品失败" });
        }
    }

    // 删除商品
    if (p.method == "deleteShopItem" && p.itemId) {
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }
        try {
            const removed = withFileLockSync(shopItemsFile, () => {
                const items = readJsonSafeSync(shopItemsFile, []);
                const newItems = items.filter(item => item && item.id !== String(p.itemId));
                if (newItems.length === items.length) return false;
                writeJsonAtomicSync(shopItemsFile, newItems, 2);
                return true;
            });

            if (!removed) {
                return res.json({ success: false, message: "商品不存在" });
            }
            return res.json({ success: true, message: "商品删除成功" });
        } catch (error) {
            console.error("删除商品错误:", error);
            return res.json({ success: false, message: "删除商品失败" });
        }
    }

    // 获取商品列表
    if (p.method == "getShopItems") {
        try {
            const items = readJsonSafeSync(shopItemsFile, []);
            return res.json({ success: true, items });
        } catch (error) {
            console.error("获取商品列表错误:", error);
            return res.json({ success: false, message: "获取商品列表失败" });
        }
    }
    if (p.method == "purchaseItem" && p.username && p.itemId) {
        const sessionId = (req.headers['x-web-session'] || p.session || '').toString();
        const wsPurch = getValidWebSession(sessionId);
        if (!wsPurch || wsPurch.username !== p.username) {
            return res.json({ success: false, message: "会话无效或已过期，请重新登录" });
        }

        try {
            const username = String(p.username);
            const itemId = String(p.itemId);

            const result = withMultiFileLocksSync([signDataFile, shopItemsFile, couponsFile], () => {
                const items = readJsonSafeSync(shopItemsFile, []);
                const idx = items.findIndex(i => i && String(i.id) === itemId);
                if (idx === -1) {
                    return { success: false, message: "商品不存在" };
                }
                const item = items[idx];

                const unlimited = (item.stock === null || item.stock === undefined || item.stock === '');
                const stockNum = unlimited ? null : parseInt(item.stock, 10);
                if (stockNum !== null && (!Number.isFinite(stockNum) || stockNum <= 0)) {
                    return { success: false, message: "商品已售罄" };
                }

                const signData = readJsonSafeSync(signDataFile, {});
                if (!signData[username]) {
                    signData[username] = {
                        totalDays: 0,
                        consecutiveDays: 0,
                        lastSign: "",
                        signHistory: {},
                        points: 0
                    };
                }
                const userPoints = Number(signData[username].points) || 0;
                const needPoints = parseInt(item.points, 10) || 0;

                if (userPoints < needPoints) {
                    return { success: false, message: "积分不足" };
                }

                // 扣减积分
                signData[username].points = userPoints - needPoints;

                // 扣减库存（仅有限库存）
                if (stockNum !== null) {
                    items[idx].stock = stockNum - 1;
                } else {
                    items[idx].stock = null; // 统一存 null 表示无限
                }

                // 生成兑换码
                const couponCode = generateCouponCode();
                const coupons = readJsonSafeSync(couponsFile, []);

                const amt = parseInt(item.amount, 10);
                const finalAmount = (Number.isFinite(amt) && amt > 0) ? amt : 1;

                coupons.push({
                    code: couponCode,
                    type: 'item',
                    items: [{
                        itemId: String(item.itemId),
                        amount: finalAmount
                    }],
                    designatedPlayer: username,
                    oneTimeUse: true,
                    expiresAt: new Date(Date.now() + config.shop.couponValidityMs).toISOString(),
                    createdAt: new Date().toISOString(),
                    used: false,
                    usedBy: []
                });

                // 写回（原子写）
                writeJsonAtomicSync(signDataFile, signData, 2);
                writeJsonAtomicSync(shopItemsFile, items, 2);
                writeJsonAtomicSync(couponsFile, coupons, 2);

                return {
                    success: true,
                    coupon: couponCode,
                    item: items[idx],
                    message: "兑换成功！有效期3天，请尽快使用"
                };
            });

            return res.json(result);
        } catch (error) {
            console.error("兑换商品错误:", error);
            return res.json({ success: false, message: "兑换失败" });
        }
    }

    // 修改兑换码生成逻辑
    if (p.method == "generateCoupon" && p.session) {
        // 新增：管理员会话验证
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }
        try {
            const session = p.session;
            // 从请求体中获取参数
            const { type, items, expiresAt, designatedPlayer, oneTimeUse } = req.body;

            // 读取兑换码数据
            const coupons = readJsonSafeSync(couponsFile, []);

            // 生成兑换码
            const couponCode = generateCouponCode();

            // 创建新兑换码对象
            const newCoupon = {
                code: couponCode,
                type, // 类型：item 或 bundle
                items, // 物品数组 [{itemId, amount}]
                designatedPlayer: designatedPlayer || null,
                expiresAt: new Date(expiresAt).toISOString(),
                oneTimeUse: (oneTimeUse === true || oneTimeUse === "true"),
                createdAt: new Date().toISOString(),
                used: false,
                usedBy: []
            };

            // 添加到列表并保存
            coupons.push(newCoupon);
            writeJsonAtomicLockedSync(couponsFile, coupons, 2);

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
        if (!p.session || !getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "需要有效的管理员会话" });
        }
        try {
            const coupons = readJsonSafeSync(couponsFile, []);
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
        if (!getValidAdminSession(p.session, req)) {
            return res.json({ success: false, message: "管理员会话无效或已过期" });
        }

        try {
            const coupons = readJsonSafeSync(couponsFile, []);
            const initialLength = coupons.length;

            // 关键修复：统一转换为大写比较
            const codeToDelete = p.code.toUpperCase();
            const newCoupons = coupons.filter(coupon =>
                coupon.code.toUpperCase() !== codeToDelete
            );

            if (newCoupons.length === initialLength) {
                return res.json({ success: false, message: "兑换码不存在" });
            }

            writeJsonAtomicLockedSync(couponsFile, newCoupons, 0);
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
        for (let i = 0; i < config.shop.couponLength; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    if (p.name && p.method == "login") {
        // 新增：拦截管理员账号的玩家登录
        if (p.name.toLowerCase() === "admin") {
            return res.send("管理员账号请使用管理员登录");
        }
        // 新增：检查用户名是否包含@
        if (p.name.includes('@')) {
            return res.send("用户名不能包含@符号！");
        }
        // 验证 webSession，确保是本人操作
        const wsLogin = getValidWebSession(p.session);
        if (!wsLogin || wsLogin.username !== p.name) {
            return res.send("会话无效或已过期，请重新登录");
        }
        try {
            const players = readJsonSafeSync(whitedataFile, []);
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

            // 若提供密码则进行校验；若未提供密码，则认为已通过 webSession 验证
            let passOkLogin = true;
            if (typeof p.passwd !== 'undefined' && p.passwd !== null && String(p.passwd).length > 0) {
                const storedPassLogin = String(player.passwd || '');
                const isHashLogin = storedPassLogin.startsWith('$2a$') || storedPassLogin.startsWith('$2b$') || storedPassLogin.startsWith('$2y$');
                passOkLogin = isHashLogin
                    ? bcrypt.compareSync(String(p.passwd), storedPassLogin)
                    : (storedPassLogin === String(p.passwd));

                if (passOkLogin && !isHashLogin) {
                    player.passwd = bcrypt.hashSync(String(p.passwd), 10);
                    writeJsonAtomicLockedSync(whitedataFile, players, 0);
                }
            }

            if (passOkLogin) {
                loger(`玩家 ${p.name} 登录`);

                // 更新最后登录时间
                player.lastLogin = new Date().toLocaleString();
                writeJsonAtomicLockedSync(whitedataFile, players, 0);

                // 修复：p.time 来自 query/body 通常是字符串，必须转为数字，否则 Date.now()+onlineTime 会变成字符串拼接
                const requestedMs = Number.parseInt(p.time, 10);
                const onlineTime = Number.isFinite(requestedMs) && requestedMs > 0 && requestedMs <= maxOnlineTime
                    ? requestedMs
                    : maxOnlineTime;

                if (onlinePlayer.has(p.name)) {
                    onlinePlayer.get(p.name).onlineTime = Date.now() + onlineTime;
                    return res.send(`你的再次登录已确认，时间已延长，当前在线时间${formatTime(onlineTime)}`);
                } else {

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
            const players = readJsonSafeSync(whitedataFile, []);
            const player = players.find(player => player.name === p.name);

            if (!player) {
                return res.send("该用户不存在！");
            }

            // 可选：如果前端传了 email，则必须与注册邮箱一致（更安全，也能避免用户填错邮箱导致无法验证）
            if (p.email) {
                const given = String(p.email).trim().toLowerCase();
                const stored = String(player.email || '').trim().toLowerCase();
                if (!stored || given !== stored) {
                    return res.send("邮箱与注册邮箱不匹配");
                }
            }

            const code = generateVerificationCode();
            verificationCodes.set(player.email, {
                code,
                expire: Date.now() + config.security.verificationCodeTtlMs,
                name: player.name,
                newPasswordHash: bcrypt.hashSync(String(p.newpasswd), 10)
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
            const players = readJsonSafeSync(whitedataFile, []);
            const playerIndex = players.findIndex(u => u.name === record.name);

            if (playerIndex === -1) {
                return res.send("用户不存在");
            }

            players[playerIndex].passwd = record.newPasswordHash;
            writeJsonAtomicLockedSync(whitedataFile, players, 0);
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
            const players = readJsonSafeSync(whitedataFile, []);

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
                expire: Date.now() + config.security.verificationCodeTtlMs,
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
            const players = readJsonSafeSync(whitedataFile, []);

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
                passwd: bcrypt.hashSync(String(record.passwd), 10),
                email: p.email,
                status: "inactive",
                points: 0,
                joinDate: new Date().toLocaleDateString(),
                onlineTime: 0,
                lastLogin: ''
            });

            // 修复：使用正确的文件路径
            writeJsonAtomicLockedSync(whitedataFile, players, 0);

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
    else if (p.name && p.method == "logout") {
        // 验证 webSession，确保是本人操作
        const wsLogout = getValidWebSession(p.session);
        if (!wsLogout || wsLogout.username !== p.name) {
            return res.send("会话无效或已过期，请重新登录");
        }

        try {
            const now = Date.now();
            const isOnline = onlinePlayer.has(p.name) || playerSessions.has(p.name);
            const loginTime = (onlinePlayer.has(p.name) && onlinePlayer.get(p.name) && typeof onlinePlayer.get(p.name).loginTime === 'number')
                ? onlinePlayer.get(p.name).loginTime
                : getPlayerLoginTime(p.name);
            const sessionTime = isOnline ? Math.max(0, now - loginTime) : 0;

            const players = readJsonSafeSync(whitedataFile, []);
            const player = players.find(player => player && player.name === p.name);

            if (!player) {
                // 找不到玩家也清理会话，避免悬挂
                webSessions.delete(p.session);
                if (playerSessions.has(p.name)) playerSessions.delete(p.name);
                if (onlinePlayer.has(p.name)) {
                    onlinePlayer.delete(p.name);
                    haveChange = true;
                    queryChange = true;
                }
                return res.send("您不在数据库中，请注册！");
            }

            // 若提供密码则校验；否则仅依赖 webSession 验证
            let passOkLogout = true;
            let dirty = false;

            if (typeof p.passwd !== 'undefined' && p.passwd !== null && String(p.passwd).length > 0) {
                const storedPassLogout = String(player.passwd || '');
                const isHashLogout = storedPassLogout.startsWith('$2a$') || storedPassLogout.startsWith('$2b$') || storedPassLogout.startsWith('$2y$');
                passOkLogout = isHashLogout
                    ? bcrypt.compareSync(String(p.passwd), storedPassLogout)
                    : (storedPassLogout === String(p.passwd));

                // 明文密码命中后自动升级为 bcrypt
                if (passOkLogout && !isHashLogout) {
                    player.passwd = bcrypt.hashSync(String(p.passwd), 10);
                    dirty = true;
                }
            }

            if (!passOkLogout) {
                return res.send("登出失败：密码错误！");
            }

            // 只在确实在线时累计在线时长（防止离线登出误计）
            if (isOnline && sessionTime > 0) {
                player.onlineTime = Number(player.onlineTime || 0) + sessionTime;
                player.lastLogin = new Date().toLocaleString();
                dirty = true;
                loger(`玩家 ${p.name} 登出，在线时长更新: +${formatTime(sessionTime)}`);
            } else {
                loger(`玩家 ${p.name} 登出`);
            }

            if (dirty) {
                writeJsonAtomicLockedSync(whitedataFile, players, 0);
            }

            // 清理在线状态与会话
            if (onlinePlayer.has(p.name)) {
                onlinePlayer.delete(p.name);
                haveChange = true;
                queryChange = true;
            }
            if (playerSessions.has(p.name)) playerSessions.delete(p.name);
            webSessions.delete(p.session);

            if (isOnline) {
                return res.send(`玩家${p.name}已退出登录！`);
            } else {
                return res.send(`玩家${p.name}现在不是登录状态！`);
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

// -------------------- 全局错误处理（避免抛错导致进程崩溃/继续写入） --------------------
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) return next(err);
    const msg = (err && typeof err.message === 'string' && err.message.startsWith('READ_JSON_FAILED'))
        ? '数据读取失败：JSON 数据可能已损坏，请检查数据库内容或最近的写入操作'
        : '服务器内部错误';
    return res.status(500).json({ success: false, message: msg });
});

// 创建HTTPS服务器（如证书存在）
if (httpsOptions) {
    https.createServer(httpsOptions, app).listen(config.http.httpsPort, () => {
        console.log(`HTTPS服务器运行在端口 ${config.http.httpsPort}`);
    });
} else {
    console.log("未启用HTTPS（未检测到或无法读取证书）");
}

function promptHttpWarning() {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) {
            console.warn("安全警告：检测到将启动 HTTP（明文传输）。当前环境非交互模式，默认继续运行。建议启用 HTTPS。");
            return resolve('1');
        }

        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        console.warn("\n================ 安全警告 ================");
        console.warn("你正在启动 HTTP 服务（明文传输）。这会导致：");
        console.warn(" - 登录/会话可能被中间人窃听或篡改");
        console.warn(" - 管理员/用户凭据风险显著增加");
        console.warn("------------------------------------------");
        console.warn("请选择：");
        console.warn("  1) 继续运行（仍会启动HTTP）");
        console.warn("  2) 退出（推荐，先配置HTTPS）");
        console.warn("==========================================\n");

        rl.question("输入 1 或 2 并回车：", (answer) => {
            rl.close();
            const a = String(answer || '').trim();
            resolve(a === '2' ? '2' : '1');
        });
    });
}

function startHttpServers() {
    http.createServer(app).listen(config.http.httpPort, () => {
        console.log(`HTTP服务器运行在端口 ${config.http.httpPort}`);
    });
    // 插件交互HTTP服务器
    http.createServer((req, res) => {
        const remote = req.socket.remoteAddress;
        const remoteNorm = (typeof remote === 'string' && remote.startsWith('::ffff:')) ? remote.slice('::ffff:'.length) : remote;
        const allowed = config.plugin.allowedIPs.includes(remote) || config.plugin.allowedIPs.includes(remoteNorm);

        loger(`<插件操作> IP: ${remote} 请求方法: ${req.method} 操作: ${req.url}`);
        if (allowed) {
            if (req.url == "/") {
                loger(`<插件操作> IP: ${remote} 访问了 测试链接`);
                res.writeHead(200);
                res.end();
                return;
            }
            if (req.url == "/change") {
                loger(`<插件操作> IP: ${remote} 访问了 查询是否需要刷新`);
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
                loger(`<插件操作> IP: ${remote} 访问了 查询玩家是否允许进入`);
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
                loger(`<插件操作> IP: ${remote} 访问了 登录玩家`);
                let name = req.url.slice(7);
                try {
                    const players = readJsonSafeSync(whitedataFile, []);

                    // 若已在线：仅延长有效期，不重置 loginTime（避免少算在线时长）
                    if (onlinePlayer.has(name)) {
                        const rec = onlinePlayer.get(name);
                        if (rec && typeof rec.loginTime === 'number' && !playerSessions.has(name)) {
                            playerSessions.set(name, rec.loginTime);
                        }
                        onlinePlayer.get(name).onlineTime = Date.now() + maxOnlineTime;
                        res.writeHead(200);
                        res.end();
                        return;
                    }

                    const player = players.find(p => p.name === name);
                    if (player) {
                        const now = Date.now();
                        // 仅在真正登录成功时记录会话开始时间
                        playerSessions.set(name, now);
                        onlinePlayer.set(name, {
                            uuid: player.uuid,
                            name: player.name,
                            loginTime: now,
                            onlineTime: now + maxOnlineTime
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
                loger(`<插件操作> IP: ${remote} 访问了 登出玩家`);
                const name = req.url.slice(8);

                if (!name || name.trim() === "") {
                    res.writeHead(400);
                    res.end();
                    return;
                }

                const now = Date.now();
                const wasOnline = onlinePlayer.has(name) || playerSessions.has(name);
                const loginTime = (onlinePlayer.has(name) && onlinePlayer.get(name) && typeof onlinePlayer.get(name).loginTime === 'number')
                    ? onlinePlayer.get(name).loginTime
                    : (playerSessions.has(name) ? playerSessions.get(name) : now);
                const sessionTime = wasOnline ? Math.max(0, now - loginTime) : 0;

                // 仅在玩家确实在线时累计在线时长，避免离线调用 /logout 造成误计
                if (wasOnline && sessionTime > 0) {
                    try {
                        withDbTransactionSync(() => {
                            const players = readJsonSafeSync(whitedataFile, []);
                            const playerIndex = players.findIndex(p => p && p.name === name);
                            if (playerIndex !== -1) {
                                players[playerIndex].onlineTime = Number(players[playerIndex].onlineTime || 0) + sessionTime;
                                players[playerIndex].lastLogin = new Date().toLocaleString();
                                writeJsonAtomicLockedSync(whitedataFile, players, 0);
                                loger(`玩家 ${name} 在线时长更新: +${formatTime(sessionTime)}，总时长: ${formatTime(players[playerIndex].onlineTime)}`);
                            }
                        });
                    } catch (error) {
                        console.error("更新在线时长错误:", error);
                    }
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
                    // 不在线则不累计时长，直接返回 404
                    res.writeHead(404);
                    res.end();
                    return;
                }
            }

        } else {
            loger(`<插件操作> IP: ${remote} 访问被拒绝`);
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("forbidden");
        }
    }).listen(config.http.pluginPort, () => {
        console.log(`插件交互端口：${config.http.pluginPort}，请勿转发此端口，防火墙请屏蔽此端口`);
    });
}

promptHttpWarning().then((choice) => {
    if (choice === '2') {
        console.log("已选择退出：请配置 HTTPS 后再启动。");
        process.exit(0);
    }
    startHttpServers();
});
