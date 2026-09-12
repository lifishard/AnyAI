'use strict';
/**
 * 技能文件夹读写。
 *
 * ── 为什么是 IPC 而不是一个模型能调的工具 ──
 *
 * 技能目录（默认 ~/.claude/skills）在工作目录白名单**之外** —— 这是必须的，
 * 因为 Claude Code 和 Claude Desktop 就认那个位置。
 *
 * 但这也意味着：如果把它做成 registry 里的工具，模型就多了一条绕过白名单往
 * 任意路径写文件的通道（`dir` 参数它说了算）。所以它只从界面调用，路径由
 * 用户在设置里指定，模型碰不到。
 *
 * ── 不做删除 ──
 *
 * 同步永远只新增和更新，从不删除任何一边的文件。删除是破坏性的、不可撤销的，
 * 而「A 端没有」有太多种可能（还没同步过来、被改名了、用户故意只在一端留着）。
 * 猜错一次的代价远大于省下的那点手工。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Claude Code / Desktop 读的就是这个位置 */
function defaultDir() {
  return path.join(os.homedir(), '.claude', 'skills');
}

function safeDir(dir) {
  const d = String(dir || '').trim();
  if (!d) throw new Error('没有指定技能目录');
  const abs = path.resolve(d);
  // 不允许指到根目录或用户主目录本身 —— 那不是「技能目录」，
  // 往那里摊一堆文件夹是灾难
  const home = os.homedir();
  if (abs === path.parse(abs).root || abs === home) {
    throw new Error(`${abs} 太靠上了，请指到一个专门的技能目录，比如 ${defaultDir()}`);
  }
  return abs;
}

/**
 * 扫描目录，返回每个技能的原文。
 *
 * 认两种布局：
 *   <dir>/<名字>/SKILL.md    ← 标准，Claude 的布局
 *   <dir>/<名字>.md          ← 有人图省事这么放，也认
 */
function read(dir) {
  try {
    const root = safeDir(dir);
    if (!fs.existsSync(root)) return { ok: true, dir: root, exists: false, items: [] };

    const items = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      let file = null;
      let name = null;

      if (e.isDirectory()) {
        const p = path.join(root, e.name, 'SKILL.md');
        if (fs.existsSync(p)) {
          file = p;
          name = e.name;
        }
      } else if (e.isFile() && /\.md$/i.test(e.name) && !/^README\.md$/i.test(e.name)) {
        file = path.join(root, e.name);
        name = e.name.replace(/\.md$/i, '');
      }
      if (!file) continue;

      try {
        const st = fs.statSync(file);
        if (st.size > 1024 * 1024) continue; // 1MB 以上的不像技能，跳过
        items.push({
          name,
          md: fs.readFileSync(file, 'utf8'),
          mtimeMs: st.mtimeMs,
          path: file,
        });
      } catch {
        /* 单个文件读不了就跳过，不要因为一个坏文件让整次同步失败 */
      }
    }
    return { ok: true, dir: root, exists: true, items };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

/**
 * 写入若干技能。每个写成 <dir>/<名字>/SKILL.md。
 *
 * 名字做过清洗：只留字母数字、连字符、下划线和中文，避免 ../ 之类跑出目录。
 */
function write(dir, items) {
  try {
    const root = safeDir(dir);
    fs.mkdirSync(root, { recursive: true });

    const written = [];
    const failed = [];

    for (const it of Array.isArray(items) ? items : []) {
      const name = String(it?.name || '').replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!name) {
        failed.push({ name: String(it?.name), error: '名字清洗后是空的' });
        continue;
      }
      const md = typeof it?.md === 'string' ? it.md : '';
      if (!md.trim()) {
        failed.push({ name, error: '正文是空的，不写' });
        continue;
      }
      try {
        const folder = path.join(root, name);
        // 再确认一次结果确实落在 root 里 —— 名字清洗之外的第二道
        if (path.relative(root, folder).startsWith('..')) {
          failed.push({ name, error: '路径跑出技能目录了' });
          continue;
        }
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'SKILL.md'), md, 'utf8');
        written.push(name);
      } catch (e) {
        failed.push({ name, error: e.message });
      }
    }
    return { ok: true, dir: root, written, failed };
  } catch (e) {
    return { ok: false, error: e.message, written: [], failed: [] };
  }
}

module.exports = { read, write, defaultDir };
