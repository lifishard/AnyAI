import React from 'react';
import { desktop } from '../lib/transport';
import type { NativeAiState } from '../lib/native-ai';
import './NativeAiPanel.css';

const EMPTY_STATE: NativeAiState = { connections: [], tasks: [] };

export default function NativeAiPanel({ selected = false, onSelect }: { selected?: boolean; onSelect?: () => void }) {
  const [state, setState] = React.useState<NativeAiState>(EMPTY_STATE);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState<'configure' | 'open' | 'check' | null>(null);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async (showMessage = false) => {
    const api = desktop();
    if (!api?.nativeAiState) return;
    setBusy('check');
    setError('');
    try {
      const next = await api.nativeAiState();
      setState(next);
      setLoaded(true);
      if (showMessage) {
        const connection = next.connections.find((item) => item.provider === 'claude-desktop');
        setMessage(connection?.connected ? 'Claude Desktop 已连接。' : connection?.configured ? '配置已写入，等待 Claude Desktop 连接。' : '尚未配置 Claude Desktop 连接。');
      }
    } catch (cause) {
      setLoaded(true);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const connection = state.connections.find((item) => item.provider === 'claude-desktop');
  const status = !loaded ? 'checking' : error ? 'error' : connection?.connected ? 'ready' : connection?.configured ? 'waiting' : 'idle';
  const statusLabel = status === 'checking' ? '正在检测' : status === 'error' ? '检测失败' : status === 'ready' ? '已连接' : status === 'waiting' ? '等待连接' : '未配置';

  const configure = async () => {
    const api = desktop();
    if (!api) return;
    setBusy('configure');
    setError('');
    setMessage('');
    try {
      const result = await api.nativeAiConfigure();
      setState(result.state);
      setLoaded(true);
      setMessage(result.message);
      try {
        await api.nativeAiOpen('claude-desktop');
      } catch {
        setMessage(`${result.message} 请手动打开 Claude Desktop。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const openClaude = async () => {
    const api = desktop();
    if (!api) return;
    setBusy('open');
    setError('');
    setMessage('');
    try {
      await api.nativeAiOpen('claude-desktop');
      setMessage('已打开 Claude Desktop。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '未能打开 Claude Desktop，请确认已经安装。');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`native-ai-connection${selected ? ' selected' : ''}`} aria-label="Claude Desktop 连接">
      <div className="client-heading">
        <div>
          <strong>Claude Desktop</strong>
          <p>连接官方桌面应用，让灯芯AI在对话中按需调用。账号登录和工具授权仍在 Claude Desktop 完成。</p>
        </div>
        <span className={`connection-state ${status}`} role="status">
          <span aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

      {connection?.connected && connection.client ? <p className="connection-detail">当前客户端：{connection.client}</p> : null}
      {status === 'waiting' ? <p className="connection-detail">首次配置后请完全退出并重新打开 Claude Desktop。</p> : null}
      {connection?.configured ? <p className="connection-detail">模型在 Claude Desktop 中选择；从对话发送后，还需要在官方应用中点一次发送。</p> : null}

      <div className="client-actions">
        {loaded && !error && connection?.configured && onSelect ? (
          <button className="btn sm" disabled={selected} onClick={onSelect}>{selected ? '正在对话中使用' : '在对话中使用'}</button>
        ) : null}
        {loaded && !error && connection?.configured ? (
          <button className="btn sm ghost" disabled={busy !== null} onClick={() => void openClaude()}>
            {busy === 'open' ? '正在打开…' : '打开 Claude Desktop'}
          </button>
        ) : loaded && !error ? (
          <button className="btn sm" disabled={busy !== null} onClick={() => void configure()}>
            {busy === 'configure' ? '正在配置…' : '一键配置并打开'}
          </button>
        ) : null}
        {loaded && !error && connection?.configured && !connection.connected ? (
          <button className="btn sm ghost" disabled={busy !== null} onClick={() => void configure()}>
            {busy === 'configure' ? '正在修复…' : '修复连接'}
          </button>
        ) : null}
        <button className="btn sm ghost" disabled={busy !== null} onClick={() => void refresh(true)}>
          {busy === 'check' ? '检测中…' : '重新检测'}
        </button>
      </div>

      <p className="quota-note">额度：Claude Desktop 未提供可读取的剩余额度。</p>
      {message ? <p className="connection-message" role="status" aria-live="polite">{message}</p> : null}
      {error ? <p className="connection-error" role="alert">{error}</p> : null}
    </div>
  );
}
