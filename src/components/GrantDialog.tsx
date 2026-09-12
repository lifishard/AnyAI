import React from 'react';
import type { AccessRequest } from '../types';

/* ------------------------------------------------------------------ *
 * 权限申请弹窗
 *
 * 跟工具确认框（ToolConfirm）刻意做得不一样：
 *
 *   - **没有 Enter 快捷键**。工具确认那种一秒一个的节奏，回车批准是合理的；
 *     但这里批准的是一整类能力，不该能在连点里被顺手放过去。同意必须动鼠标。
 *   - Esc / ← 是拒绝，跟别处一致。
 *   - 授权只在本次会话有效，弹窗上写明，不提供「记住我的选择」。
 *
 * 这个摩擦是功能，不是疏漏。
 * ------------------------------------------------------------------ */

const SCOPE_INFO: Record<
  AccessRequest['scope'],
  { title: string; what: string; risk: string; icon: string }
> = {
  path: {
    icon: '📂',
    title: '访问一个新目录',
    what: '把这个目录加进可读写范围，文件类工具和命令行的 cwd 都能用它。',
    risk: '这个目录里的所有内容都会对模型可见，包括你没想到的子目录。',
  },
  admin: {
    icon: '🛡',
    title: '以管理员身份执行命令',
    what: '允许 run_command 提权。每条提权命令仍然会单独问你，系统还会再弹一次 UAC。',
    risk: '管理员权限能改系统、装驱动、关安全软件。给之前先看清楚它到底要跑什么。',
  },
  screen: {
    icon: '🖥',
    title: '截屏并控制鼠标键盘',
    what: '允许截取屏幕、移动和点击鼠标、模拟键盘输入。',
    risk:
      '截屏会把当时屏幕上的一切发给模型背后的服务商 —— 包括另一个窗口里的密码管理器、' +
      '私信、银行页面。鼠标键盘则意味着它能点任何按钮。',
  },
};

export default function GrantDialog(props: {
  req: AccessRequest;
  onDecide: (granted: boolean) => void;
}) {
  const info = SCOPE_INFO[props.req.scope] ?? SCOPE_INFO.path;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        e.preventDefault();
        props.onDecide(false);
      }
      // 故意不接 Enter：同意必须点
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="modal-mask">
      <div className="modal grant-dialog">
        <div className="grant-head">
          <span className="grant-icon">{info.icon}</span>
          <div>
            <div className="grant-title">模型申请权限：{info.title}</div>
            <div className="hint">这次会话内有效，关掉应用就失效，不会被记住</div>
          </div>
        </div>

        {props.req.scope === 'path' && props.req.target ? (
          <div className="grant-target">
            <code>{props.req.target}</code>
          </div>
        ) : null}

        <div className="grant-block">
          <div className="grant-label">它要拿这个做什么</div>
          <div className="grant-reason">{props.req.reason || '（模型没有给出理由 —— 这本身就值得拒绝）'}</div>
        </div>

        <div className="grant-block">
          <div className="grant-label">同意之后它能做什么</div>
          <div>{info.what}</div>
        </div>

        <div className="grant-block warn">
          <div className="grant-label">风险</div>
          <div>{info.risk}</div>
        </div>

        <div className="grant-foot">
          <span className="hint">拒绝不会中断对话，模型会换个办法继续</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => props.onDecide(false)}>
            拒绝（Esc）
          </button>
          <button className="btn primary" onClick={() => props.onDecide(true)}>
            同意，本次会话
          </button>
        </div>
      </div>
    </div>
  );
}
