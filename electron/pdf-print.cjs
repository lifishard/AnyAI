'use strict';
/**
 * HTML → PDF，用 Electron 自带的 printToPDF。
 *
 * 为什么不引 puppeteer / weasyprint 之类：这个应用本身就是 Chromium，
 * 排版引擎已经在手上了。开一个隐藏窗口渲染完打印，零额外依赖，
 * 中文字体也跟系统一致，不会出现「装了库但缺字体导致方块」那种事。
 */
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

/**
 * @param {string} html 完整的 HTML 文档
 * @param {string} outPath 输出的 .pdf 绝对路径
 * @param {{landscape?: boolean, pageSize?: string, margin?: number}} opts
 */
async function htmlToPdf(html, outPath, opts = {}) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      javascript: false, // 只是排版，不需要脚本，顺便断掉一类风险
      sandbox: true,
    },
  });

  try {
    // 走 data URL，免得为了一次打印在磁盘上留临时文件
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await win.loadURL(dataUrl);

    // 等字体和布局稳定 —— 不等的话中文字体常常还没换上就截图了
    await new Promise((r) => setTimeout(r, 400));

    const buf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: Boolean(opts.landscape),
      pageSize: opts.pageSize || 'A4',
      margins: {
        marginType: 'custom',
        top: opts.margin ?? 0.6,
        bottom: opts.margin ?? 0.6,
        left: opts.margin ?? 0.6,
        right: opts.margin ?? 0.6,
      },
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return outPath;
  } finally {
    try {
      win.destroy();
    } catch {
      /* 已经没了就算了 */
    }
  }
}

module.exports = { htmlToPdf };
