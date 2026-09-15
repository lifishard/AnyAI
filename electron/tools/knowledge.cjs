'use strict';
/**
 * 项目记忆 / 项目文档 / 技能 的读写工具。
 *
 * 这些数据存在跟渲染进程同一份 kv 里（store.cjs 的 kv 段），所以两边看到的
 * 永远是同一份，不需要再造一套同步。渲染进程通过 transport.kvGet/kvSet 读写，
 * 主进程这边直接 store.kvGet/kvSet。
 */
const store = require('../store.cjs');
const { ok, fail, clip } = require('./common.cjs');

const K_PROJECTS = 'snc:projects:v1';
const K_SKILLS = 'snc:skills:v1';

function readList(key) {
  try {
    const raw = store.kvGet(key);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeList(key, list) {
  return store.kvSet(key, JSON.stringify(list));
}

function currentProject(ctx) {
  if (!ctx.projectId) return null;
  return readList(K_PROJECTS).find((p) => p.id === ctx.projectId) ?? null;
}

const NO_PROJECT = '当前对话不属于任何项目。把对话放进一个项目里，这个工具才有东西可读写。';

/* ---------------- 项目记忆 ---------------- */

function projectMemoryRead(_args, ctx) {
  const p = currentProject(ctx);
  if (!p) return fail(NO_PROJECT);
  if (!String(p.memory || '').trim()) {
    return ok(`项目「${p.name}」还没有记忆内容。`, { summary: '读项目记忆：空' });
  }
  return ok(p.memory, { summary: `读项目记忆（${p.memory.length} 字）` });
}

async function projectMemoryWrite(args, ctx) {
  const p = currentProject(ctx);
  if (!p) return fail(NO_PROJECT);

  const text = String(args.text || '').trim();
  if (!text) return fail('text 不能为空');
  const mode = args.mode === 'replace' ? 'replace' : 'append';

  const list = readList(K_PROJECTS);
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0) return fail('项目不见了，可能刚被删掉');

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const next =
    mode === 'replace'
      ? text
      : `${String(list[i].memory || '').trimEnd()}\n\n[${stamp}] ${text}`.trim();

  // 别让记忆无限膨胀 —— 每轮都要拼进 system prompt
  const MAX = 20000;
  list[i].memory = next.length > MAX ? `…（较早的记忆已截断）\n${next.slice(-MAX)}` : next;
  await writeList(K_PROJECTS, list);

  return ok(`已${mode === 'replace' ? '覆盖' : '追加'}到项目「${p.name}」的记忆。`, {
    summary: `写项目记忆（${text.length} 字）`,
  });
}

/* ---------------- 项目文档 ---------------- */

function projectDocRead(args, ctx) {
  const p = currentProject(ctx);
  if (!p) return fail(NO_PROJECT);

  const docs = p.docs || [];
  if (!docs.length) return fail(`项目「${p.name}」里没有文档。`);

  const name = String(args.name || '').trim();
  if (!name) {
    return ok(docs.map((d) => `- ${d.name}（${d.text.length} 字）`).join('\n'), {
      summary: `列出项目文档（${docs.length} 篇）`,
    });
  }

  const lower = name.toLowerCase();
  const hit =
    docs.find((d) => d.name.toLowerCase() === lower) ||
    docs.find((d) => d.name.toLowerCase().includes(lower));

  if (!hit) {
    return fail(`没有叫「${name}」的文档。现有的：${docs.map((d) => d.name).join('、')}`);
  }

  const maxChars = Math.min(80000, Math.max(500, Number(args.max_chars) || 20000));
  return ok(`# ${hit.name}\n\n${clip(hit.text, maxChars)}`, {
    summary: `读文档《${hit.name}》`,
    sources: [{ title: hit.name, path: `项目文档 / ${p.name} / ${hit.name}` }],
  });
}

async function projectDocWrite(args, ctx) {
  const p = currentProject(ctx);
  if (!p) return fail(NO_PROJECT);

  const name = String(args.name || '').trim();
  const text = String(args.text || '');
  if (!name) return fail('name 不能为空');

  const list = readList(K_PROJECTS);
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0) return fail('项目不见了');

  const docs = list[i].docs || [];
  const j = docs.findIndex((d) => d.name.toLowerCase() === name.toLowerCase());
  const now = Date.now();

  if (j >= 0) {
    docs[j] = { ...docs[j], text, updatedAt: now };
  } else {
    docs.push({ id: `d-${now}-${Math.random().toString(36).slice(2, 8)}`, name, text, updatedAt: now });
  }
  list[i].docs = docs;
  await writeList(K_PROJECTS, list);

  return ok(`已${j >= 0 ? '更新' : '新建'}文档《${name}》（${text.length} 字）。`, {
    summary: `${j >= 0 ? '更新' : '新建'}文档《${name}》`,
  });
}

/* ---------------- 技能 ---------------- */

function slugify(name) {
  return (
    String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^\w一-龥-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  );
}

function skillList(_args) {
  const list = readList(K_SKILLS);
  if (!list.length) return ok('还没有任何技能。', { summary: '技能：0 个' });
  return ok(
    list.map((s) => `/${s.name}${s.enabled ? '' : '（已停用）'} — ${s.description || '无描述'}`).join('\n'),
    { summary: `列出技能（${list.length} 个）` },
  );
}

async function skillWrite(args) {
  const name = slugify(args.name);
  const body = String(args.body || '').trim();
  if (!body) return fail('body 不能为空 —— 技能的正文就是要注入的那段指令');

  const list = readList(K_SKILLS);
  const i = list.findIndex((s) => s.name === name);
  const now = Date.now();

  const rec = {
    id: i >= 0 ? list[i].id : `sk-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: String(args.description || (i >= 0 ? list[i].description : '') || '').slice(0, 200),
    body,
    source: i >= 0 ? list[i].source : '模型创建',
    enabled: true,
    installedAt: i >= 0 ? list[i].installedAt : now,
    uses: i >= 0 ? list[i].uses : 0,
  };

  if (i >= 0) list[i] = rec;
  else list.push(rec);
  await writeList(K_SKILLS, list);

  return ok(
    `已${i >= 0 ? '更新' : '创建'}技能 /${name}。用户在输入框里打 /${name} 就能唤起。`,
    { summary: `${i >= 0 ? '更新' : '创建'}技能 /${name}` },
  );
}

module.exports = {
  projectMemoryRead,
  projectMemoryWrite,
  projectDocRead,
  projectDocWrite,
  skillList,
  skillWrite,
};
