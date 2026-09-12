import React from 'react';
import type { ToolStep } from '../types';
import { TOOL_BY_NAME } from '../lib/tools/registry';
import { Modal } from './ui';

/**
 * 危险工具的确认弹窗。
 * 键盘：Enter 批准，← 或 Esc 拒绝 —— 这类弹窗会连着弹好几次，
 * 每次都去够鼠标很烦。
 */
export default function ToolConfirm(props: {
  step: ToolStep;
  onResolve: (ok: boolean) => void;
}) {
  const def = TOOL_BY_NAME[props.step.name];

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        props.onResolve(true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        props.onResolve(false);
      }
      // Esc 由 Modal 自己处理，走 onClose → 拒绝
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <Modal
      title="这一步要动真格的"
      onClose={() => props.onResolve(false)}
      footer={
        <>
          <button className="btn" onClick={() => props.onResolve(false)}>
            拒绝 <kbd>←</kbd>
          </button>
          <button className="btn primary" autoFocus onClick={() => props.onResolve(true)}>
            允许执行 <kbd>Enter</kbd>
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="confirm-tool">
          <div>
            模型要调用 <strong>{def?.label ?? props.step.name}</strong>
            <span className="tool-code"> （{props.step.name}）</span>
          </div>
          <div className="hint">{props.step.summary}</div>
          <div className="field-label">参数</div>
          <pre>{JSON.stringify(props.step.args, null, 2)}</pre>
          <div className="hint">
            拒绝不会中断对话 —— 模型会收到「用户拒绝了」并换个办法继续。
            不想每次都问的话，输入框左下角能把档位调成「自动批准编辑」或「全部放行」。
          </div>
        </div>
      </div>
    </Modal>
  );
}
