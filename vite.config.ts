import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 开发态的转发中间件。
 *
 * 只在浏览器里调 UI（npm run dev）时用得上 —— 日日新的接口不给浏览器发 CORS 头，
 * 直接 fetch 一定被同源策略挡下。Electron 和 Android 走各自的原生层，不经过这里。
 *
 * 为什么不用 Vite 内置的 server.proxy：内置代理基于 node-http-proxy，target 在配置
 * 时就固定死了，而这里的 base url 是用户在界面上随时能改的。node-http-proxy 没有
 * 按请求动态选 target 的能力（`router` 是 http-proxy-middleware 的选项，不是它的）。
 * 所以自己写一段：客户端把真实 origin 放在 x-sn-base 头里，这里据此转发。
 */
function devApiProxy(): Plugin {
  const HOP_BY_HOP = new Set([
    'host',
    'connection',
    'keep-alive',
    'content-length',
    'transfer-encoding',
    'upgrade',
    'x-sn-base',
  ]);

  return {
    name: 'sn-dev-api-proxy',
    configureServer(server) {
      // connect 的 use(path, fn) 会把前缀从 req.url 里剥掉，
      // 所以这里拿到的是 /v1/chat/completions 这样的剩余路径
      server.middlewares.use('/__sn', (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          const raw = req.headers['x-sn-base'];
          const base = (Array.isArray(raw) ? raw[0] : raw) || 'https://token.sensenova.cn';
          const target = `${base.replace(/\/+$/, '')}${req.url ?? ''}`;

          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);

            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) {
              if (HOP_BY_HOP.has(k.toLowerCase())) continue;
              if (typeof v === 'string') headers[k] = v;
            }

            const upstream = await fetch(target, {
              method: req.method ?? 'GET',
              headers,
              body: chunks.length ? Buffer.concat(chunks) : undefined,
              redirect: 'follow',
            });

            res.statusCode = upstream.status;
            upstream.headers.forEach((val, key) => {
              // 这几个由 Node 自己算，照搬会让响应对不上
              if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key)) return;
              res.setHeader(key, val);
            });

            if (!upstream.body) {
              res.end();
              return;
            }

            // 逐块转发，SSE 的流式特性要靠这里保住
            const reader = upstream.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
            res.end();
          } catch (err) {
            res.statusCode = 502;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(
              JSON.stringify({
                error: { message: `开发代理转发失败：${(err as Error).message}` },
              }),
            );
          }
        })();
      });
    },
  };
}

/**
 * base: './' —— Electron 走 file:// 加载、Capacitor 走 https://localhost 加载，
 * 两者都需要相对路径的资源引用。
 */
export default defineConfig({
  base: './',
  plugins: [react(), devApiProxy()],
  // 构建时间戳。界面上显示出来之后，「我跑的是不是最新那个 exe」
  // 这个问题一眼就能回答 —— 这事已经浪费过两次排查时间。
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
