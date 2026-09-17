// WorkBuddy 本地助理 - 网页聊天桥接服务端
// 纯 Node 内置模块,无外部依赖。
// 登录 = 页面访问密码(默认 77,可在设置页改);
// 默认通道 = 本地直连(用 WorkBuddy 自带 CLI 起本地服务,不需要 client_id/云端授权);
// 可选回退 = 官方 Open API 云端中转(仅在本地失败且配了凭据时)。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const TOKEN_PATH = path.join(ROOT, CONFIG.token_file || 'token.json');
const SETTINGS_PATH = path.join(ROOT, CONFIG.settings_file || 'settings.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WB_HOME = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');

// ---------------- 本地直连(默认模式):不需要 client_id / 云端授权 ----------------
const { LocalGateway, LOCAL_MODELS, findCli } = require('./localgw');
let localgw = null;
function getLocal() {
  if (!localgw) {
    if (!SETTINGS.local) SETTINGS.local = {};
    if (!SETTINGS.local.password) { SETTINGS.local.password = 'wb-' + crypto.randomBytes(16).toString('hex'); saveSettings(); }
    localgw = new LocalGateway({
      cli: findCli(),
      port: CONFIG.local_port || 8791,
      password: SETTINGS.password || SETTINGS.local.password,
      model: (SETTINGS.model && SETTINGS.model.preferred) || '',
      cwd: ROOT,
    });
  }
  return localgw;
}
function localEnabled() { return SETTINGS.local_enabled !== false; }
// 全局互斥:同一时刻只允许一个对话任务(CLI 单会话,并发会互相冲突)
let chatBusy = false;

// ---------------- 设置(访问密码 / 偏好) ----------------
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (_) {}
  if (!s.session_secret) s.session_secret = crypto.randomBytes(24).toString('hex');
  if (!s.password_hash) s.password_hash = sha256(CONFIG.access_password || '77');
  if (!s.poll_timeout_ms) s.poll_timeout_ms = CONFIG.poll_timeout_ms || 120000;
  s.ui = Object.assign({ dark: false, showTime: true, showRole: false }, s.ui || {});
  s.model = Object.assign({ preferred: '', send_model: true }, s.model || {});
  return s;
}
let SETTINGS = loadSettings();
function saveSettings() { try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(SETTINGS, null, 2)); } catch (_) {} }
saveSettings();

