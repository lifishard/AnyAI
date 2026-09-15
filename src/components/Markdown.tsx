import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import type { SourceRef } from '../types';

/**
 * Markdown 渲染。
 * 流程固定为：插引用角标 → marked 转 HTML → DOMPurify 消毒 → 注入。
 * 模型的输出是不可信内容，任何时候都不要跳过消毒那一步。
 */

marked.setOptions({ gfm: true, breaks: true });

/**
 * 把正文里的 [1]、[2][3] 换成可点的角标。
 * 代码块里的方括号不能动 —— 按 ``` 切开，只处理偶数段（非代码段）。
 */
function injectCitations(md: string, sources: SourceRef[]): string {
  if (!sources.length) return md;
  const valid = new Set(sources.map((s) => s.n));

  return md
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // 代码块原样留着
      return seg.replace(/\[(\d{1,3})\]/g, (whole, num) => {
        const n = Number(num);
        if (!valid.has(n)) return whole; // 模型瞎编的编号，不给链接
        return `<sup class="cite" data-n="${n}">${n}</sup>`;
      });
    })
    .join('');
}

function render(md: string, sources: SourceRef[]): string {
  const html = marked.parse(injectCitations(md, sources), { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel', 'data-n'],
    ADD_TAGS: ['sup'],
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'onerror', 'onload'],
  });
}

const EMPTY_SOURCES: SourceRef[] = [];
export default function Markdown(props: {
  text: string;
  sources?: SourceRef[];
  onCiteClick?: (n: number) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const sources = props.sources ?? EMPTY_SOURCES;
  const html = React.useMemo(() => render(props.text, sources), [props.text, sources]);

  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;

    root.querySelectorAll('pre code').forEach((block) => {
      const el = block as HTMLElement;
      if (el.dataset.highlighted === 'yes') return;
      try {
        hljs.highlightElement(el);
      } catch {
        /* 语言不认识就保持纯文本 */
      }
      el.dataset.highlighted = 'yes';
    });

    root.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noreferrer noopener');
    });

    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy-code')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-code';
      btn.textContent = '复制';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code')?.textContent ?? '';
        void navigator.clipboard.writeText(code).then(
          () => {
            btn.textContent = '已复制';
            setTimeout(() => (btn.textContent = '复制'), 1400);
          },
          () => {
            btn.textContent = '复制失败';
            setTimeout(() => (btn.textContent = '复制'), 1400);
          },
        );
      });
      pre.appendChild(btn);
    });
  }, [html]);

  // 角标点击：有外链就开浏览器，否则交给上层滚动到来源卡片
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.classList?.contains('cite')) return;
      const n = Number(t.dataset.n);
      const src = sources.find((s) => s.n === n);
      if (src?.url) {
        window.open(src.url, '_blank', 'noreferrer');
      } else {
        props.onCiteClick?.(n);
      }
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [html, sources, props]);

  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
