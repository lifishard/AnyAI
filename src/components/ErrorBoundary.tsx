import React from 'react';

/**
 * 错误边界。
 *
 * 没有它的时候，渲染期抛一个异常 React 会把整棵树卸载掉 —— 界面看着还在
 * （最后一帧的 DOM 还留在那），但所有事件监听都没了，表现就是「突然点不动」，
 * 而且控制台不开就完全不知道发生了什么。
 *
 * 有了它，至少能把错误和栈摆到脸上，还能只重置出问题的那一块而不用重启应用。
 */
interface State {
  error: Error | null;
  info: string;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string; onReset?: () => void },
  State
> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info: info.componentStack ?? '' });
    console.error('[AnyAI] 渲染出错：', error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-title">
          {this.props.label ? `${this.props.label}崩了` : '这块界面崩了'}
        </div>
        <div className="crash-msg">{error.message || String(error)}</div>
        <details>
          <summary>技术细节（贴给我就能定位）</summary>
          <pre>
            {error.stack ?? ''}
            {info ? `\n--- 组件栈 ---${info}` : ''}
          </pre>
        </details>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            onClick={() => {
              this.setState({ error: null, info: '' });
              this.props.onReset?.();
            }}
          >
            重试
          </button>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(
                `${error.message}\n\n${error.stack ?? ''}\n\n${info}`,
              );
            }}
          >
            复制错误
          </button>
        </div>
      </div>
    );
  }
}
