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

const DEV_URL = process.env.SNC_DEV_URL || '';
const isDev = Boolean(DEV_URL);

/** requestId -> { controller, timer } */
const inflight = new Map();

let mainWindow = null;

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

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
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs || 180000);
  inflight.set(requestId, { controller, timer });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    const isSse = ctype.includes('text/event-stream');

    if (!res.ok) {
      const text = await res.text();
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 保持原文 */
      }
      emit(sender, requestId, 'error', extractErrorMessage(parsed, `HTTP ${res.status}`), res.status);
      return;
    }

    // 要了流式但服务端给整包 JSON —— 当非流式处理
    if (!stream || !isSse || !res.body) {
      emit(sender, requestId, 'body', await res.text());
      emit(sender, requestId, 'done');
      return;
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      emit(sender, requestId, 'chunk', decoder.decode(value, { stream: true }));
    }
    emit(sender, requestId, 'done');
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
    if (aborted) {
      // 用户主动停止：当正常结束，已经流出来的内容保留
      emit(sender, requestId, 'done');
    } else {
      emit(sender, requestId, 'error', err && err.message ? err.message : String(err));
    }
  } finally {
    clearTimeout(timer);
    inflight.delete(requestId);
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
