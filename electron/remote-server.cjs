'use strict';
/**
 * 给手机端用的遥控服务。
 *
 * 手机上没有文件系统权限、没法控 Chrome、也没有 claude CLI，所以手机端的工具
 * 调用全部转发到这台电脑执行。这个小 HTTP 服务就是那个转发入口。
 *
 * 安全上做了三件事，也只做了这三件：
 *   1. 必须带 Bearer token，token 是随机生成的，配对时手动抄到手机上
 *   2. 默认只绑内网地址，不做任何 UPnP / 打洞
 *   3. token 不对直接 401，不给任何提示信息
 * 这不是给公网暴露用的。别把它端口转发出去。
 */
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { runTool } = require('./tools/index.cjs');

let server = null;
let currentPort = 0;
let currentToken = '';

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // /ping 不校验 token，只用来让手机确认地址通不通
  if (url.pathname === '/ping') {
    send(res, 200, { ok: true, app: 'anyai', productName: 'wickrunAI', displayName: '灯芯AI', host: os.hostname() });
    return;
  }

  const auth = req.headers.authorization || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(currentToken);
  const okToken =
    a.length === b.length && currentToken.length > 0 && crypto.timingSafeEqual(a, b);
  if (!okToken) {
    send(res, 401, { error: '配对令牌不对' });
    return;
  }

  if (url.pathname === '/tool' && req.method === 'POST') {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = await runTool(payload.name, payload.args, payload.ctx);
      send(res, 200, result);
    } catch (e) {
      send(res, 400, { ok: false, content: '', error: e.message });
    }
    return;
  }

  send(res, 404, { error: 'not found' });
}

function start(port, token) {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(status());
      return;
    }
    currentPort = Number(port) || 8719;
    currentToken = token || newToken();

    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        try {
          send(res, 500, { error: e.message });
        } catch {
          /* 连响应都发不出去就算了 */
        }
      });
    });

    server.on('error', (e) => {
      server = null;
      reject(new Error(`遥控服务起不来：${e.message}`));
    });

    server.listen(currentPort, '0.0.0.0', () => resolve(status()));
  });
}

function stop() {
  if (server) {
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
    server = null;
  }
  return { running: false, port: currentPort, token: currentToken, addresses: [] };
}

function status() {
  return {
    running: Boolean(server),
    port: currentPort,
    token: currentToken,
    addresses: lanAddresses().map((ip) => `http://${ip}:${currentPort}`),
  };
}

module.exports = { start, stop, status, newToken };
