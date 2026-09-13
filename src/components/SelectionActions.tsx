import React from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessage, MessageAnnotation, MessageQuote } from '../types';
import { Modal } from './ui';

interface SelectionState { quote: MessageQuote; x: number; y: number; above: boolean }

/** One listener for the conversation, anchored to the visible selection, outside scroll clipping. */
export default function SelectionActions(props: {
  messages: ChatMessage[];
  onReply: (quote: MessageQuote) => void;
  onAnnotate: (note: MessageAnnotation) => Promise<void>;
}) {
  const [selected, setSelected] = React.useState<SelectionState | null>(null);
  const [draft, setDraft] = React.useState<MessageQuote | null>(null);
  const [text, setText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const messages = React.useRef(props.messages);
  messages.current = props.messages;
  React.useEffect(() => {
    if (draft) return;
    let frame = 0, dragging = false;
    const capture = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (dragging) return;
        const s = window.getSelection();
        const value = s?.toString().trim();
        const element = (n: Node | null) => n instanceof Element ? n : n?.parentElement;
        const from = element(s?.anchorNode ?? null)?.closest('[data-message-id]');
        const to = element(s?.focusNode ?? null)?.closest('[data-message-id]');
        const id = from?.getAttribute('data-message-id');
        const m = messages.current.find((m) => m.id === id);
        if (!s || !value || !s.rangeCount || !m || from !== to || value.length > 16000) { setSelected(null); return; }
        const range = s.getRangeAt(0);
        const rects = [...range.getClientRects()].filter((r) => r.height > 0 && r.bottom > 0 && r.top < innerHeight);
        if (!rects.length) { setSelected(null); return; }
        const focus = document.createRange();
        focus.setStart(s.focusNode!, s.focusOffset); focus.collapse(true);
        const caret = focus.getBoundingClientRect();
        const rect = caret.height && caret.top >= 0 && caret.bottom <= innerHeight ? caret : rects.at(-1)!;
        const above = rect.top >= 58;
        setSelected({ quote: { id: crypto.randomUUID(), messageId: m.id, role: m.role, text: value },
          x: Math.max(100, Math.min(innerWidth - 100, rect.left + rect.width / 2)),
          y: above ? rect.top - 8 : rect.bottom + 8, above });
      });
    };
    const down = (e: PointerEvent) => {
      if ((e.target as Element)?.closest('.selection-actions')) return;
      dragging = true; setSelected(null);
    };
    const up = () => { dragging = false; capture(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { window.getSelection()?.removeAllRanges(); setSelected(null); } };
    document.addEventListener('selectionchange', capture);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('keyup', capture);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', capture, true);
    window.addEventListener('resize', capture);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', capture);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('keyup', capture);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', capture, true);
      window.removeEventListener('resize', capture);
    };
  }, [draft]);

  const clear = () => { setSelected(null); window.getSelection()?.removeAllRanges(); };
  return <>
    {selected ? createPortal(<div className="selection-actions" role="toolbar" aria-label="选中文字的操作"
      style={{ left: selected.x, top: selected.y, transform: `translate(-50%, ${selected.above ? '-100%' : '0'})` }}
      onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" title="引用所选文字回复" onClick={() => { props.onReply(selected.quote); clear(); }}>↩ 回复</button>
      <button type="button" title="为所选文字添加个人注释" onClick={() => { setDraft(selected.quote); setText(''); setError(''); clear(); }}>✎ 注释</button>
    </div>, document.body) : null}
    {draft ? <Modal title="添加注释" onClose={() => { if (!saving) setDraft(null); }}>
      <div className="modal-body annotation-editor">
        <blockquote>{draft.text}</blockquote>
        <label>你的注释<textarea autoFocus aria-label="你的注释" rows={4} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <div className="hint">保存在这条消息旁，不会自动发送给模型。</div>
        {error ? <div role="alert" className="file-card-error">{error}</div> : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" disabled={saving} onClick={() => setDraft(null)}>取消</button>
          <button className="btn primary" disabled={saving || !text.trim()} onClick={() => {
            setSaving(true); setError('');
            void props.onAnnotate({ id: draft.id, quote: draft, text: text.trim(), createdAt: Date.now() })
              .then(() => setDraft(null)).catch((e) => setError(String(e))).finally(() => setSaving(false));
          }}>{saving ? '保存中…' : '保存注释'}</button>
        </div>
      </div>
    </Modal> : null}
  </>;
}
