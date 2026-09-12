'use strict';
/**
 * 二进制文档的读写：pdf / docx / xlsx。
 *
 * 内置的 read_file / write_file 只认 UTF-8 文本，碰到这几种会干净地报错。
 * 这里补上真正的解析和生成。
 *
 * 几个依赖都是**懒加载 + try/catch**：装漏了或者版本对不上，只让这一个工具
 * 返回一句能看懂的错误，而不是在 require 阶段把整个工具分发器带崩。
 */
const fs = require('node:fs');
const path = require('node:path');
const { ok, fail, guardPath, clip } = require('./common.cjs');
const { htmlToMarkdown } = require('./web.cjs');

function need(name, hint) {
  try {
    return require(name);
  } catch (e) {
    throw new Error(
      `缺少依赖 ${name}（${hint}）。在项目目录跑一次 npm install 就好。原始错误：${e.message}`,
    );
  }
}

/* ================================================================== *
 * 读
 * ================================================================== */

async function readPdf(p, args) {
  const { pdfToMarkdown } = require('./pdf-layout.cjs');
  const buf = fs.readFileSync(p);
  const r = await pdfToMarkdown(buf, {
    pages: args.pages,
    includePageMarks: args.page_marks !== false,
  });

  if (!r.markdown.trim()) {
    return fail(
      `${path.basename(p)} 里抽不到任何文本（共 ${r.totalPages} 页）。` +
        '多半是扫描件 —— 页面是图片，没有文字层。要处理得先 OCR，' +
        '例如用 run_command 跑 ocrmypdf。',
    );
  }

  const notes = [`共 ${r.totalPages} 页，读了 ${r.readPages} 页`];
  if (r.multiColumn) notes.push('检测到多栏版面，已按栏拆开重排');
  if (r.blankPages) notes.push(`${r.blankPages} 页没有文字层（可能是图）`);

  return ok(`# ${path.basename(p)}\n\n> ${notes.join('；')}\n\n${r.markdown}`, {
    summary: `读 PDF ${path.basename(p)}（${r.readPages}/${r.totalPages} 页）`,
    sources: [{ title: path.basename(p), path: p }],
  });
}

async function readDocx(p) {
  const mammoth = need('mammoth', 'docx 解析');
  const r = await mammoth.convertToHtml({ path: p });
  const { markdown } = htmlToMarkdown(r.value || '', `file://${p}`);
  if (!markdown.trim()) return fail(`${path.basename(p)} 里没有正文。`);

  const warn = (r.messages || [])
    .filter((m) => m.type === 'warning')
    .slice(0, 5)
    .map((m) => m.message);

  return ok(
    `# ${path.basename(p)}\n\n${markdown}` +
      (warn.length ? `\n\n> 解析时的提示：${warn.join('；')}` : ''),
    {
      summary: `读 Word ${path.basename(p)}`,
      sources: [{ title: path.basename(p), path: p }],
    },
  );
}

function readSheet(p, args) {
  const XLSX = need('xlsx', '表格读写');
  const wb = XLSX.readFile(p, { cellDates: true });
  const names = wb.SheetNames;
  if (!names.length) return fail('这个工作簿里没有任何工作表。');

  const wanted = args.sheet
    ? names.filter((n) => n.toLowerCase() === String(args.sheet).toLowerCase())
    : names;
  if (!wanted.length) {
    return fail(`没有叫「${args.sheet}」的工作表。现有的：${names.join('、')}`);
  }

  const maxRows = Math.min(5000, Math.max(1, Number(args.max_rows) || 500));
  const parts = [];

  for (const name of wanted) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) {
      parts.push(`## ${name}\n\n（空表）`);
      continue;
    }

    const shown = rows.slice(0, maxRows);
    const cols = Math.max(...shown.map((r) => r.length));
    const cell = (v) => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    };
    const pad = (r) => {
      const a = [...r.map(cell)];
      while (a.length < cols) a.push('');
      return a;
    };

    const head = pad(shown[0]);
    const body = shown.slice(1).map(pad);
    const table = [
      `| ${head.join(' | ')} |`,
      `| ${new Array(cols).fill('---').join(' | ')} |`,
      ...body.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');

    parts.push(
      `## ${name}\n\n${table}` +
        (rows.length > shown.length ? `\n\n> 还有 ${rows.length - shown.length} 行没显示` : ''),
    );
  }

  return ok(`# ${path.basename(p)}\n\n工作表：${names.join('、')}\n\n${parts.join('\n\n')}`, {
    summary: `读表格 ${path.basename(p)}（${wanted.length} 张表）`,
    sources: [{ title: path.basename(p), path: p }],
  });
}

async function readDocument(args, ctx) {
  try {
    const p = guardPath(args.path, ctx.workspaceRoots, { mustExist: true });
    const ext = path.extname(p).toLowerCase();
    const maxChars = Math.min(200000, Math.max(1000, Number(args.max_chars) || 40000));

    let res;
    if (ext === '.pdf') res = await readPdf(p, args);
    else if (ext === '.docx') res = await readDocx(p);
    else if (['.xlsx', '.xlsm', '.xls', '.csv', '.tsv'].includes(ext)) res = readSheet(p, args);
    else if (ext === '.pptx') {
      return fail('暂时不支持 pptx。可以用 run_command 调 libreoffice 先转成 pdf 或 docx。');
    } else {
      return fail(
        `read_document 处理的是 pdf / docx / xlsx / csv。${ext || '这个'} 是文本格式，直接用 read_file。`,
      );
    }

    if (res.ok) res.content = clip(res.content, maxChars);
    return res;
  } catch (e) {
    return fail(e);
  }
}

/* ================================================================== *
 * 写
 * ================================================================== */

