// supervisor.js —— workbuddy-chat 守护进程
// 作用：常驻拉起 server.js；server.js 被杀/崩溃后 3 秒自动重启；
//       每 15 秒心跳检测 8790，连续 3 次连不上则强制重启（防卡死）。
// 由 start.bat 启动，不要用 node 直接跑 server.js（那样被杀不会复活）。
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const SERVER = path.join(ROOT, 'server.js');
const PORT = 8790;
const LOG = path.join(ROOT, 'supervisor.log');

function log(m) {
  const s = `[${new Date().toISOString()}] ${m}\n`;
  try { fs.appendFileSync(LOG, s); } catch (_) {}
  console.log(s.trim());
}

let child = null;
let stopping = false;
let failCount = 0;

// 端口是否已有人在服务(避免多个 supervisor 抢 8790 造成 EADDRINUSE 风暴)
function portBusy(cb) {
  const s = net.connect(PORT, '127.0.0.1');
  let done = false;
  const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} cb(v); };
  s.setTimeout(1200);
  s.on('connect', () => finish(true));
  s.on('timeout', () => finish(false));
  s.on('error', () => finish(false));
}

function start() {
  if (stopping) return;
  portBusy((busy) => {
    if (busy) {
      // 已有人在服务 → 本进程退让,不再重复 spawn(防止多 supervisor 抢端口)
      log('端口 ' + PORT + ' 已在服务,本 supervisor 退让(不重复启动)');
      if (!stopping) setTimeout(start, 15000);
      return;
    }
    log('启动 server.js ...');
    child = spawn(NODE, [SERVER], { cwd: ROOT, windowsHide: true, env: process.env });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code, sig) => {
      child = null;
      log(`server.js 退出 code=${code} sig=${sig}`);
      if (!stopping) setTimeout(start, 3000);
    });
  });
}

function heartbeat() {
  if (!child) return;
  const s = net.connect(PORT, '127.0.0.1');
  s.setTimeout(2000);
  s.on('connect', () => { s.destroy(); failCount = 0; });
  s.on('timeout', () => { s.destroy(); onFail(); });
  s.on('error', () => { s.destroy(); onFail(); });
}

function onFail() {
  failCount++;
  if (failCount >= 3) {
    log('心跳连续失败 3 次，强制重启 server.js');
    failCount = 0;
    if (child) { try { child.kill('SIGKILL'); } catch (_) {} }
  }
}

setInterval(heartbeat, 15000);
process.on('SIGINT', () => { stopping = true; if (child) try { child.kill(); } catch (_) {} process.exit(0); });
process.on('SIGTERM', () => { stopping = true; if (child) try { child.kill(); } catch (_) {} process.exit(0); });

log('supervisor 启动');
start();
