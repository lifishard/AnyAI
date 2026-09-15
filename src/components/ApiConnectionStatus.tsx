import React from 'react';
import type { KeyProfile } from '../types';
import GatewayRecovery from './GatewayRecovery';
import './ApiConnectionStatus.css';

type ConnectionState = 'idle' | 'checking' | 'ready' | 'offline';
const recentChecks = new Map<string, { state: 'ready' | 'offline'; at: number }>();

export default function ApiConnectionStatus({ profile, cachedCount, loading, error, onCheck }: {
  profile?: KeyProfile | null;
  cachedCount: number;
  loading: boolean;
  error: string | null;
  onCheck: () => void;
}) {
  const profileKey = profile ? `${profile.id}:${profile.baseUrl}` : '';
  const recent = profileKey ? recentChecks.get(profileKey) : undefined;
  const [state, setState] = React.useState<ConnectionState>(() => recent && Date.now() - recent.at < 30_000 ? recent.state : 'idle');
  const requested = React.useRef(false);
  const sawLoading = React.useRef(false);
  const latest = React.useRef({ loading, error, onCheck });
  latest.current = { loading, error, onCheck };

  const check = React.useCallback(() => {
    if (!profileKey) return;
    requested.current = true;
    sawLoading.current = latest.current.loading;
    setState('checking');
    if (!latest.current.loading) latest.current.onCheck();
    window.setTimeout(() => {
      if (!requested.current || sawLoading.current || latest.current.loading) return;
      requested.current = false;
      setState(latest.current.error ? 'offline' : 'idle');
    }, 500);
  }, [profileKey]);

  React.useEffect(() => {
    requested.current = false;
    sawLoading.current = false;
    const prior = profileKey ? recentChecks.get(profileKey) : undefined;
    if (prior && Date.now() - prior.at < 30_000) {
      setState(prior.state);
      return;
    }
    setState('idle');
    if (profileKey) window.setTimeout(check, 0);
  }, [profileKey, check]);

  React.useEffect(() => {
    if (profile && loading) {
      requested.current = true;
      sawLoading.current = true;
      setState('checking');
      return;
    }
    if (!requested.current) return;
    if (!sawLoading.current) return;
    requested.current = false;
    const next = error ? 'offline' : 'ready';
    setState(next);
    if (profileKey) recentChecks.set(profileKey, { state: next, at: Date.now() });
  }, [profile, profileKey, loading, error]);

  const label = !profile ? '未选择凭据' : state === 'checking' ? '正在检测' : state === 'ready' ? '已连接' : state === 'offline' ? '连接失败' : '尚未确认';
  const detail = cachedCount > 0 ? `当前列表有 ${cachedCount} 个模型；列表缓存不代表服务在线。` : '当前模型列表为空。';

  return (
    <div className="api-connection-status">
      <div className="api-connection-main">
        <span className={`connection-state ${state === 'offline' ? 'error' : state}`} role="status" aria-live="polite">
          <span aria-hidden="true" />
          {label}
        </span>
        <button className="btn sm ghost" disabled={!profile || state === 'checking'} onClick={check}>
          {state === 'checking' ? '检测中…' : state === 'ready' ? '重新检测' : '检测连接'}
        </button>
      </div>
      <p>{detail}</p>
      {state === 'offline' ? (
        <GatewayRecovery profile={profile} compact onReady={() => {
          requested.current = false;
          setState('ready');
          if (profileKey) recentChecks.set(profileKey, { state: 'ready', at: Date.now() });
          latest.current.onCheck();
        }} />
      ) : null}
    </div>
  );
}
