import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('找不到 #root 挂载点');

createRoot(el).render(
  <React.StrictMode>
    {/* 兜底：任何地方渲染抛异常，至少把错误摆出来，而不是留一个点不动的死界面 */}
    <ErrorBoundary label="应用">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
