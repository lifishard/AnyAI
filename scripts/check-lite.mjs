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

/* ------------------------------------------------------------------ *
 * 四、同一作用域里重复声明
 *
 * 起因是一个真事：往 App.tsx 里加了一个 `const runProbe`，而 513 行早就有
 * 一个 `runProbe`（批量体检那个）。tsc 和 esbuild 都会拦，但这台机器上
 * 两个都跑不了，于是它一路跑到用户的构建里才炸。
 *
 * 第一版拿缩进当作用域，立刻被 sse.ts 打脸：两个不同函数里各有一个
 * `const usage`，缩进都是 2，被误判成重复。所以这里老老实实维护一个
 * **花括号作用域栈** —— 进 `{` 压一层，出 `}` 弹一层，只在同一层里比。
 *
 * 字符串、模板串、正则和注释里的花括号会把层数带歪，所以先粗暴地把它们
 * 抹成空白再数。抹得不完美不要紧：抹错的方向是「少报」，而这个检查宁可
 * 漏一个也不要吵。
 * ------------------------------------------------------------------ */

/** 前一个非空白字符决定了 `/` 是正则的开头还是除号 */
function isRegexStart(before) {
  const prev = before.replace(/\s+$/, '').slice(-1);
  if (prev === '') return true;
  return !/[A-Za-z0-9_$)\]]/.test(prev);
}

/** 把字符串 / 模板串 / 正则 / 注释里的内容换成等长空格，只为了数花括号 */
function blankLiterals(t) {
  let out = '';
  let i = 0;
  const keep = (n) => {
    out += t.slice(i, i + n);
    i += n;
  };
  const blank = (n) => {
    // 换行保留，否则行号会错位
    out += t.slice(i, i + n).replace(/[^\n]/g, ' ');
    i += n;
  };
  while (i < t.length) {
    const c = t[i];
    const two = t.slice(i, i + 2);
    if (two === '//') {
      const end = t.indexOf('\n', i);
      blank(end === -1 ? t.length - i : end - i);
    } else if (two === '/*') {
      const end = t.indexOf('*/', i + 2);
      blank(end === -1 ? t.length - i : end + 2 - i);
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < t.length && t[j] !== c) j += t[j] === '\\' ? 2 : 1;
      blank(Math.min(j + 1, t.length) - i);
    } else if (c === '/' && isRegexStart(out)) {
      /*
       * 正则字面量也要抹。`md.match(/^---\r?\n(...)/)` 里那个 `\n(` 会被
       * 当成「调用了 n()」；而正则里的花括号还会把作用域栈的层数数歪。
       *
       * 「这个 / 是正则还是除号」没有正则解法，只能看前一个非空白字符：
       * 除号只可能跟在值后面（标识符、数字、) ] 之类），其余位置都是正则。
       */
      let j = i + 1;
      let inClass = false;
      for (; j < t.length; j++) {
        const d = t[j];
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break; // 换行说明前面那个 / 其实是除号，放弃
      }
      if (t[j] === '/') blank(j + 1 - i);
      else keep(1);
    } else {
      keep(1);
    }
  }
  return out;
}

for (const [file, t] of src) {
  const clean = blankLiterals(t);
  const stack = [new Map()];
  let line = 1;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '\n') {
      line++;
      continue;
    }
    if (ch === '{') {
      stack.push(new Map());
      continue;
    }
    if (ch === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    // 只在一行的开头位置（前面全是空白）认声明，避免 `} else const` 之类的误伤
    const lineStart = clean.lastIndexOf('\n', i - 1) + 1;
    if (clean.slice(lineStart, i).trim() !== '') continue;

    const m = clean.slice(i).match(/^(?:export\s+)?(?:const|let|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    if (!m) continue;
    const scope = stack[stack.length - 1];
    const prev = scope.get(m[1]);
    if (prev !== undefined) {
      problems.push(
        `${rel(file)}:${line}：「${m[1]}」重复声明了，第 ${prev} 行已经有一个 —— 构建会直接失败`,
      );
    } else {
      scope.set(m[1], line);
    }
    i += m[0].length - 1;
  }
}

/* ------------------------------------------------------------------ *
 * 五、props.X 用了却没在 props 类型里声明
 *
 * 又是一件真事：给 ErrorCard 加了 `props.onProbe`，但那个组件的 props 类型
 * 写成了一行 `(props: { raw: string; info?: ErrorInfo; onRetry?: () => void })`，
 * 我的多行替换没匹配上、**静默地什么都没做**，于是签名没改成，body 却已经
 * 在用 onProbe 了。tsc 一眼就看出来，可惜这台机器上没有 tsc。
 *
 * 这个检查只认这个代码库统一的写法：props 类型就地写成对象字面量。
 * 认不出来的（比如 props 类型抽成了 interface）一律跳过，不猜。
 * ------------------------------------------------------------------ */

/** 从 `(props: {` 后面那个 `{` 开始，取出平衡的对象字面量 */
function balanced(t, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) return { body: t.slice(openIdx + 1, i), end: i };
  }
  return null;
}

