import type { Artifact, ToolStep } from '../types';
import { uid } from './store';

/* ------------------------------------------------------------------ *
 * 产物收集
 *
 * 一轮回答结束后，值得单独拎出来给人看的东西有两类：
 *   1. 工具真的写到磁盘上的文件（write_file / write_document / project_doc_write）
 *   2. 答案正文里那种「本身就是成品」的代码块 —— 完整的 HTML 页面、SVG、
 *      Mermaid 图。这些不落盘，但用户多半想直接看效果而不是读源码。
 *
 * 普通的代码片段（一段 Python 函数、一条命令）不算产物 —— 那是答案的一部分，
 * 混进产物栏只会稀释信号。
 * ------------------------------------------------------------------ */

const TYPE_BY_EXT: Record<string, string> = {
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'svg',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.csv': 'csv',
  '.json': 'json',
  '.txt': 'text',
};

export function typeOfPath(p: string): string {
  const m = p.toLowerCase().match(/(\.[a-z0-9]+)$/);
  if (!m) return 'other';
  return TYPE_BY_EXT[m[1]] ?? 'code';
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 这个产物能不能在应用里直接预览 */
export function previewable(type: string): boolean {
  return ['html', 'svg', 'markdown', 'csv', 'json', 'text', 'code', 'mermaid'].includes(type);
}

/** 从工具步骤里挑出写到磁盘的文件 */
function fromSteps(steps: ToolStep[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const s of steps) {
    if (s.status !== 'ok' || !s.filePath) continue;
    if (seen.has(s.filePath)) continue;
    seen.add(s.filePath);
    out.push({
      id: uid('art'),
      kind: 'file',
      name: baseName(s.filePath),
      path: s.filePath,
      type: typeOfPath(s.filePath),
      createdAt: Date.now(),
    });
  }
  return out;
}

/**
 * 从答案正文里挑出「成品级」代码块。
 * 判据刻意收紧：完整 HTML 文档、SVG、mermaid，以及被显式标成 preview 的块。
 * 一段普通函数不该进产物栏。
 */
function fromContent(content: string): Artifact[] {
  const out: Artifact[] = [];
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let n = 0;

  while ((m = re.exec(content)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const body = m[2];
    if (body.length < 80) continue;

    let type: string | null = null;
    if (lang === 'mermaid') type = 'mermaid';
    else if (lang === 'svg' || /^\s*<svg[\s>]/i.test(body)) type = 'svg';
    else if (
      (lang === 'html' || lang === 'htm') &&
      /<html[\s>]|<!doctype html|<body[\s>]/i.test(body)
    ) {
      type = 'html';
    }
    if (!type) continue;

    n += 1;
    out.push({
      id: uid('art'),
      kind: 'inline',
      name: type === 'mermaid' ? `图表 ${n}` : type === 'svg' ? `矢量图 ${n}` : `网页 ${n}`,
      type,
      text: body,
      createdAt: Date.now(),
    });
  }
  return out;
}

export function collectArtifacts(content: string, steps: ToolStep[]): Artifact[] {
  return [...fromSteps(steps), ...fromContent(content)];
}

/** 把内联产物包成一个能直接塞进 iframe 的完整页面 */
export function toPreviewHtml(a: Artifact): string {
  if (a.type === 'html') return a.text ?? '';
  if (a.type === 'svg') {
    return `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}
      svg{max-width:100%;max-height:100%}
    </style>${a.text ?? ''}`;
  }
  return '';
}
