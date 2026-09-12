import React from 'react';
import type { Artifact } from '../types';
import { previewable, toPreviewHtml } from '../lib/artifacts';
import { desktop } from '../lib/transport';
import Markdown from './Markdown';

const ICON: Record<string, string> = {
  html: '🌐',
  svg: '🖼',
  markdown: '📝',
  pdf: '📕',
  docx: '📘',
  xlsx: '📗',
  csv: '📊',
  json: '🧾',
  mermaid: '📐',
  text: '📄',
  code: '📄',
  other: '📄',
};

/** 答案底部那一行产物卡片 */
export function ArtifactStrip(props: {
  artifacts: Artifact[];
  onOpen: (a: Artifact) => void;
}) {
  if (!props.artifacts.length) return null;
  return (
    <div className="artifact-strip">
      <div className="sources-label">产物 · {props.artifacts.length}</div>
      <div className="sources-scroll">
        {props.artifacts.map((a) => (
          <button key={a.id} className="artifact-card" onClick={() => props.onOpen(a)}>
            <div className="artifact-head">
              <span className="artifact-icon">{ICON[a.type] ?? '📄'}</span>
              <span className="artifact-type">{a.type}</span>
            </div>
            <div className="artifact-name" title={a.path ?? a.name}>
              {a.name}
            </div>
            <div className="artifact-hint">{a.kind === 'file' ? '已写入磁盘' : '在答案里'}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 右侧预览面板
 * ------------------------------------------------------------------ */

export default function ArtifactPanel(props: { artifact: Artifact; onClose: () => void }) {
  const a = props.artifact;
  const bridge = desktop();
  const [text, setText] = React.useState<string | null>(a.text ?? null);
  const [err, setErr] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'preview' | 'source'>(
    previewable(a.type) && a.type !== 'code' ? 'preview' : 'source',
  );
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setText(a.text ?? null);
    setErr(null);
    setMode(previewable(a.type) && a.type !== 'code' ? 'preview' : 'source');

    if (a.kind !== 'file' || !a.path) return;
    if (!bridge) {
      setErr('这台设备读不了本地文件');
      return;
    }
    if (!previewable(a.type)) return; // pdf/docx/xlsx 不在应用里预览，交给系统程序

    void bridge.readArtifact(a.path).then((r) => {
      if (r.ok) setText(r.text ?? '');
      else setErr(r.error ?? '读不出来');
    });
  }, [a.id, a.kind, a.path, a.type, a.text, bridge]);

  const srcDoc = React.useMemo(() => {
    if (a.type === 'html') return a.kind === 'file' ? (text ?? '') : toPreviewHtml(a);
    if (a.type === 'svg') return toPreviewHtml({ ...a, text: a.text ?? text ?? '' });
    return '';
  }, [a, text]);

  const canPreviewHere = previewable(a.type);
  const binaryLike = ['pdf', 'docx', 'xlsx', 'other'].includes(a.type);

  return (
    <aside className="artifact-panel">
      <div className="artifact-panel-head">
        <span className="artifact-icon">{ICON[a.type] ?? '📄'}</span>
        <span className="artifact-panel-name" title={a.path ?? a.name}>
          {a.name}
        </span>
        {canPreviewHere && (a.type === 'html' || a.type === 'svg' || a.type === 'markdown') ? (
          <div className="seg">
            <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
              预览
            </button>
            <button className={mode === 'source' ? 'on' : ''} onClick={() => setMode('source')}>
              源码
            </button>
          </div>
        ) : null}
        <button className="icon-btn" onClick={props.onClose} title="关掉">
          ✕
        </button>
      </div>

      <div className="artifact-panel-body">
        {err ? <div className="picker-error">{err}</div> : null}

        {binaryLike ? (
          <div className="empty" style={{ lineHeight: 1.9 }}>
            {a.type} 不在应用里预览。
            <br />
            用下面的「用默认程序打开」，系统会拿 Word / Excel / PDF 阅读器开。
          </div>
        ) : mode === 'preview' && (a.type === 'html' || a.type === 'svg') ? (
          // sandbox 不给 allow-same-origin：产物是模型生成的，不该能碰应用自身
          <iframe className="artifact-frame" sandbox="allow-scripts allow-forms" srcDoc={srcDoc} title={a.name} />
        ) : mode === 'preview' && a.type === 'markdown' ? (
          <div className="artifact-md">
            <Markdown text={text ?? ''} />
          </div>
        ) : text !== null ? (
          <pre className="artifact-source">{text}</pre>
        ) : (
          <div className="empty">读取中…</div>
        )}
      </div>

      <div className="artifact-panel-foot">
        {a.path ? (
          <>
            <code className="artifact-path" title={a.path}>
              {a.path}
            </code>
            <button
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(a.path!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? '已复制' : '复制路径'}
            </button>
            {bridge ? (
              <>
                <button className="btn sm" onClick={() => void bridge.revealPath(a.path!)}>
                  在文件夹中显示
                </button>
                <button className="btn sm primary" onClick={() => void bridge.openPath(a.path!)}>
                  用默认程序打开
                </button>
              </>
            ) : null}
          </>
        ) : (
          <>
            <span className="hint" style={{ flex: 1 }}>
              这个产物只在答案里，没落盘。想留下来就让模型用 write_file 写出去。
            </span>
            <button
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(a.text ?? '');
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? '已复制' : '复制内容'}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