for (const [file, t] of src) {
  if (!file.endsWith('.tsx')) continue;
  const clean = blankLiterals(t);

  for (const m of clean.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(\s*props\s*:\s*\{/g)) {
    const open = clean.indexOf('{', m.index + m[0].length - 1);
    const typeObj = balanced(clean, open);
    if (!typeObj) continue;

    /*
     * 只取顶层的键。
     *
     * 第一版按行取，每行只认第一个 —— 于是单行写法
     * `{ port: number; onPort: (p: number) => void }` 里的 onPort 被漏掉，
     * 又是一条假警报。改成扫字符：括号深度为 0、且紧跟在 { ; , 或换行
     * 后面的标识符才算一个键。
     */
    const keys = new Set();
    {
      const b = typeObj.body;
      let depth = 0;
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (depth === 0 && /[A-Za-z_$]/.test(c)) {
          const before = b.slice(0, i).replace(/\s+$/, '').slice(-1);
          if (before === '' || before === '{' || before === ';' || before === ',') {
            const k = b.slice(i).match(/^([A-Za-z0-9_$]+)\s*\??\s*:/);
            if (k) {
              keys.add(k[1]);
              i += k[1].length - 1;
            }
          }
        }
      }
    }
    if (!keys.size) continue;

    // 函数体 = 类型对象结束之后，到下一个顶格 function / export 为止
    const after = clean.slice(typeObj.end);
    // `export default function X` 里夹着 default —— 第一版漏了它，
    // 于是 TasksTab 的「函数体」一路吞掉了后面整个 WorkspaceDialog，
    // 报出三个根本不存在的问题。边界判错的代价就是整页噪音
    const nextTop = after
      .slice(1)
      .search(/\n(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|const|class)\s/);
    const body = nextTop === -1 ? after : after.slice(0, nextTop + 1);

    const seen = new Set();
    for (const u of body.matchAll(/\bprops\.([A-Za-z0-9_$]+)/g)) {
      if (keys.has(u[1]) || seen.has(u[1])) continue;
      seen.add(u[1]);
      const line = clean.slice(0, typeObj.end + u.index).split('\n').length;
      problems.push(
        `${rel(file)}:${line}：${m[1]} 用了 props.${u[1]}，但它的 props 类型里没有这一项`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 六、调用了一个本文件里根本不存在的函数
 *
 * 第三次教训了：一次「按区间替换」把 probe400.ts 里的 minimal / bisectTools /
 * serializes 三个函数连带删掉，而调用它们的代码还在。前面五项检查全绿，
 * 直到把文件拿去跑测试才炸。
 *
 * 这条检查只管一件事：`foo(` 里的 foo，在这个文件里既没声明也没导入，
 * 而且不是已知的全局。宁可漏，不可吵 —— 所以下面的白名单给得很宽。
 * ------------------------------------------------------------------ */

const GLOBALS = new Set([
  'console','JSON','Math','Object','Array','Number','String','Boolean','Date','Error','TypeError',
  'RangeError','RegExp','Map','Set','WeakMap','WeakSet','Promise','Symbol','BigInt','Proxy','Reflect',
  'URL','URLSearchParams','Blob','File','FileReader','FormData','Headers','Request','Response','AbortController',
  'TextEncoder','TextDecoder','Intl','fetch','setTimeout','clearTimeout','setInterval','clearInterval',
  'queueMicrotask','structuredClone','requestAnimationFrame','cancelAnimationFrame','encodeURIComponent',
  'decodeURIComponent','encodeURI','decodeURI','parseInt','parseFloat','isNaN','isFinite','atob','btoa',
  'crypto','window','document','navigator','localStorage','sessionStorage','alert','confirm','prompt',
  'require','import','super','this','typeof','void','await','return','if','for','while','switch','catch',
  'function','new','delete','in','of','instanceof','yield','React','process','Buffer','globalThis',
  'async','else','do','try','finally','throw','case','default','export','from','as','satisfies','keyof',
]);

/**
 * 把 interface / type 的**方法签名**抹掉再扫。
 *
 * `kvGet(key: string): Promise<string>` 长得跟一次调用一模一样，但它是声明。
 * 不抹的话 types.ts 会一口气报出五条假警报 —— 第一次跑就是这样。
 */
function blankTypeBodies(t) {
  let out = t;
  for (const m of [...t.matchAll(/\b(?:interface|declare\s+global)\b[^{]*\{/g)].reverse()) {
    const open = t.indexOf('{', m.index);
    const b = balanced(t, open);
    if (!b) continue;
    out = out.slice(0, open) + out.slice(open, b.end + 1).replace(/[^\n]/g, ' ') + out.slice(b.end + 1);
  }
  return out;
}

for (const [file, t] of src) {
  const clean = blankTypeBodies(blankLiterals(t));
  const declared = new Set();

  // 导入进来的名字
  for (const m of clean.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+/g)) {
    for (const n of m[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) declared.add(n[0]);
  }
  // 任意层级的声明、函数参数、解构、for-of、catch
  for (const m of clean.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    declared.add(m[1]);
  }
  /*
   * 参数表：不能用 [^()]* —— 参数类型里全是括号，
   * `createSseParser(onData: (payload: string) => void)` 就是这么漏掉 onData 的。
   * 改成数括号，取出完整的参数表再挖名字。
   */
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== '(') continue;
    let depth = 0;
    let j = i;
    for (; j < clean.length; j++) {
      if (clean[j] === '(') depth++;
      else if (clean[j] === ')' && --depth === 0) break;
    }
    const next = clean.slice(j + 1).match(/^\s*(=>|\{)/);
    if (!next) continue;
    for (const n of clean.slice(i + 1, j).matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) declared.add(n[0]);
    i = j;
  }
  // 解构：分隔符用前瞻，不要吃掉 —— 吃掉的话 `{ consumer, finish }` 里
  // 逗号被 consumer 消费，finish 就再也匹配不上了
  // 数组解构也算：`const [message, setMessage] = useState()` 是 React 里最常见的写法
  for (const m of clean.matchAll(/[{,[]\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,}\]:=])/g)) {
    declared.add(m[1]);
  }

  /** 从 `(` 数到配对的 `)`，返回它后面第一个非空白字符 */
  const afterArgs = (openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < clean.length; i++) {
      if (clean[i] === '(') depth++;
      else if (clean[i] === ')' && --depth === 0) {
        const rest = clean.slice(i + 1).match(/^\s*(\S)/);
        return rest ? rest[1] : '';
      }
    }
    return '';
  };

  const seen = new Set();
  for (const m of clean.matchAll(/(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm)) {
    const name = m[2];
    if (declared.has(name) || GLOBALS.has(name) || seen.has(name)) continue;
    // 参数表后面跟 { 或 : 的是**定义**不是调用：类方法、对象字面量里的方法简写、
    // 带返回类型的签名。第二轮假警报全出在这里
    const nx = afterArgs(m.index + m[0].length - 1);
    if (nx === '{' || nx === ':') continue;
    // 首字母大写的当成组件/构造函数放过：JSX 和类型断言里太容易误伤
    if (/^[A-Z]/.test(name)) continue;
    seen.add(name);
    const line = clean.slice(0, m.index).split('\n').length;
    problems.push(`${rel(file)}:${line}：调用了 ${name}()，但本文件里既没声明也没导入它`);
  }
}

/* ------------------------------------------------------------------ *
 * 七、标了 @cloneable 的接口里混进了函数
 *
 * 又一次真实事故：给 ChatRequestInit 加了个 onPaceWait 回调，而这个对象
 * 要过 Electron 的 ipcRenderer.invoke（结构化克隆）。结果每一条请求都在
 * 0.0 秒炸成 "An object could not be cloned."，一个字节都没发出去。
 *
 * 类型系统拦不住 —— 函数在 TS 看来是完全合法的属性。所以约定一个标记：
 * 接口的文档注释里写 @cloneable，这里就替它盯着，不许有函数成员。
 * ------------------------------------------------------------------ */

for (const [file, t] of src) {
  // 注意用原文而不是 blankLiterals 的结果 —— @cloneable 写在注释里，
  // 而 blankLiterals 的第一件事就是把注释抹掉。第一版就是这么自己把自己弄瞎的
  for (const m of t.matchAll(/@cloneable[\s\S]{0,600}?\binterface\s+([A-Za-z0-9_$]+)\s*\{/g)) {
    const open = t.indexOf('{', m.index + m[0].length - 1);
    const obj = balanced(t, open);
    if (!obj) continue;
    let depth = 0;
    let lineNo = t.slice(0, open).split('\n').length;
    for (const line of obj.body.split('\n')) {
      lineNo++;
      const isFn =
        depth === 0 &&
        /^\s*[A-Za-z0-9_$]+\s*\??\s*(?::\s*\(|\()/.test(line) &&
        /=>|\)\s*:\s*void|\)\s*:\s*Promise/.test(line);
      if (isFn) {
        const name = line.match(/^\s*([A-Za-z0-9_$]+)/)?.[1] ?? '?';
        problems.push(
          `${rel(file)}:${lineNo}：${m[1]} 标了 @cloneable，但 ${name} 是个函数 —— ` +
            '它过不了结构化克隆，整条请求会在发出去之前就失败',
        );
      }
      depth += (line.split('{').length - 1) - (line.split('}').length - 1);
    }
  }
}

/* ---------------- 结果 ---------------- */

if (problems.length) {
  console.error(`\n发现 ${problems.length} 个问题：\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\n注意：这只是七项低级错误的检查，通过不代表类型正确。真正的检查是 npm run typecheck。\n');
  process.exit(1);
}

console.log(`\n✓ ${src.size} 个文件，七项低级错误检查通过`);
console.log('（导入解析、未声明赋值、Record 键完整性、重复声明、props 字段、未定义的调用、IPC 可克隆性 —— 真正的类型检查仍然要 npm run typecheck）\n');
