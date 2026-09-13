import React from 'react';
import type { Artifact } from '../types';
import { previewable, toPreviewHtml } from '../lib/artifacts';
import { desktop } from '../lib/transport';
import Markdown from './Markdown';

const ICON: Record<string, string> = {
  ics: '🗓',
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

function FileCard({ artifact: a, onOpen, onSaved }: { artifact: Artifact; onOpen: (a: Artifact) => void; onSaved?: (a: Artifact) => void }) {
  const bridge = desktop();
  const [error, setError] = React.useState('');
  const [working, setWorking] = React.useState(false);
  const action = async (fn: () => Promise<void>) => {
    setError(''); setWorking(true);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setWorking(false); }
  };
  const save = async () => {
    if (bridge?.saveArtifact) {
      const file = await bridge.saveArtifact(a.name, a.text, a.path);
      if (file) onSaved?.({ ...a, id: `saved-${file.path}`, kind: 'file', path: file.path, name: file.name,
        size: file.size, verifiedAt: file.verifiedAt, direction: 'output', createdAt: file.verifiedAt });
    } else if (a.text !== undefined) {
      const url = URL.createObjectURL(new Blob([a.text], { type: a.type === 'ics' ? 'text/calendar;charset=utf-8' : 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = a.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else throw new Error('请在保存该文件的桌面端打开');
  };
  return <div className="artifact-card file-card">
    <button className="file-card-preview" onClick={() => onOpen(a)}>
      <span className="artifact-icon">{ICON[a.type] ?? '📄'}</span>
      <span className="file-card-description"><strong title={a.path ?? a.name}>{a.name}</strong>
        <small>{a.direction === 'input' ? '输入文件' : '输出文件'} · {a.type.toUpperCase()}{a.size !== undefined ? ` · ${a.size < 1024 ? `${a.size} B` : `${(a.size/1024).toFixed(1)} KB`}` : ''}</small>
      </span>
    </button>
    <div className="file-status">{a.path ? a.verifiedAt ? '已核实文件路径' : '历史文件记录，打开时核实' : '文件内容在对话中，可保存'}</div>
    {a.path ? <div className="file-card-path" title={a.path}>{a.path}</div> : null}
    <div className="file-card-actions">
      {a.path && bridge ? <>
        <button className="btn sm" disabled={working} onClick={() => void action(async () => { const err = await bridge.openPath(a.path!); if (err) throw new Error(err); })}>打开</button>
        <button className="btn sm" disabled={working} onClick={() => void action(() => bridge.revealPath(a.path!))}>在文件夹中显示</button>
      </> : null}
      {(bridge?.saveArtifact || a.text !== undefined) ? <button className="btn sm" disabled={working} onClick={() => void action(save)}>{a.path ? '另存为' : '保存文件'}</button> : null}
    </div>
    {error ? <div className="file-card-error" role="alert">{error}</div> : null}
  </div>;
}

/** Input and output records are visible without opening the side panel. */
export function ArtifactStrip(props: { artifacts: Artifact[]; onOpen: (a: Artifact) => void; onSaved?: (a: Artifact) => void }) {
  if (!props.artifacts.length) return null;
  return <div className="artifact-strip">
    <div className="sources-label">本轮文件与产物 · {props.artifacts.length}</div>
    <div className="file-card-grid">
      {props.artifacts.map((a) => <FileCard key={a.id} artifact={a} onOpen={props.onOpen} onSaved={props.onSaved} />)}
    </div>
  </div>;
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
                <button className="btn sm" onClick={() => void bridge.revealPath(a.path!).catch((e) => setErr(String(e)))}>
                  在文件夹中显示
                </button>
                <button className="btn sm primary" onClick={() => void bridge.openPath(a.path!).then((e) => { if (e) setErr(e); }).catch((e) => setErr(String(e)))}>
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
