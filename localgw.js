'use strict';
// 本地直连模块 —— 用 WorkBuddy 自带 CLI 的 --serve 起一个本机 CodeBuddy Gateway。
// 完全绕开开放平台 OAuth(client_id / client_secret / 实名认证),直接驱动本机助理引擎。
//
// 协议要点(自本机 CLI 反查得到):
//   POST /api/v1/runs              -> 202 { data: { runId, status:'accepted' } }
//   GET  /api/v1/runs/{id}/stream  -> SSE: event: message | data: {...content.markdown}; event: done
//   所有非豁免接口需带 X-CodeBuddy-Request: 1
//   鉴权: Authorization: Bearer <gateway password>(密码由我们用环境变量自定)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// CLI 支持的模型(取自 `codebuddy --help`)
const LOCAL_MODELS = [
  { id: 'auto', name: '自动（跟随 App 默认）' },
  { id: 'hy4-preview', name: 'HY4 Preview' },
  { id: 'hy3', name: 'HY3' },
  { id: 'hy3-x', name: 'HY3-X' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5v-turbo', name: 'GLM-5V Turbo（视觉）' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'minimax-m3', name: 'MiniMax M3' },
  { id: 'kimi-k3-1', name: 'Kimi K3' },
  { id: 'kimi-k2.8-preview', name: 'Kimi K2.8 Preview' },
  { id: 'kimi-k2.7', name: 'Kimi K2.7' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6' },
];

function findCli() {
  const cands = [];
  if (process.env.CODEBUDDY_CLI) cands.push(process.env.CODEBUDDY_CLI);
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const rom = process.env.ProgramFiles || 'C:\\Program Files';
  const x86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const bases = [
    path.join(la, 'Programs', 'WorkBuddy'),
    path.join(la, 'WorkBuddy'),
    path.join(rom, 'WorkBuddy'),
    path.join(x86, 'WorkBuddy'),
  ];
  for (const b of bases) {
    cands.push(path.join(b, 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
    cands.push(path.join(b, 'resources', 'cli', 'bin', 'codebuddy'));
  }
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

class LocalGateway {
  constructor(opts) {
    this.cli = opts.cli || findCli();
    this.port = opts.port || 8791;
    this.password = opts.password;
    this.model = opts.model || '';
    this.cwd = opts.cwd || process.cwd();
    this.proc = null;
    this._starting = null;
    this.lines = [];
    this._activeCtrl = null;
    this._activeRunId = null;
  }
  base() { return `http://127.0.0.1:${this.port}`; }
  headers() {
    return {
      'Content-Type': 'application/json',
      'X-CodeBuddy-Request': '1',
      'Authorization': 'Bearer ' + this.password,
    };
  }
  _log(s) { this.lines.push(String(s)); if (this.lines.length > 300) this.lines.shift(); }
  tail(n) { return this.lines.slice(-(n || 30)); }
  isRunning() { return !!(this.proc && this.proc.exitCode === null && !this.proc.killed); }

  async ping(timeoutMs) {
    if (!this.cli) return false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 1500);
    try {
      const r = await fetch(`${this.base()}/api/v1/auth/status`, { signal: ctrl.signal });
      return r.ok;
    } catch (_) { return false; } finally { clearTimeout(t); }
  }

  async ensure(timeoutMs) {
    if (!this.cli) throw new Error('未找到 WorkBuddy 自带的 codebuddy CLI（可用环境变量 CODEBUDDY_CLI 指定）');
    if (await this.ping(1200)) return true;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      this._spawn();
      const deadline = Date.now() + (timeoutMs || 90000);
      while (Date.now() < deadline) {
        if (await this.ping(1200)) return true;
        if (!this.isRunning()) throw new Error('本地服务进程已退出：' + (this.tail(6).join(' ') || '(无输出)'));
        await new Promise((r) => setTimeout(r, 900));
      }
      throw new Error('本地服务启动超时');
    })();
    try { await this._starting; } finally { this._starting = null; }
    return true;
  }

  _spawn() {
    const node = process.execPath;
    const args = [this.cli, '--serve', '--port', String(this.port), '--host', '127.0.0.1'];
    if (this.model && this.model !== 'auto') args.push('--model', this.model);
    const env = Object.assign({}, process.env, {
      CODEBUDDY_GATEWAY_AUTH: 'password',
      CODEBUDDY_GATEWAY_PASSWORD: this.password,
      NODE_OPTIONS: '',
    });
    this._log('spawn: ' + node + ' ' + args.join(' '));
    this.proc = spawn(node, args, {
      cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    this.proc.stdout.on('data', (d) => this._log('out: ' + String(d).trim()));
    this.proc.stderr.on('data', (d) => this._log('err: ' + String(d).trim()));
    this.proc.on('exit', (c) => this._log('exit: ' + c));
  }

  async restart(model) {
    this.stop();
    if (model !== undefined) this.model = model || '';
    this.lines = [];
    return this.ensure();
  }

  stop() {
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill(); } catch (_) {}
    }
    this.proc = null;
  }

  // 发一条消息，返回助理回复(markdown 文本)
  async chat(text, opts = {}) {
    const timeoutMs = opts.timeoutMs || 180000;
    await this.ensure();
    const id = 'wb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const body = {
      id, type: 'message',
      source: { platform: 'generic', sender: { id: 'web', name: 'Web' }, conversation: { id: 'wb-remote', type: 'direct' } },
      payload: { text: String(text) },
    };
    const r = await fetch(`${this.base()}/api/v1/runs`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error('发起失败 HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json().catch(() => ({}));
    const runId = (j.data && j.data.runId) || j.runId;
    if (!runId) throw new Error('没有拿到 runId: ' + JSON.stringify(j).slice(0, 200));
    this._activeRunId = runId;
    if (opts.onRunId) { try { opts.onRunId(runId); } catch (_) {} }

    const ctrl = new AbortController();
    this._activeCtrl = ctrl;
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener('abort', () => ctrl.abort());
    }
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let reply = '';
    try {
      const s = await fetch(`${this.base()}/api/v1/runs/${runId}/stream`, { headers: this.headers(), signal: ctrl.signal });
      if (!s.ok) throw new Error('取流失败 HTTP ' + s.status);
      const reader = s.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.trim()) continue;
          let ev = '', data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (ev === 'message' && data) {
            try {
              const m = JSON.parse(data);
              const c = m.content;
              const md = c && (typeof c === 'string' ? c : (c.markdown != null ? c.markdown : c.text));
              if (typeof md === 'string' && md) reply = md;
            } catch (_) {}
          } else if (ev === 'done') {
            finished = true;
          } else if (ev === 'error' && data) {
            let msg = data;
            try { const e = JSON.parse(data); msg = e.message || e.error || data; } catch (_) {}
            throw new Error('助理执行出错: ' + String(msg).slice(0, 300));
          }
        }
      }
    } finally {
      clearTimeout(t);
      this._activeCtrl = null;
      this._activeRunId = null;
    }
    return reply || '(助理没有返回内容)';
  }

  // 流式对话：spawn CLI -p --output-format stream-json --include-partial-messages，
  // 把思考增量(thinking_delta)/正文增量(text_delta)/工具调用逐个回调 onEvent，
  // 结束时 resolve 完整回复。onEvent 收到 {type:'thinking'|'text'|'tool', ...}
  chatStream(text, opts = {}) {
    const timeoutMs = opts.timeoutMs || 180000;
    const onEvent = opts.onEvent || (() => {});
    if (!this.cli) return Promise.reject(new Error('未找到 WorkBuddy 自带的 codebuddy CLI（可用环境变量 CODEBUDDY_CLI 指定）'));
    const node = process.execPath;
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages',
      '--permission-mode', 'bypassPermissions'];
    if (this.model && this.model !== 'auto') args.push('--model', this.model);
    const useResume = !!this._sessionId;
    if (useResume) args.push('--resume', this._sessionId);
    args.push(String(text));

    return new Promise((resolve, reject) => {
      const env = Object.assign({}, process.env, { NODE_OPTIONS: '' });
      const child = spawn(node, [this.cli].concat(args), {
        cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      this._activeChild = child;
      this._log('chatStream spawn: ' + args.join(' ').slice(0, 200));
      let reply = '';
      let streamText = '';
      let settled = false;
      const t = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error('生成超时')); }, timeoutMs);

      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        this._activeChild = null;
        fn(val);
      };

      let buf = '';
      child.stdout.on('data', (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch (_) { continue; }
          if (j.type === 'system' && j.subtype === 'init' && j.session_id) {
            this._sessionId = j.session_id;
          } else if (j.type === 'stream_event' && j.event) {
            const ev = j.event;
            if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
              try { onEvent({ type: 'tool', name: ev.content_block.name || '工具' }); } catch (_) {}
            } else if (ev.type === 'content_block_delta' && ev.delta) {
              const dl = ev.delta;
              if (dl.type === 'thinking_delta' && dl.thinking) {
                try { onEvent({ type: 'thinking', text: dl.thinking }); } catch (_) {}
              } else if (dl.type === 'text_delta' && dl.text) {
                streamText += dl.text;
                try { onEvent({ type: 'text', text: dl.text }); } catch (_) {}
              }
            }
          } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
            for (const blk of j.message.content) {
              if (blk && blk.type === 'text' && blk.text) reply = blk.text;
              if (blk && blk.type === 'tool_use') { try { onEvent({ type: 'tool', name: blk.name || '工具' }); } catch (_) {} }
            }
          } else if (j.type === 'result') {
            if (j.result) reply = j.result;
            finish(resolve, reply || streamText || '(助理没有返回内容)');
          }
        }
      });
      let errOut = '';
      child.stderr.on('data', (d) => { errOut += String(d); });
      child.on('exit', (code) => {
        if (settled) return;
        if (useResume && code !== 0 && !reply) {
          // resume 会话失效等情形：降级为全新会话重试一次
          this._sessionId = null;
          this.chatStream(text, opts).then(resolve, reject);
          return;
        }
        finish(reject, new Error('CLI 退出码 ' + code + (errOut ? ': ' + errOut.slice(0, 300) : (reply ? '' : ' (无输出)'))));
      });
    });
  }

  // 取消当前正在跑的任务(SSE 中止 + 网关 run 取消 + 重启网关释放单槽位)
  async cancelActive() {
    // 流式模式:直接杀 CLI 子进程,最干净
    if (this._activeChild && this._activeChild.exitCode === null) {
      try { this._activeChild.kill(); } catch (_) {}
    }
    this._activeChild = null;
    if (this._activeCtrl && !this._activeCtrl.signal.aborted) {
      try { this._activeCtrl.abort(); } catch (_) {}
    }
    const rid = this._activeRunId;
    if (rid) { try { await this.cancelRun(rid); } catch (_) {} }
    // 网关模式才需要重启网关释放单槽位；流式(CLI 子进程)模式杀掉子进程即可
    if (rid || this._activeCtrl) {
      try { this.stop(); } catch (_) {}
      this.ensure().catch(() => {});
    }
    this._activeCtrl = null;
    this._activeRunId = null;
    return !!(rid || this._activeChild);
  }

  async cancelRun(runId) {
    if (!runId) return false;
    for (const make of [
      () => ({ method: 'DELETE', url: `${this.base()}/api/v1/runs/${runId}` }),
      () => ({ method: 'POST', url: `${this.base()}/api/v1/runs/${runId}/cancel` }),
    ]) {
      try {
        const { method, url } = make();
        const r = await fetch(url, { method, headers: this.headers() });
        if (r.ok) return true;
      } catch (_) {}
    }
    return false;
  }
}

module.exports = { LocalGateway, LOCAL_MODELS, findCli };
