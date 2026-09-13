'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, dialog } = require('electron');
const store = require('./store.cjs');
const { extractErrorMessage } = require('./sse.cjs');
const { runTool } = require('./tools/index.cjs');
const remote = require('./remote-server.cjs');
const chromeLaunch = require('./chrome-launch.cjs');
const skillFolder = require('./skill-folder.cjs');
const attachments = require('./attachments.cjs');
const { runtimeStore } = require('./run-store.cjs');
const { verifyFiles } = require('./file-records.cjs');

const DEV_URL = process.env.SNC_DEV_URL || '';
const isDev = Boolean(DEV_URL);

/** requestId -> { controller, timer } */
const inflight = new Map();

let mainWindow = null;

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

/*
 * 窗口大小和位置要记住。
 *
 * 不记的话每次启动都回到 1280×860 —— 用户把窗口拉成竖条挂在副屏上，
 * 更新一次就得重摆一次。它跟设置、授权一样属于「我调过的东西」，
 * 凭什么一次更新就没了。
 *
 * 存在同一个 store.json 里，所以应用改名时的迁移逻辑对它一样生效。
 */
const BOUNDS_KEY = 'snc:window-bounds:v1';

function savedBounds() {
  try {
    const raw = store.kvGet(BOUNDS_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw);
    if (typeof b?.width !== 'number' || typeof b?.height !== 'number') return null;
    // 屏幕拔掉之后，上次那个坐标可能落在虚空里。挑一块真的存在的屏幕验证一下
    const { screen } = require('electron');
    const area = screen.getDisplayMatching({
      x: b.x ?? 0,
      y: b.y ?? 0,
      width: b.width,
      height: b.height,
    }).workArea;
    const onScreen =
      typeof b.x === 'number' &&
      typeof b.y === 'number' &&
      b.x < area.x + area.width - 80 &&
      b.y < area.y + area.height - 80 &&
      b.x + b.width > area.x + 80 &&
      b.y + b.height > area.y + 80;
    return {
      width: Math.max(420, Math.min(b.width, area.width)),
      height: Math.max(520, Math.min(b.height, area.height)),
      ...(onScreen ? { x: b.x, y: b.y } : {}),
      maximized: Boolean(b.maximized),
    };
  } catch {
    return null;
  }
}

let boundsTimer = null;
function rememberBounds(win) {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    try {
      if (!win || win.isDestroyed()) return;
      const maximized = win.isMaximized();
      // 最大化时存「还原后」的尺寸，否则取消最大化会得到一个全屏大小的小窗口
      const b = maximized ? win.getNormalBounds() : win.getBounds();
      store.kvSet(BOUNDS_KEY, JSON.stringify({ ...b, maximized }));
    } catch {
      /* 存不上就算了，不值得为它崩一个窗口 */
    }
  }, 400);
}