// ---------------- token 存储(运行时落盘,重启保留绑定) ----------------
let tokenStore = null;
try { tokenStore = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch (_) {}

const states = new Map();

function saveToken(t) { tokenStore = t; try { fs.writeFileSync(TOKEN_PATH, JSON.stringify(t)); } catch (_) {} }
function tokenValid() {
  return tokenStore && tokenStore.access_token && (!tokenStore.expires_at || tokenStore.expires_at > Date.now() + 30000);
}
async function refreshToken() {
  if (!tokenStore || !tokenStore.refresh_token) throw new Error('no_refresh');
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: tokenStore.refresh_token,
    client_id: CONFIG.client_id, client_secret: CONFIG.client_secret,
  });
  const r = await fetch(`${CONFIG.auth_base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json();
  if (j.access_token) {
    saveToken({ access_token: j.access_token, refresh_token: j.refresh_token || tokenStore.refresh_token, expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null });
    return tokenStore.access_token;
  }
  throw new Error('refresh_failed');
}
async function getAccessToken() {
  if (tokenValid()) return tokenStore.access_token;
  if (tokenStore && tokenStore.refresh_token) return await refreshToken();
  return null;
}
async function apiCall(method, urlPath, bodyObj) {
  let token = await getAccessToken();
  if (!token) { const e = new Error('need_auth'); e.needAuth = true; throw e; }
  const doFetch = (tk) => {
    const headers = { Authorization: `Bearer ${tk}`, Accept: 'application/json' };
    const opt = { method, headers };
    if (bodyObj) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(bodyObj); }
    return fetch(`${CONFIG.auth_base}${urlPath}`, opt);
  };
  let res = await doFetch(token);
  if (res.status === 401 && tokenStore && tokenStore.refresh_token) { token = await refreshToken(); res = await doFetch(token); }
  return res;
}
// ---------------- 设备授权码流程(device authorization grant) ----------------
// 比授权码流程更"自动":无需配置 redirect_uri 回调地址。
// 流程:设备码发起 -> 用户在 workbuddy.cn 授权页输入 user_code 批准 -> 服务端轮询换取 token。
let deviceState = null; // { device_code, user_code, verification_uri, interval, expires_at }
function deviceStartUrl() { return CONFIG.device_authorize_url || (CONFIG.auth_base + '/device/authorize'); }

async function deviceStart() {
  if (!hasCreds()) throw new Error('no_creds');
  const body = new URLSearchParams({ client_id: CONFIG.client_id, scope: CONFIG.scopes });
  if (CONFIG.client_secret && !String(CONFIG.client_secret).startsWith('YOUR_')) body.set('client_secret', CONFIG.client_secret);
  const r = await fetch(deviceStartUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (j.device_code) {
    deviceState = {
      device_code: j.device_code,
      user_code: j.user_code || '',
      verification_uri: j.verification_uri || j.verification_url || '',
      interval: Number(j.interval) || 5,
      expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : Date.now() + 600000,
    };
    return { ok: true, user_code: deviceState.user_code, verification_uri: deviceState.verification_uri, interval: deviceState.interval, expires_in: j.expires_in };
  }
  return { ok: false, status: r.status, raw: j };
}

async function devicePoll() {
  if (!deviceState) return { status: 'none' };
  if (Date.now() > deviceState.expires_at) { deviceState = null; return { status: 'expired' }; }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceState.device_code,
    client_id: CONFIG.client_id,
  });
  if (CONFIG.client_secret && !String(CONFIG.client_secret).startsWith('YOUR_')) body.set('client_secret', CONFIG.client_secret);
  const r = await fetch(`${CONFIG.auth_base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.access_token) {
    saveToken({ access_token: j.access_token, refresh_token: j.refresh_token || null, expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null });
    deviceState = null;
    return { status: 'bound', open_id: j.open_id };
  }
  const err = j.error;
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') { deviceState.interval += 5; return { status: 'pending', slow_down: true }; }
  if (err === 'expired_token') { deviceState = null; return { status: 'expired' }; }
  if (err === 'access_denied') { deviceState = null; return { status: 'denied' }; }
  return { status: 'error', error: err || ('http_' + r.status), raw: j };
}

async function pollReply(sentId) {
  const deadline = Date.now() + (SETTINGS.poll_timeout_ms || 120000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < deadline) {
    const res = await apiCall('GET', `/localassistant/message?message_id=${encodeURIComponent(sentId)}`);
    const j = await res.json();
    const msgs = (j.data && j.data.messages) || [];
    const assistant = msgs.filter((m) => m.role === 'assistant');
    if (assistant.length) {
      return assistant.map((m) => (Array.isArray(m.content) ? m.content.join('') : (m.content || ''))).join('\n');
    }
    await sleep(CONFIG.poll_interval_ms || 1500);
  }
  return null;
}

