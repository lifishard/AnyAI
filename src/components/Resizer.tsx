import React from 'react';

/**
 * 两栏之间的拖拽把手。
 *
 * 用 pointer 事件而不是 mouse：触控板和触摸屏也能拖，且 setPointerCapture
 * 能保证鼠标拖出窗口再放开也不会丢事件（mousemove 在这种情况下会断）。
 */
export default function Resizer(props: {
  /** 往右拖变宽还是变窄 */
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onWidth: (w: number) => void;
  onDoubleClick?: () => void;
}) {
  const startRef = React.useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  return (
    <div
      className={`resizer${dragging ? ' dragging' : ''}`}
      onDoubleClick={props.onDoubleClick}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        startRef.current = { x: e.clientX, w: props.width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const st = startRef.current;
        if (!st) return;
        const delta = props.side === 'left' ? e.clientX - st.x : st.x - e.clientX;
        const next = Math.min(props.max, Math.max(props.min, st.w + delta));
        props.onWidth(next);
      }}
      onPointerUp={(e) => {
        startRef.current = null;
        setDragging(false);
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* 已经放开了就算了 */
        }
      }}
      title="拖动调宽度，双击恢复默认"
    />
  );
}
