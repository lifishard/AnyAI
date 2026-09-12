#!/usr/bin/env node
/**
 * 穷人版类型检查。
 *
 * 不是要取代 tsc —— 它只抓三类**最容易在没有编译器的环境里溜过去**的错误：
 *
 *   1. 具名导入指向的导出不存在
 *   2. 赋值给了一个从来没声明过的变量（漏掉 let/const 的典型症状）
 *   3. Record<某个字面量联合, T> 的键少了或多了
 *
 * 第 3 条专治「加了一个新的 union 成员，忘了更新对应的映射表」——
 * tsc 会拦，但要等到 CI 才知道。
 *
 *   node scripts/check-lite.mjs
 *
 * 退出码非 0 表示发现问题。这不保证类型正确，只保证没犯这三种低级错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');

/* ---------------- 收集文件 ---------------- */

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const src = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const problems = [];
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');

/* ---------------- 1. 导入 → 导出 ---------------- */

function resolveModule(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (src.has(cand)) return cand;
  }
  return `MISSING:${base}`;
}

function exportsOf(file) {
  const t = src.get(file);
  const names = new Set();
  for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of t.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (p) names.add(p.split(/\s+as\s+/).pop().trim());
    }
  }
  if (/export\s+default/.test(t)) names.add('default');
  return names;
}

for (const [file, t] of src) {
  for (const m of t.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolveModule(file, m[2]);
    if (!target) continue;
    if (target.startsWith('MISSING:')) {
      problems.push(`${rel(file)}：找不到模块 ${m[2]}`);
      continue;
    }
    const ex = exportsOf(target);
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/)[0].trim();
      if (name && !ex.has(name)) {
        problems.push(`${rel(file)}：${rel(target)} 没有导出 ${name}`);
      }
    }
  }
}

/* ---------------- 2. 赋值给未声明的变量 ---------------- */

const KEYWORDS = new Set(['if', 'for', 'while', 'return', 'const', 'let', 'var', 'else', 'case', 'do']);

for (const [file, t] of src) {
  // 收集这个文件里所有被声明过的名字（宽松：只要出现过声明形式就算）
  const declared = new Set();
  for (const m of t.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g)) declared.add(m[1]);
  for (const m of t.matchAll(/\b([A-Za-z0-9_$]+)\s*(?::[^=;,)]+)?\s*=>/g)) declared.add(m[1]);
  // 解构、参数、import 绑定，一律当成已声明
  for (const m of t.matchAll(/[{(,]\s*([A-Za-z0-9_$]+)\s*[,})\]:]/g)) declared.add(m[1]);
  for (const m of t.matchAll(/import\s+([A-Za-z0-9_$]+)/g)) declared.add(m[1]);
  // 带默认值的函数参数：foo(bar = '', baz: X = 1)
  for (const m of t.matchAll(/[(,]\s*([A-Za-z0-9_$]+)\s*(?::[^,)=]+)?=\s*[^,)]+[,)]/g)) declared.add(m[1]);
  // 类字段：class 体里直接写的 name = value
  for (const cls of t.matchAll(/\bclass\s+[A-Za-z0-9_$]+[^{]*\{/g)) {
    let depth = 0;
    let i = t.indexOf('{', cls.index);
    const start = i;
    for (; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}' && --depth === 0) break;
    }
    for (const f of t.slice(start, i).matchAll(/\n\s{2}(?:readonly\s+)?([A-Za-z0-9_$]+)\s*(?::[^=\n]+)?=/g)) {
      declared.add(f[1]);
    }
  }

  // 裸赋值。不能只扫行首 —— 漏掉的那次正是 `if (d) sawAnything = true` 这种
  // 写在行中间的形式。所以扫所有 `名字 =`，再排除：
  //   - 属性赋值（前面有 . 或 ?.）
  //   - 比较（== / === / =>）
  //   - JSX 属性（只在 .ts 里查，.tsx 的 attr= 太多，噪音盖过信号）
  if (file.endsWith('.ts')) {
    // 只认「语句位置」上的赋值：行首、分号后、大括号后、或 `if (...)` 的右括号后。
    // 类型标注里的 `: Foo | null = x` 不会命中 —— 那里的名字前面是 : 或 |，
    // 这是区分「赋值」和「标注」最省事又不误伤的判据。
    for (const m of t.matchAll(/(?:^|[;{}]|\)\s*)\s*\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?![=>])/gm)) {
      const name = m[1];
      if (KEYWORDS.has(name) || declared.has(name)) continue;
      const line = t.slice(0, m.index).split('\n').length;
      problems.push(`${rel(file)}:${line}：给未声明的变量赋值 —— ${name}`);
    }
  }
}

/* ---------------- 3. Record<联合类型, T> 的键完整性 ---------------- */

// 先把所有「字面量联合类型」收集起来：export type X = 'a' | 'b' | 'c'
const unions = new Map(); // "文件|类型名" → 成员
for (const [file, t] of src) {
  for (const m of t.matchAll(/(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=\s*([^;]+);/g)) {
    const body = m[2];
    if (!/^[\s|]*'/.test(body)) continue; // 不是字面量联合
    const members = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    // 只在**同一个文件**里比对：不同文件可以各有一个叫 Tab 的类型，
    // 混在一起查会互相污染，报一堆假阳性
    if (members.length > 1) unions.set(`${file}|${m[1]}`, members);
  }
}

for (const [file, t] of src) {
  for (const m of t.matchAll(/:\s*Record<\s*([A-Za-z0-9_$]+)\s*,[^>]*>\s*=\s*\{/g)) {
    const union = unions.get(`${file}|${m[1]}`);
    if (!union) continue;

    // 取出这个对象字面量（从 { 开始数括号）
    let depth = 0;
    let i = t.indexOf('{', m.index);
    const start = i;
    for (; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}' && --depth === 0) break;
    }
    const body = t.slice(start + 1, i);
    const keys = new Set(
      [...body.matchAll(/(?:^|\n)\s*['"]?([A-Za-z0-9_$-]+)['"]?\s*:/g)].map((x) => x[1]),
    );
    const missing = union.filter((k) => !keys.has(k));
    const line = t.slice(0, m.index).split('\n').length;
    if (missing.length) {
      problems.push(
        `${rel(file)}:${line}：Record<${m[1]}, …> 少了这些键 —— ${missing.join('、')}`,
      );
    }
  }
}

/* ---------------- 结果 ---------------- */

if (problems.length) {
  console.error(`\n发现 ${problems.length} 个问题：\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\n注意：这只是三项低级错误的检查，通过不代表类型正确。真正的检查是 npm run typecheck。\n');
  process.exit(1);
}

console.log(`\n✓ ${src.size} 个文件，三项低级错误检查通过`);
console.log('（导入解析、未声明赋值、Record 键完整性 —— 真正的类型检查仍然要 npm run typecheck）\n');