/** markdown → 极简 HTML，给 docx / pdf 生成用。只认标题、列表、表格、粗体、代码 */
function mdToHtml(md, title) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = String(md).split('\n');
  const out = [];
  let inCode = false;
  let listType = null;
  let tableBuf = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf
      .filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
      .map((l) => l.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()));
    if (rows.length) {
      out.push('<table><thead><tr>');
      for (const c of rows[0]) out.push(`<th>${inline(c)}</th>`);
      out.push('</tr></thead><tbody>');
      for (const r of rows.slice(1)) {
        out.push('<tr>');
        for (const c of r) out.push(`<td>${inline(c)}</td>`);
        out.push('</tr>');
      }
      out.push('</tbody></table>');
    }
    tableBuf = [];
  };
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    if (/^```/.test(line)) {
      flushTable();
      closeList();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${esc(line)}\n`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      tableBuf.push(line);
      continue;
    }
    flushTable();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr/>');
      continue;
    }
    if (!line.trim()) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  flushTable();
  closeList();
  if (inCode) out.push('</code></pre>');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;
       font-size:12pt;color:#111;max-width:800px;margin:0 auto;padding:32px}
  h1{font-size:22pt}h2{font-size:17pt}h3{font-size:14pt}
  code{font-family:Consolas,monospace;background:#f2f2f2;padding:1px 4px;border-radius:3px}
  pre{background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:10px;overflow:auto}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;margin:12px 0}
  th,td{border:1px solid #ccc;padding:6px 9px;text-align:left;font-size:11pt}
  th{background:#f2f2f2}
  a{color:#2c5fd6}
</style></head><body>${out.join('\n')}</body></html>`;
}

/** markdown → docx。同样只认标题、列表、表格、粗体 */
function mdToDocx(md, title) {
  const D = need('docx', 'Word 生成');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = D;

  const HEADINGS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];

  const runs = (s) => {
    // 只处理 **粗体**，其余按纯文本
    const parts = String(s).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return parts.map((p) =>
      /^\*\*[^*]+\*\*$/.test(p)
        ? new TextRun({ text: p.slice(2, -2), bold: true })
        : new TextRun(p),
    );
  };

  const children = [];
  const lines = String(md).split('\n');
  let tableBuf = [];

  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf
      .filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
      .map((l) => l.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()));
    if (rows.length) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map(
            (r) =>
              new TableRow({
                children: r.map(
                  (c) => new TableCell({ children: [new Paragraph({ children: runs(c) })] }),
                ),
              }),
          ),
        }),
      );
    }
    tableBuf = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableBuf.push(line);
      continue;
    }
    flushTable();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      children.push(new Paragraph({ heading: HEADINGS[h[1].length - 1], children: runs(h[2]) }));
      continue;
    }
    const li = line.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: runs(li[1]) }));
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: runs(ol[1]) }));
      continue;
    }
    if (!line.trim()) {
      children.push(new Paragraph(''));
      continue;
    }
    children.push(new Paragraph({ children: runs(line) }));
  }
  flushTable();

  const doc = new Document({
    title,
    sections: [{ children: children.length ? children : [new Paragraph('')] }],
  });
  return Packer.toBuffer(doc);
}

/** markdown 表格 / JSON 二维数组 → xlsx */
function toXlsx(args, p) {
  const XLSX = need('xlsx', '表格读写');
  let rows = null;

  if (Array.isArray(args.rows)) {
    rows = args.rows.map((r) => (Array.isArray(r) ? r : [r]));
  } else if (typeof args.content === 'string' && /\|/.test(args.content)) {
    rows = args.content
      .split('\n')
      .filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
      .map((l) => l.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()));
  }
  if (!rows || !rows.length) {
    throw new Error('生成 xlsx 需要 rows（二维数组），或者 content 里有一张 Markdown 表格。');
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 按内容粗略定个列宽，不然全挤在一起
  ws['!cols'] = (rows[0] || []).map((_, i) => ({
    wch: Math.min(60, Math.max(8, ...rows.map((r) => String(r[i] ?? '').length + 2))),
  }));
  XLSX.utils.book_append_sheet(wb, ws, String(args.sheet || 'Sheet1').slice(0, 31));
  XLSX.writeFile(wb, p);
  return rows.length;
}

async function writeDocument(args, ctx) {
  try {
    const p = guardPath(args.path, ctx.workspaceRoots);
    const ext = path.extname(p).toLowerCase();
    const content = String(args.content ?? '');
    const title = String(args.title || path.basename(p, ext));
    fs.mkdirSync(path.dirname(p), { recursive: true });

    if (ext === '.docx') {
      const buf = await mdToDocx(content, title);
      fs.writeFileSync(p, buf);
    } else if (['.xlsx', '.xlsm'].includes(ext)) {
      const n = toXlsx(args, p);
      return ok(`已生成 ${p}（${n} 行）。`, { summary: `生成 ${path.basename(p)}`, filePath: p });
    } else if (ext === '.pdf') {
      const { htmlToPdf } = require('../pdf-print.cjs');
      await htmlToPdf(mdToHtml(content, title), p);
    } else if (ext === '.html' || ext === '.htm') {
      fs.writeFileSync(p, mdToHtml(content, title), 'utf8');
    } else {
      return fail(
        `write_document 负责的是 docx / pdf / xlsx / html。${ext || '这个'} 是文本格式，直接用 write_file。`,
      );
    }

    const size = fs.statSync(p).size;
    return ok(`已生成 ${p}（${(size / 1024).toFixed(0)} KB）。`, {
      summary: `生成 ${path.basename(p)}`,
      filePath: p,
    });
  } catch (e) {
    return fail(e);
  }
}

module.exports = { readDocument, writeDocument, mdToHtml };
