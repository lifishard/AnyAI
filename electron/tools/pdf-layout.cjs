'use strict';
/**
 * PDF → Markdown，按版面重建，而不是把文本片段一股脑拼起来。
 *
 * 为什么要自己做这件事：PDF 里根本没有「段落」「表格」「栏」这些概念，只有一堆
 * 带坐标的字符串片段。朴素的抽取（pdf-parse 之类）就是按内部顺序 join 一下，
 * 结果是：双栏论文左右栏交替串行、表格塌成一行、标题和正文分不开、
 * 换行处的连字符留在原地。这就是「错位」的来源。
 *
 * 这里用 pdfjs 给出的每个片段的坐标和字号，按下面的顺序还原：
 *   1. 按 y 聚成行（同一行的片段 y 差在容差内）
 *   2. 检测竖直空白带（gutter）切分栏，每栏各自从上到下走一遍 —— 这一步是
 *      避免双栏交替串行的关键
 *   3. 行内按 x 排序，x 间距超过阈值补空格
 *   4. 按字号相对页面中位数判标题级别
 *   5. 连续多行在相同的 x 位置成列 → 输出 Markdown 表格
 *   6. 行尾连字符接下一行；未以句末标点结束且左边距相同 → 并进同一段
 */

/** 动态 import pdfjs：它只有 ESM 构建，从 CJS 里必须用 import() */
async function loadPdfjs() {
  const candidates = [
    'pdfjs-dist/legacy/build/pdf.mjs',
    'pdfjs-dist/legacy/build/pdf.js',
    'pdfjs-dist/build/pdf.mjs',
    'pdfjs-dist',
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      const mod = await import(c);
      if (mod && (mod.getDocument || (mod.default && mod.default.getDocument))) {
        return mod.getDocument ? mod : mod.default;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `载入 pdfjs-dist 失败：${lastErr ? lastErr.message : '找不到入口'}。` +
      '确认依赖装好了（npm install），或者把这条错误贴回来。',
  );
}

/* ------------------------------------------------------------------ *
 * 1. 片段 → 行
 * ------------------------------------------------------------------ */

function toFragments(textContent) {
  const out = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform; // [a, b, c, d, e, f]，e/f 是平移
    const size = Math.hypot(t[2], t[3]) || it.height || 10;
    out.push({
      text: it.str,
      x: t[4],
      y: t[5],
      w: it.width || 0,
      size,
      font: it.fontName || '',
      bold: /bold|black|heavy|semib/i.test(it.fontName || ''),
    });
  }
  return out;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function groupLines(frags) {
  if (!frags.length) return [];
  const medSize = median(frags.map((f) => f.size)) || 10;
  const tol = Math.max(1.5, medSize * 0.45);

  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;

  for (const f of sorted) {
    if (cur && Math.abs(cur.y - f.y) <= tol) {
      cur.frags.push(f);
      cur.y = (cur.y * (cur.frags.length - 1) + f.y) / cur.frags.length;
    } else {
      cur = { y: f.y, frags: [f] };
      lines.push(cur);
    }
  }

  for (const l of lines) {
    l.frags.sort((a, b) => a.x - b.x);
    l.x0 = l.frags[0].x;
    l.x1 = Math.max(...l.frags.map((f) => f.x + f.w));
    l.size = Math.max(...l.frags.map((f) => f.size));
    l.bold = l.frags.every((f) => f.bold);
    l.text = joinFrags(l.frags);
  }
  return lines;
}

/** 行内拼接：x 间距明显大于一个字宽就补空格（中文之间不补） */
function joinFrags(frags) {
  let out = '';
  let prev = null;
  for (const f of frags) {
    if (prev) {
      const gap = f.x - (prev.x + prev.w);
      const cjkEdge = /[　-鿿]$/.test(out) && /^[　-鿿]/.test(f.text);
      if (gap > prev.size * 0.22 && !cjkEdge && !/\s$/.test(out) && !/^\s/.test(f.text)) {
        out += ' ';
      }
    }
    out += f.text;
    prev = f;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * 2. 分栏
 *
 * 做法：把页面横向切成细格，统计每格被多少行覆盖。连续一段格子的覆盖率
 * 接近 0、且这段足够宽，就是一条竖直空白带（gutter），据此切栏。
 * 只在「两侧都有足够多的行」时才认，避免把居中标题误判成分栏。
 * ------------------------------------------------------------------ */

function detectColumns(lines, pageWidth) {
  if (lines.length < 12) return null;

  const BINS = 100;
  const binW = pageWidth / BINS;
  const cover = new Array(BINS).fill(0);

  for (const l of lines) {
    const a = Math.max(0, Math.floor(l.x0 / binW));
    const b = Math.min(BINS - 1, Math.ceil(l.x1 / binW));
    for (let i = a; i <= b; i++) cover[i]++;
  }

  const maxCover = Math.max(...cover);
  if (!maxCover) return null;
  const isGap = cover.map((c) => c <= maxCover * 0.04);

  // 找最宽的那条空白带，且必须在页面中间 30%~70% 区域
  let best = null;
  let run = 0;
  for (let i = 0; i <= BINS; i++) {
    if (i < BINS && isGap[i]) {
      run++;
      continue;
    }
    if (run >= 4) {
      const start = i - run;
      const mid = (start + i) / 2 / BINS;
      if (mid > 0.3 && mid < 0.7 && (!best || run > best.run)) {
        best = { run, splitX: ((start + i) / 2) * binW };
      }
    }
    run = 0;
  }
  if (!best) return null;

  const left = lines.filter((l) => l.x1 <= best.splitX);
  const right = lines.filter((l) => l.x0 >= best.splitX);
  // 跨栏的行（标题、跨栏图表说明）单独留着
  const spanning = lines.filter((l) => l.x0 < best.splitX && l.x1 > best.splitX);

  if (left.length < 5 || right.length < 5) return null;
  return { left, right, spanning, splitX: best.splitX };
}

/* ------------------------------------------------------------------ *
 * 3. 表格：连续若干行，片段的 x 起点能对齐成同样的若干列
 * ------------------------------------------------------------------ */

function columnSignature(line) {
  return line.frags.map((f) => Math.round(f.x / 6)); // 6pt 粒度
}

function detectTableBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const sig = columnSignature(lines[i]);
    if (sig.length < 2) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      const s2 = columnSignature(lines[j]);
      if (s2.length < 2) break;
      // 列起点重合度过半才算同一张表
      const hit = s2.filter((x) => sig.some((y) => Math.abs(x - y) <= 1)).length;
      if (hit / Math.max(sig.length, s2.length) < 0.6) break;
      j++;
    }
    if (j - i >= 3) {
      blocks.push({ start: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return blocks;
}

function renderTable(lines) {
  const rows = lines.map((l) => l.frags.map((f) => f.text.trim()).filter(Boolean));
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...new Array(cols - r.length).fill('')];
  const esc = (c) => c.replace(/\|/g, '\\|');

  const head = pad(rows[0]).map(esc);
  const body = rows.slice(1).map((r) => pad(r).map(esc));

  return [
    `| ${head.join(' | ')} |`,
    `| ${new Array(cols).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 4. 行 → Markdown
 * ------------------------------------------------------------------ */

const BULLET = /^([•·▪◦‣∙*]|[-–—](?=\s)|\(?\d{1,2}[.)]|[a-z][.)])\s+/i;
const SENTENCE_END = /[.。!！?？:：;；"'）)\]】]$/;

function linesToMarkdown(lines, medSize) {
  const tables = detectTableBlocks(lines);
  const inTable = new Set();
  for (const b of tables) for (let i = b.start; i < b.end; i++) inTable.add(i);

  const leftMargin = median(lines.map((l) => l.x0));
  const out = [];
  let para = '';

  const flush = () => {
    if (para.trim()) out.push(para.trim());
    para = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const tb = tables.find((b) => b.start === i);
    if (tb) {
      flush();
      out.push(renderTable(lines.slice(tb.start, tb.end)));
      i = tb.end - 1;
      continue;
    }
    if (inTable.has(i)) continue;

    const l = lines[i];
    const text = l.text;
    if (!text) continue;

    // 标题：字号明显大于正文，且不长
    const ratio = l.size / (medSize || l.size);
    if ((ratio >= 1.12 || (l.bold && ratio >= 1.02)) && text.length <= 90) {
      flush();
      const level = ratio >= 1.6 ? 1 : ratio >= 1.35 ? 2 : ratio >= 1.15 ? 3 : 4;
      out.push(`${'#'.repeat(level)} ${text}`);
      continue;
    }

    // 列表项
    const bm = text.match(BULLET);
    if (bm) {
      flush();
      out.push(`- ${text.slice(bm[0].length).trim()}`);
      continue;
    }

    // 段落合并：上一行没以句末标点结束，且这一行是正常左边距 → 接上去
    if (para) {
      const indented = l.x0 > leftMargin + l.size * 1.2;
      if (indented || SENTENCE_END.test(para)) {
        flush();
        para = text;
      } else {
        // 行尾连字符：接词，不留连字符也不留空格
        if (/[A-Za-z]-$/.test(para)) para = `${para.slice(0, -1)}${text}`;
        else if (/[　-鿿]$/.test(para) && /^[　-鿿]/.test(text)) para += text;
        else para += ` ${text}`;
      }
    } else {
      para = text;
    }
  }
  flush();

  return out.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * 对外
 * ------------------------------------------------------------------ */

/**
 * @param {Buffer} buf
 * @param {{pages?: string, includePageMarks?: boolean}} opts
 */
async function pdfToMarkdown(buf, opts = {}) {
  const pdfjs = await loadPdfjs();

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    // Node 环境下这几项能免掉字体和 eval 相关的告警/失败
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;

  const total = doc.numPages;
  const want = parsePageRange(opts.pages, total);

  const parts = [];
  for (const pageNo of want) {
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const frags = toFragments(tc);

    if (!frags.length) {
      parts.push({ pageNo, md: '', empty: true });
      continue;
    }

    const medSize = median(frags.map((f) => f.size)) || 10;
    const lines = groupLines(frags);
    const cols = detectColumns(lines, viewport.width);

    let md;
    if (cols) {
      // 跨栏的行（多半是大标题）放最前，然后左栏、右栏各自成文
      md = [
        linesToMarkdown(cols.spanning, medSize),
        linesToMarkdown(cols.left, medSize),
        linesToMarkdown(cols.right, medSize),
      ]
        .filter((x) => x.trim())
        .join('\n\n');
    } else {
      md = linesToMarkdown(lines, medSize);
    }

    parts.push({ pageNo, md, columns: Boolean(cols) });
  }

  await doc.destroy().catch(() => {});

  const blank = parts.filter((p) => p.empty).length;
  const body = parts
    .filter((p) => p.md && p.md.trim())
    .map((p) => (opts.includePageMarks === false ? p.md : `<!-- 第 ${p.pageNo} 页 -->\n\n${p.md}`))
    .join('\n\n');

  return {
    markdown: body,
    totalPages: total,
    readPages: want.length,
    blankPages: blank,
    multiColumn: parts.some((p) => p.columns),
  };
}

function parsePageRange(spec, total) {
  if (!spec || !String(spec).trim()) {
    // 不指定就全读，但给个上限免得一本书直接把上下文撑爆
    return Array.from({ length: Math.min(total, 80) }, (_, i) => i + 1);
  }
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Math.max(1, Number(m[1]));
    const b = Math.min(total, m[2] ? Number(m[2]) : a);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

module.exports = { pdfToMarkdown };
