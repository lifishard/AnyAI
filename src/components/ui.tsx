import React from 'react';

/* 一批最小化的通用控件，避免每个面板各写一遍 */

export function Field(props: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label">{props.label}</div>
      {props.children}
      {props.hint ? <div className="hint">{props.hint}</div> : null}
    </div>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === props.value ? 'on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal(props: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={props.wide ? { maxWidth: 860 } : undefined}>
        <div className="modal-head">
          <span>{props.title}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={props.onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        {props.children}
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}

export function Toast(props: { message: string | null }) {
  if (!props.message) return null;
  return <div className="toast">{props.message}</div>;
}

/** 简易 toast hook：setToast('已复制') 两秒后自动消失 */
export function useToast() {
  const [message, setMessage] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = React.useCallback((m: string, ms = 2200) => {
    setMessage(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), ms);
  }, []);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { message, show };
}