function createWindow() {
  const saved = savedBounds();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 860,
    ...(saved && 'x' in saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 420,
    minHeight: 520,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f5f6f8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (saved?.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) {
    mainWindow.on(ev, () => rememberBounds(mainWindow));
  }
  // 关窗那一下也存一次：防抖的 400ms 可能还没到就退出了
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    try {
      const maximized = mainWindow.isMaximized();
      const b = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      store.kvSet(BOUNDS_KEY, JSON.stringify({ ...b, maximized }));
      if (store.flush) store.flush();
    } catch {
      /* 同上 */
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev && url.startsWith(DEV_URL);
    if (!allowed) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '打开数据目录', click: () => shell.showItemInFolder(store.filePath()) },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新加载' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * HTTP：只负责搬字节。
 * SSE 切分、tool_calls 累积、字段归一化全在渲染进程的 src/lib/sse.ts 里，
 * 三个平台共用一份实现，主进程不重复造。
 * ------------------------------------------------------------------ */

function emit(sender, requestId, type, data, status) {
  if (sender.isDestroyed()) return;
  // status 只在 type === 'error' 时有意义：渲染层要靠它把「限流」和
  // 「这条路由坏了」区分开，光看报错文案是分不出来的
  sender.send('snc:event', { requestId, type, data, status });
}

async function handleChat(evt, init) {
  const sender = evt.sender;
  const { requestId, url, headers, body, stream, timeoutMs } = init;
  const controller = new AbortController();
  const exchange = { requestId, runId: init.runId, round: init.round, attempt: init.attempt,
    purpose: init.purpose || 'agent', at: Date.now(), url, stream, request: body,
    raw: '', truncated: false, responseHeaders: {}, status: undefined };
  const save = () => { try { runtimeStore().saveExchange(exchange); } catch (e) { console.error('请求诊断保存失败', e.message); } };
  const raw = (text) => {
    const room = 256000 - exchange.raw.length;
    exchange.raw += text.slice(0, Math.max(0, room));
    if (text.length > room) exchange.truncated = true;
  };
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort('timeout'), timeoutMs || 180000);
    inflight.set(requestId, { controller, timer });
  };
  touch(); save();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    exchange.status = res.status;
    // Only response metadata useful for diagnostics; never cookies or credentials.
    for (const [key, value] of res.headers) {
      if (/^(content-type|retry-after|x-request-id|request-id|x-ratelimit-[a-z-]+|anthropic-ratelimit-[a-z-]+)$/i.test(key)) exchange.responseHeaders[key] = value;
    }
    emit(sender, requestId, 'response', exchange.responseHeaders, res.status);
    touch();
    const isSse = (res.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
    if (!res.ok) {
      const text = await res.text(); raw(text);
      emit(sender, requestId, 'raw', text, res.status);
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* preserve original error */ }
      exchange.error = extractErrorMessage(parsed, `HTTP ${res.status}`);
      emit(sender, requestId, 'error', exchange.error, res.status);
      return;
    }
    if (!stream || !isSse || !res.body) {
      const text = await res.text(); raw(text);
      emit(sender, requestId, 'body', text);
      emit(sender, requestId, 'done'); return;
    }
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      const text = decoder.decode(value, { stream: true }); raw(text);
      emit(sender, requestId, 'chunk', text);
    }
    const tail = decoder.decode();
    if (tail) { raw(tail); emit(sender, requestId, 'chunk', tail); }
    emit(sender, requestId, 'done');
  } catch (err) {
    exchange.error = controller.signal.aborted
      ? controller.signal.reason === 'timeout' ? '响应等待超时（连续无数据）' : '请求已停止'
      : err?.message || String(err);
    emit(sender, requestId, 'error', exchange.error);
  } finally {
    clearTimeout(timer); inflight.delete(requestId);
    exchange.endedAt = Date.now(); save();
  }
}