// ---------------- 访问会话(cookie) ----------------
function signSession(exp) { return crypto.createHmac('sha256', SETTINGS.session_secret).update('sess:' + exp).digest('hex'); }
function makeSessionCookie() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const val = `${exp}.${signSession(exp)}`;
  return `wbsess=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
}
function clearSessionCookie() { return 'wbsess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'; }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function isLoggedIn(req) {
  const c = parseCookies(req).wbsess;
  if (!c) return false;
  const [exp, h] = c.split('.');
  if (!exp || !h || Number(exp) < Date.now()) return false;
  const want = signSession(exp);
  return h.length === want.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(want));
}

// ---------------- 模型目录(读桌面 App 缓存,只读;失败则降级) ----------------
function readModelCatalog() {
  const out = []; const seen = new Set();
  const add = (id, name, desc, vendor) => {
    if (!id || seen.has(id)) return; seen.add(id);
    out.push({ id, name: name || id, desc: desc || '', vendor: vendor || '' });
  };
  try {
    const dir = path.join(WB_HOME, 'local_storage');
    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith('.info')) continue;
      let arr;
      try { arr = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); } catch (_) { continue; }
      const data = Array.isArray(arr) && arr[0] && arr[0].data;
      if (data && Array.isArray(data.models)) {
        for (const m of data.models) if (m && m.id) add(m.id, m.displayName || m.name, m.descriptionZh || m.description, 'WorkBuddy');
      }
    }
  } catch (_) {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WB_HOME, 'models.json'), 'utf8'));
    for (const m of (j.models || [])) add(m.id, m.name, m.vendor || '自定义', m.vendor || '自定义');
  } catch (_) {}
  return out;
}

// ---------------- 工具 ----------------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const CHATLOG = path.join(ROOT, 'chat.log');
function logChat(s) { try { fs.appendFileSync(CHATLOG, new Date().toISOString() + ' ' + s + '\n'); } catch (_) {} }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e7) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function serveFile(res, file, type) {
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('file not found: ' + path.basename(file));
  }
}
function hasCreds() {
  return !!CONFIG.client_id && !String(CONFIG.client_id).startsWith('YOUR_') &&
         !!CONFIG.client_secret && !String(CONFIG.client_secret).startsWith('YOUR_');
}
function mask(v) { if (!v) return ''; const s = String(v); return s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-2); }
// 本机局域网 IPv4(给设置页显示"这台网页服务跑在哪")
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of (ifs[name] || [])) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '';
}

// 友好提示页(替代纯文本报错,给个按钮回设置)
function sendNotice(res, status, title, lines, actionHref, actionText) {
  const body = lines.map((l) => `<p>${l}</p>`).join('');
  const btn = actionHref ? `<a class="btn" href="${actionHref}">${actionText || '去设置'}</a>` : '';
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
background:#f2f3f5;color:#1f2329;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border:1px solid #e5e6eb;border-radius:14px;padding:28px 26px;max-width:460px;width:100%;
box-shadow:0 10px 34px rgba(0,0,0,.07);text-align:center}
.ico{font-size:38px;line-height:1}p{font-size:14px;color:#4e5969;line-height:1.7;margin:10px 0}
h2{font-size:17px;margin:6px 0 2px}code{background:#f2f3f5;padding:2px 6px;border-radius:4px;font-size:13px}
.btn{display:inline-block;margin-top:14px;background:#165dff;color:#fff;text-decoration:none;
padding:10px 20px;border-radius:8px;font-size:14px}
.btn:hover{background:#0e42d2}
</style></head><body><div class="card"><div class="ico">⚠️</div><h2>${title}</h2>${body}${btn}</div></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    const P = u.pathname;

    // 静态页
    if (P === '/' || P === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    if (P === '/settings' || P === '/settings.html') return serveFile(res, path.join(PUBLIC_DIR, 'settings.html'), 'text/html; charset=utf-8');

    // 登录状态(公开)
    if (P === '/api/authinfo') {
      return sendJson(res, 200, { loggedIn: isLoggedIn(req), bound: !!(tokenStore && tokenStore.access_token), hasCreds: hasCreds() });
    }
    // 用密码登录(设置页改过的密码优先;config.json 里的 access_password 永远作为兜底可用)
    if (P === '/api/login' && req.method === 'POST') {
      const { password } = JSON.parse((await readBody(req)) || '{}');
      const ok = password != null && (
        (SETTINGS.password_hash && sha256(password) === SETTINGS.password_hash) ||
        (CONFIG.access_password && String(password) === String(CONFIG.access_password))
      );
      if (ok) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': makeSessionCookie() });
        return res.end(JSON.stringify({ ok: true }));
      }
      return sendJson(res, 401, { ok: false, error: '密码不对' });
    }
    // 退出(清页面会话)
    if (P === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearSessionCookie() });
      return res.end(JSON.stringify({ ok: true }));
    }

    // OAuth 绑定/回调(公开,一次性绑定)
    if (P === '/auth/login') {
      if (!hasCreds()) { res.writeHead(302, { Location: '/settings?need=creds' }); return res.end(); }
      const state = crypto.randomUUID();
      states.set(state, Date.now() + 600000);
      const authUrl = `${CONFIG.auth_base}/authorize?response_type=code` +
        `&client_id=${encodeURIComponent(CONFIG.client_id)}` +
        `&redirect_uri=${encodeURIComponent(CONFIG.redirect_uri)}` +
        `&scope=${encodeURIComponent(CONFIG.scopes)}&state=${state}`;
      res.writeHead(302, { Location: authUrl }); return res.end();
    }
    if (P === '/auth/callback') {
      const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
      if (!code || !state || !states.has(state)) return sendNotice(res, 400, '授权失败', ['授权回跳的 <code>state</code> 校验没通过，或缺少 <code>code</code>。', '一般是授权链接过期（超过 10 分钟）或重复刷新回调页导致的。', '重新点一次「绑定本机 WorkBuddy」即可。'], '/settings', '回设置页');
      states.delete(state);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CONFIG.redirect_uri, client_id: CONFIG.client_id, client_secret: CONFIG.client_secret });
      const r = await fetch(`${CONFIG.auth_base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await r.json();
      if (!j.access_token) return sendNotice(res, 500, '换取 token 失败', ['开放平台没有返回 <code>access_token</code>。', '常见原因：<code>client_id / client_secret</code> 填错，或 <code>redirect_uri</code> 与开放平台登记的不一致。', '原始返回：<code>' + String(JSON.stringify(j)).replace(/[<>&]/g, '') + '</code>'], '/settings', '回设置页检查');
      saveToken({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null });
      res.writeHead(302, { Location: '/settings' }); return res.end();
    }

    // ---- 以下接口都需要已登录(页面密码) ----
    if (P.startsWith('/api/') && !isLoggedIn(req)) return sendJson(res, 401, { needLogin: true });

    if (P === '/api/status') {
      if (localEnabled()) {
        const g = getLocal();
        let up = false;
        try { up = await g.ping(1500); } catch (_) {}
        return sendJson(res, 200, {
          online: up, authed: true, mode: 'local', busy: chatBusy,
          cli: !!g.cli, running: g.isRunning(), model: (SETTINGS.model && SETTINGS.model.preferred) || 'auto',
        });
      }
      const r = await apiCall('GET', '/localassistant');
      const j = await r.json();
      return sendJson(res, 200, { online: !!(j.data && j.data.online), authed: true, mode: 'cloud' });
    }

    function saveChatImage(dataUrl) {
      const dir = path.join(ROOT, 'uploads');
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      const m = /^data:([^;,]+)/.exec(dataUrl);
      let ext = (m && m[1].split('/')[1] || 'png').split('+')[0];
      if (['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp'].indexOf(ext) < 0) ext = 'png';
      const b64 = dataUrl.split(',')[1] || '';
      const buf = Buffer.from(b64, 'base64');
      const name = 'workbuddy-' + Date.now() + '-' + Math.floor(Math.random() * 9999) + '.' + ext;
      const fp = path.join(dir, name);
      fs.writeFileSync(fp, buf);
      return fp;
    }
    // 中止当前正在生成的回复(前端"停止"按钮)
    if (P === '/api/chat/cancel' && req.method === 'POST') {
      if (localEnabled()) { try { await getLocal().cancelActive(); } catch (_) {} }
      return sendJson(res, 200, { ok: true });
    }

    if (P === '/api/chat' && req.method === 'POST') {
      req._t0 = Date.now();
      const body = JSON.parse((await readBody(req)) || '{}');
      let content = body.content || '';
      logChat('REQ stream=' + !!body.stream + ' busy=' + chatBusy + ' len=' + (content || '').length);
      if (body.image && String(body.image).indexOf('data:image') === 0) {
        try {
          const ip = saveChatImage(body.image);
          content += '\n\n（用户附了一张图片，请用 Read 工具查看并分析：' + ip + '）';
        } catch (e) { /* 存图失败不影响文字消息 */ }
      }
      if (!content.trim()) return sendJson(res, 400, { error: 'empty content' });
      // 本地直连优先(默认):直接驱动本机 CLI 助理,不需要开放平台凭据
      if (localEnabled()) {
        const g = getLocal();
        // 流式模式:思考/正文/工具事件以 NDJSON 逐行推给浏览器
        if (body.stream) {
          // 互斥:CLI 单会话,并发 spawn 会互相冲突(表现为空回复/卡死),忙时直接拒绝
          if (chatBusy) {
            logChat('BUSY(stream) ' + (Date.now() - req._t0) + 'ms');
            sendJson(res, 429, { error: 'busy', detail: '助理正在回复上一条消息，请等它结束或点「停止」后再发' });
            return;
          }
          chatBusy = true;
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          });
          const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (_) {} };
          try {
            const reply = await g.chatStream(content, {
              timeoutMs: SETTINGS.poll_timeout_ms || 180000,
              onEvent: (ev) => send(ev),
            });
            logChat('DONE(stream) ' + (Date.now() - req._t0) + 'ms');
            send({ type: 'done', reply });
          } catch (e) {
            logChat('ERR(stream) ' + (Date.now() - req._t0) + 'ms ' + String((e && e.message) || e));
            send({ type: 'error', message: String((e && e.message) || e) });
          } finally {
            chatBusy = false;
          }
          try { res.end(); } catch (_) {}
          return;
        }
        if (chatBusy) {
          logChat('BUSY ' + (Date.now() - req._t0) + 'ms');
          return sendJson(res, 429, { error: 'busy', detail: '助理正在回复上一条消息，请稍候再发' });
        }
        chatBusy = true;
        try {
          const reply = await g.chat(content, { timeoutMs: SETTINGS.poll_timeout_ms || 180000 });
          logChat('DONE ' + (Date.now() - req._t0) + 'ms');
          return sendJson(res, 200, { reply, mode: 'local', model: (SETTINGS.model && SETTINGS.model.preferred) || 'auto' });
        } catch (e) {
          if (!hasCreds()) {
            logChat('LOCALFAIL ' + (Date.now() - req._t0) + 'ms ' + String((e && e.message) || e));
            return sendJson(res, 502, {
              error: 'local_failed',
              detail: String((e && e.message) || e),
              log: g.tail(12),
            });
          }
          // 有云端凭据时，静默回退到原来的云端通道
        } finally {
          chatBusy = false;
        }
      }
      const preferred = SETTINGS.model && SETTINGS.model.preferred;
      const wantModel = (SETTINGS.model && SETTINGS.model.send_model && preferred) ? preferred : null;
      let j = null, modelHonored = false;
      if (wantModel) {
        const r = await apiCall('POST', '/localassistant/message', { content, msg_type: 'text', model: wantModel });
        j = await r.json();
        if (j && j.code === 0) modelHonored = true;
      }
      if (!modelHonored) {
        const r = await apiCall('POST', '/localassistant/message', { content, msg_type: 'text' });
        j = await r.json();
      }
      const msgId = j && j.data && j.data.message_id;
      if (!msgId) return sendJson(res, 502, { error: 'send failed', detail: j });
      const reply = await pollReply(msgId);
      return sendJson(res, 200, { reply: reply == null ? '(助理超时未回复,可在 WorkBuddy 里看结果)' : reply, model: modelHonored ? wantModel : '', modelHonored });
    }

    if (P === '/api/history') {
      const q = u.searchParams.get('message_id')
        ? `?message_id=${encodeURIComponent(u.searchParams.get('message_id'))}`
        : `?limit=${u.searchParams.get('limit') || 20}&offset=${u.searchParams.get('offset') || 0}`;
      const r = await apiCall('GET', `/localassistant/message${q}`);
      const j = await r.json();
      return sendJson(res, 200, j.data || { messages: [] });
    }

    // ---- 绑定:先试"设备码自动绑定",平台不支持则回退浏览器授权 ----
    if (P === '/api/bind/auto' && req.method === 'POST') {
      if (!hasCreds()) return sendJson(res, 400, { ok: false, error: 'no_creds' });
      let d = null;
      try { d = await deviceStart(); } catch (e) { d = { ok: false, error: String((e && e.message) || e) }; }
      if (d && d.ok && d.user_code) {
        return sendJson(res, 200, { ok: true, mode: 'device', user_code: d.user_code, verification_uri: d.verification_uri, interval: d.interval || 5, expires_in: d.expires_in || 600 });
      }
      return sendJson(res, 200, { ok: true, mode: 'browser', authUrl: '/auth/login', reason: (d && (d.status || d.error)) || 'device_unsupported' });
    }
    if (P === '/api/bind/poll' && req.method === 'GET') {
      return sendJson(res, 200, await devicePoll());
    }

    // ---- 设置 ----
    if (P === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, {
        bound: !!(tokenStore && tokenStore.access_token),
        hasCreds: hasCreds(),
        client_id_masked: mask(CONFIG.client_id),
        redirect_uri: CONFIG.redirect_uri,
        auth_base: CONFIG.auth_base,
        scopes: CONFIG.scopes,
        bridge_host: os.hostname(),
        bridge_ip: lanIp(),
        bridge_port: CONFIG.port,
        poll_timeout_ms: SETTINGS.poll_timeout_ms,
        ui: SETTINGS.ui,
        local: (() => {
          const g = getLocal();
          return {
            enabled: localEnabled(),
            cli_found: !!g.cli,
            cli_path: g.cli || '',
            port: g.port,
            model: (SETTINGS.model && SETTINGS.model.preferred) || 'auto',
            models: LOCAL_MODELS,
          };
        })(),
        model: { preferred: SETTINGS.model.preferred, send_model: SETTINGS.model.send_model, catalog: readModelCatalog() },
      });
    }
    if (P === '/api/settings' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      const oldModel = (SETTINGS.model && SETTINGS.model.preferred) || '';
      if (b.new_password) SETTINGS.password_hash = sha256(b.new_password);
      if (typeof b.poll_timeout_ms === 'number' && b.poll_timeout_ms >= 5000) SETTINGS.poll_timeout_ms = Math.min(b.poll_timeout_ms, 600000);
      if (b.ui && typeof b.ui === 'object') SETTINGS.ui = Object.assign(SETTINGS.ui, {
        dark: !!b.ui.dark, showTime: !!b.ui.showTime, showRole: !!b.ui.showRole,
      });
      if (b.model && typeof b.model === 'object') {
        SETTINGS.model.preferred = typeof b.model.preferred === 'string' ? b.model.preferred : SETTINGS.model.preferred;
        SETTINGS.model.send_model = !!b.model.send_model;
      }
      let credsChanged = false;
      if (b.client_id && String(b.client_id).trim()) { CONFIG.client_id = String(b.client_id).trim(); credsChanged = true; }
      if (b.client_secret && String(b.client_secret).trim()) { CONFIG.client_secret = String(b.client_secret).trim(); credsChanged = true; }
      if (typeof b.redirect_uri === 'string' && b.redirect_uri.trim()) {
        const v = b.redirect_uri.trim();
        if (/^https?:\/\/[^\s]+$/i.test(v)) { CONFIG.redirect_uri = v; credsChanged = true; }
        else return sendJson(res, 400, { ok: false, error: 'redirect_uri 必须以 http:// 或 https:// 开头' });
      }
      if (typeof b.local_enabled === 'boolean') SETTINGS.local_enabled = b.local_enabled;
      if (credsChanged) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2)); } catch (_) {} }
      saveSettings();
      const newModel = (SETTINGS.model && SETTINGS.model.preferred) || '';
      let restarting = false;
      if (localEnabled() && newModel !== oldModel) {
        restarting = true;
        getLocal().restart(newModel).catch((e) => console.warn('本地服务重启失败:', e.message));
      }
      return sendJson(res, 200, { ok: true, hasCreds: hasCreds(), model: newModel, restarting });
    }
    // 手动重启本地直连服务(改完模型/排查问题时用)
    if (P === '/api/local/restart' && req.method === 'POST') {
      try {
        await getLocal().restart();
        return sendJson(res, 200, { ok: true, running: true });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e), log: getLocal().tail(12) });
      }
    }
    if (P === '/api/unbind' && req.method === 'POST') {
      tokenStore = null;
      deviceState = null;
      try { fs.unlinkSync(TOKEN_PATH); } catch (_) {}
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    if (e.needAuth) return sendJson(res, 409, { needBind: true, error: '未绑定本机 WorkBuddy' });
    console.error(e);
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`WorkBuddy 聊天桥已启动: http://localhost:${CONFIG.port}`);
  console.log(`访问密码: 见 settings.json / config.json(默认 77)`);
  if (localEnabled()) {
    const g = getLocal();
    console.log(`通道: 本地直连 (${g.cli ? '已找到 CLI' : '未找到 CLI'}) -> 127.0.0.1:${g.port}`);
    if (g.cli) g.ensure().then(() => console.log('本地助理服务已就绪')).catch((e) => console.warn('本地助理服务启动失败:', e.message));
  } else {
    console.log('通道: 云端 Open API(需 client_id / 绑定)');
  }
  console.log(`远程访问: 把 ${CONFIG.port} 经 frp 暴露出去即可`);
});
