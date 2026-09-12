'use strict';
/**
 * 本地文件工具。所有路径都先过 guardPath —— 没配工作目录就一律拒绝，
 * 配了也只能在目录树内部活动。
 */
const fs = require('node:fs');
const path = require('node:path');
const { ok, fail, guardPath, firstRoot, clip } = require('./common.cjs');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'release', '__pycache__',
  '.venv', 'venv', '.next', '.cache', 'target', '.idea', '.gradle',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz',
  '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
  '.mp3', '.mp4', '.mov', '.avi', '.woff', '.woff2', '.ttf', '.otf', '.pyc',
]);

function listDir(args, ctx) {
  try {
    const root = guardPath(args.path, ctx.workspaceRoots, { mustExist: true });
    const depth = Math.min(4, Math.max(1, Number(args.depth) || 1));
    const lines = [];
    let count = 0;

    const walk = (dir, level, prefix) => {
      if (level > depth || count > 800) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        lines.push(`${prefix}（无法读取：${e.message}）`);
        return;
      }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const e of entries) {
        if (count++ > 800) {
          lines.push(`${prefix}…（条目过多，已截断）`);
          return;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const skipped = SKIP_DIRS.has(e.name);
          lines.push(`${prefix}${e.name}/${skipped ? '  （已跳过）' : ''}`);
          if (!skipped) walk(full, level + 1, `${prefix}  `);
        } else {
          let size = '';
          try {
            size = ` (${fs.statSync(full).size} B)`;
          } catch {
            /* 忽略 */
          }
          lines.push(`${prefix}${e.name}${size}`);
        }
      }
    };

    walk(root, 1, '');
    return ok(`${root}\n${lines.join('\n') || '（空目录）'}`, {
      summary: `列出 ${root}（${count} 项）`,
    });
  } catch (e) {
    return fail(e);
  }
}

function readFile(args, ctx) {
  try {
    const p = guardPath(args.path, ctx.workspaceRoots, { mustExist: true });
    const st = fs.statSync(p);
    if (st.isDirectory()) return fail(`${p} 是目录，用 list_dir。`);
    const ext2 = path.extname(p).toLowerCase();
    if (['.pdf', '.docx', '.xlsx', '.xlsm', '.xls'].includes(ext2)) {
      return fail(`${path.basename(p)} 是 ${ext2} 文档，read_file 只认纯文本。用 read_document 读它。`);
    }
    if (BINARY_EXT.has(ext2)) {
      return fail(
        `${p} 是二进制文件，读不出有意义的文本。` +
          '如果是要转格式或提取内容，用 run_command 调外部工具。',
      );
    }
    if (st.size > 8 * 1024 * 1024) return fail(`文件太大（${st.size} 字节），超过 8MB 不读。`);

    const raw = fs.readFileSync(p, 'utf8');
    const all = raw.split('\n');
    const start = Math.max(1, Number(args.start_line) || 1);
    const maxLines = Math.min(4000, Math.max(1, Number(args.max_lines) || 600));
    const slice = all.slice(start - 1, start - 1 + maxLines);

    const width = String(start + slice.length - 1).length;
    const numbered = slice
      .map((l, i) => `${String(start + i).padStart(width, ' ')}\t${l}`)
      .join('\n');

    const more =
      start - 1 + slice.length < all.length
        ? `\n\n…还有 ${all.length - (start - 1 + slice.length)} 行未读（全文共 ${all.length} 行）`
        : '';

    return ok(`${p}\n\n${numbered}${more}`, {
      summary: `读取 ${path.basename(p)}（${slice.length} 行）`,
      sources: [{ title: path.basename(p), path: p }],
    });
  } catch (e) {
    return fail(e);
  }
}

function writeFile(args, ctx) {
  try {
    const p = guardPath(args.path, ctx.workspaceRoots);
    const content = typeof args.content === 'string' ? args.content : '';
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existed = fs.existsSync(p);
    fs.writeFileSync(p, content, 'utf8');
    return ok(`已${existed ? '覆盖' : '创建'} ${p}（${content.length} 字符，${content.split('\n').length} 行）`, {
      summary: `${existed ? '覆盖' : '创建'} ${path.basename(p)}`,
      filePath: p,
    });
  } catch (e) {
    return fail(e);
  }
}

function editFile(args, ctx) {
  try {
    const p = guardPath(args.path, ctx.workspaceRoots, { mustExist: true });
    const oldStr = String(args.old_str ?? '');
    const newStr = String(args.new_str ?? '');
    if (!oldStr) return fail('old_str 不能为空。要整体重写请用 write_file。');

    const raw = fs.readFileSync(p, 'utf8');
    const first = raw.indexOf(oldStr);
    if (first === -1) return fail('old_str 在文件里找不到。注意缩进和换行必须完全一致。');
    if (raw.indexOf(oldStr, first + 1) !== -1) {
      return fail('old_str 在文件里出现了多次。请多带几行上下文让它唯一。');
    }

    const next = raw.slice(0, first) + newStr + raw.slice(first + oldStr.length);
    fs.writeFileSync(p, next, 'utf8');

    const lineNo = raw.slice(0, first).split('\n').length;
    return ok(`已修改 ${p}，第 ${lineNo} 行附近，${oldStr.length} 字符 → ${newStr.length} 字符。`, {
      summary: `修改 ${path.basename(p)}:${lineNo}`,
      filePath: p,
    });
  } catch (e) {
    return fail(e);
  }
}

function searchFiles(args, ctx) {
  try {
    const rootRaw = args.path ? args.path : firstRoot(ctx.workspaceRoots);
    const root = guardPath(rootRaw, ctx.workspaceRoots, { mustExist: true });

    let re;
    try {
      re = new RegExp(String(args.pattern), 'g');
    } catch (e) {
      return fail(`正则不合法：${e.message}`);
    }

    let globRe = null;
    if (args.glob) {
      const esc = String(args.glob)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      globRe = new RegExp(`^${esc}$`, 'i');
    }

    const maxResults = Math.min(400, Math.max(1, Number(args.max_results) || 60));
    const hits = [];
    let scanned = 0;

    const walk = (dir) => {
      if (hits.length >= maxResults || scanned > 6000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= maxResults || scanned > 6000) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full);
          continue;
        }
        if (globRe && !globRe.test(e.name)) continue;
        if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
        scanned++;
        let content;
        try {
          if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
          content = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            hits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= maxResults) return;
          }
        }
      }
    };

    walk(root);

    if (!hits.length) return ok(`在 ${root} 下没有匹配到 /${args.pattern}/。`, { summary: '搜索代码：0 条' });
    return ok(clip(hits.join('\n'), 40000), { summary: `搜索代码：${hits.length} 条` });
  } catch (e) {
    return fail(e);
  }
}

module.exports = { listDir, readFile, writeFile, editFile, searchFiles };