async function handleGetJson(_evt, { url, headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs || 30000);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 保持原文 */
    }
    if (!res.ok) throw new Error(extractErrorMessage(parsed, `HTTP ${res.status}`));
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('snc:runSave', (_e, record) => runtimeStore().save(record));
  ipcMain.handle('snc:runList', () => runtimeStore().list());
  ipcMain.handle('snc:runRemove', (_e, id) => runtimeStore().remove(id));
  ipcMain.handle('snc:exchanges', (_e, runId) => runtimeStore().exchanges(runId));
  ipcMain.handle('snc:verifyFiles', (_e, { paths, roots }) => verifyFiles(paths, roots));
  ipcMain.handle('snc:saveArtifact', async (_e, { name, text, sourcePath }) => {
    const chosen = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(app.getPath('downloads'), path.basename(name || 'output.txt')) });
    if (chosen.canceled || !chosen.filePath) return null;
    const fs = require('node:fs');
    if (sourcePath) fs.copyFileSync(sourcePath, chosen.filePath);
    else fs.writeFileSync(chosen.filePath, String(text ?? ''), 'utf8');
    return verifyFiles([chosen.filePath], [path.dirname(chosen.filePath)]).files[0];
  });
  ipcMain.handle('snc:chat', handleChat);
  ipcMain.handle('snc:getJson', handleGetJson);

  ipcMain.handle('snc:abort', (_e, requestId) => {
    const rec = inflight.get(requestId);
    if (rec) {
      clearTimeout(rec.timer);
      rec.controller.abort('user');
      inflight.delete(requestId);
    }
  });

  ipcMain.handle('snc:tool', (_e, { name, args, ctx }) => runTool(name, args, ctx));

  ipcMain.handle('snc:kvGet', (_e, key) => store.kvGet(key));
  ipcMain.handle('snc:kvSet', (_e, { key, value }) => store.kvSet(key, value));
  ipcMain.handle('snc:secretGet', (_e, id) => store.secretGet(id));
  ipcMain.handle('snc:secretSet', (_e, { id, value }) => store.secretSet(id, value));
  ipcMain.handle('snc:secretDelete', (_e, id) => store.secretDelete(id));

  ipcMain.handle('snc:info', () => ({
    encryptionAvailable: store.encryptionAvailable(),
    storePath: store.filePath(),
    version: app.getVersion(),
    platform: process.platform,
  }));

  // 选目录：工作目录必须用户亲手点，不接受模型或渲染进程指定
  ipcMain.handle('snc:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择允许工具访问的工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 选文件带进对话
  ipcMain.handle('snc:pickFiles', async (_e, mode) => {
    const filters =
      mode === 'image'
        ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
        : [
            { name: '文本与代码', extensions: ['txt', 'md', 'json', 'csv', 'yaml', 'yml', 'ts', 'tsx', 'js', 'py', 'go', 'rs', 'java', 'sql', 'html', 'css', 'log'] },
            { name: '所有文件', extensions: ['*'] },
          ];
    const r = await dialog.showOpenDialog(mainWindow, {
      title: mode === 'image' ? '选择图片' : '选择文件',
      properties: ['openFile', 'multiSelections'],
      filters,
    });
    if (r.canceled || !r.filePaths.length) return [];
    return attachments.readFiles(r.filePaths);
  });

  // 产物：在文件夹里定位 / 用默认程序打开 / 读回来预览
  ipcMain.handle('snc:revealPath', (_e, p) => {
    if (!require('node:fs').existsSync(p)) throw new Error('文件不存在或已被移动：' + p);
    shell.showItemInFolder(p);
  });
  ipcMain.handle('snc:openPath', async (_e, p) => {
    const err = await shell.openPath(p);
    return err || null; // 空字符串表示成功
  });
  ipcMain.handle('snc:readArtifact', (_e, { path: p, maxBytes }) => {
    const fsx = require('node:fs');
    try {
      const st = fsx.statSync(p);
      const cap = Number(maxBytes) || 2 * 1024 * 1024;
      if (st.size > cap) {
        return { ok: false, error: `文件 ${(st.size / 1048576).toFixed(1)}MB，超过预览上限。` };
      }
      return { ok: true, text: fsx.readFileSync(p, 'utf8'), size: st.size };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 技能文件夹同步。刻意只走 IPC，不进 registry ——
  // 那个目录在工作目录白名单之外，做成模型工具等于给它一条绕过白名单的路。
  ipcMain.handle('snc:skillsRead', (_e, dir) => skillFolder.read(dir));
  ipcMain.handle('snc:skillsWrite', (_e, { dir, items }) => skillFolder.write(dir, items));
  ipcMain.handle('snc:skillsDefaultDir', () => skillFolder.defaultDir());

  // Chrome：起一个带调试端口的实例
  ipcMain.handle('snc:chromeLaunch', (_e, { port, path: p }) => chromeLaunch.launch(port, p));
  ipcMain.handle('snc:chromeStatus', (_e, port) => chromeLaunch.status(port));

  ipcMain.handle('snc:remoteStart', async (_e, { port, token }) => {
    const t = token || remote.newToken();
    store.kvSet('snc:remote:token', t);
    return remote.start(port, t);
  });
  ipcMain.handle('snc:remoteStop', () => remote.stop());
  ipcMain.handle('snc:remoteStatus', () => remote.status());
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setAppUserModelId('dev.anyai.desktop');

  app.whenReady().then(() => {
    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    for (const [, rec] of inflight) {
      clearTimeout(rec.timer);
      rec.controller.abort('quit');
    }
    inflight.clear();
    remote.stop();
    store.flush();
  });
}
