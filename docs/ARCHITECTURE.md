# 架构说明

```
你输入问题
   ↓
Agent 循环 (src/lib/agent.ts)
   ↓  把 tools schema 随请求下发
模型返回 tool_calls
   ↓  危险操作弹确认
工具在原生层执行 (electron/tools/*)
   ↓  结果回灌，编号成可引用来源
再问一轮 … 直到模型给出终答
```

## 三个平台，一份解析

字节搬运的方式三个平台各不相同，但**解析只有一份**：

| | 网络请求走哪 | 工具在哪执行 |
|---|---|---|
| 桌面（Electron） | 主进程 `fetch` | 主进程，直接跑 |
| Android（Capacitor） | 自写的 `SncHttp` 原生插件 | 转发到电脑（遥控服务） |
| 浏览器（开发态） | Vite 代理插件 `/__sn` | 转发到电脑（遥控服务） |

原生层只负责把字节搬上来 —— `chunk` = SSE 原文，`body` = 非流式整包。
SSE 切分、`tool_calls` 累积、字段归一化全在 `src/lib/sse.ts` 一处。

这是刻意的：同一套解析逻辑在 Java / Node / TS 里各写一份，迟早会各自跑偏，
而且跑偏的地方一定是最难复现的那类（跨块的多字节字符、`delta` 里 `tool_calls` 的
index 拼接、某家厂商的非标准字段）。

**为什么不让浏览器直接 fetch**：日日新等端点不给浏览器发 CORS 头，WebView 里的 `fetch`
一定被同源策略挡下。Capacitor 官方的 `CapacitorHttp` 能绕过 CORS，
但它把整个响应缓冲完才回调，拿不到流式增量 —— 所以 Android 那个插件必须自己写。

## 字段归一化

`normalizeDelta` 同时认这几种形状：

- OpenAI 流式 `choices[].delta.content`
- OpenAI 非流式 `choices[].message.content`
- 日日新原生 `{ data: { choices: [{ delta: "..." }] } }`（`delta` 是字符串不是对象）
- 各家的推理内容字段：`reasoning_content` / `reasoning`

`pickUsage` 把缓存命中数归一化：`cached_tokens` / `prompt_cache_hit_tokens` /
`prompt_tokens_details.cached_tokens`。

## 请求体构造

`src/lib/paramSchema.ts` 里 `PARAM_DEFS` 是一张声明式的参数表，UI 表单和下发逻辑都从它生成。

两条规则：

1. **没勾选的参数根本不出现在请求体里** —— 模型不认识 `top_k` / `min_p` 时不会 400
2. **工具名下发前排序** —— 否则勾一下工具，`tools` 的序列化顺序就变了，
   上下文缓存的前缀跟着失配

加新参数 = 在 `PARAM_DEFS` 补一行，别处不用改。

## 思考强度的跨厂商映射

`src/lib/effort.ts`。对外一档五级，对内按模型 ID 顺序匹配规则表，第一条命中的生效。

第一条规则是正则，处理「模型名自带强度」：

```js
'[-_/](minimal|none|low|medium|mid|high|xhigh|x-high|extra-?high|max|ultra|thinking|think|reasoner|reasoning)(-?\\d+k?)?$'
```

`dva/claude-5-fable-high`、`gpt-5-minimal`、`qwen3-thinking` 这类，后缀本身就是那条路由的
思考预算，再叠字段轻则被忽略重则 400。**这条必须排第一**，否则会先被「Claude」那条抓走。

## 工具

声明和执行是分开的两处：

- `src/lib/tools/registry.ts` —— schema、危险等级、平台可用性（前端要知道这些来渲染确认框）
- `electron/tools/index.cjs` —— 实际执行器（只在有原生层的地方存在）

加一个工具就是这两处各加一条。

路径守卫 `electron/tools/common.cjs` 的 `guardPath`：先 `realpath` 解引用再跟工作目录白名单
比对，符号链接绕不过去；白名单为空时一律拒绝。

## PDF 版面重建

`electron/tools/pdf-layout.cjs`。这是这个项目里最不平凡的一块。

PDF 里根本没有「段落」「表格」「栏」这些概念，只有一堆带坐标的字符串片段。朴素抽取
（`pdf-parse` 那类）就是按内部顺序 join 一下，结果是双栏论文左右栏交替串行、表格塌成一行、
标题和正文分不开、换行处的连字符原地留着 —— 这就是「错位」的来源。

这里用 pdfjs 给出的每个片段的**坐标和字号**，按这个顺序还原：

1. **按 y 聚成行**，容差取该行字号中位数的 0.45 倍
2. **检测竖直空白带切分栏** —— 把页宽分成 100 个细格，统计每格被多少行覆盖，
   找出覆盖率接近零的连续带。只在**空白带落在页面中部 30–70%、且两侧各有 ≥5 行**时才认，
   避免把居中标题下方的空白误判成分栏。这一步是双栏不串行的关键
3. **行内按 x 排序**，间距超过 0.22 字宽补空格（中文之间不补）
4. **字号相对页面中位数判标题级别**
5. **表格检测**：连续多行的片段 x 起点能在 6pt 粒度上对齐成同样的列签名、且 ≥3 行 →
   输出 Markdown 表格
6. **段落合并**：行尾连字符接词；未以句末标点结束、且左边距相同的行并进同一段

扫描件（页面是图、没有文字层）会明确报「需要先 OCR」，而不是吐一堆空白。

**PDF 生成**走 Electron 自带的 `printToPDF`（`electron/pdf-print.cjs`）：
这个应用本身就是 Chromium，排版引擎已经在手上，零额外依赖，中文字体跟系统一致，
不会出现「装了库但缺字体导致方块」。

## 产物收集

`src/lib/artifacts.ts`。一轮回答结束后拎出两类东西：

1. 工具真的写到磁盘的文件（`step.filePath`）
2. 答案正文里**本身就是成品**的代码块 —— 完整 HTML 文档、SVG、mermaid

判据刻意收紧：一段普通的 Python 函数不是产物，那是答案的一部分，混进产物栏只会稀释信号。

HTML 预览跑在 `sandbox="allow-scripts allow-forms"` 的 iframe 里，
**故意不给 `allow-same-origin`** —— 产物是模型生成的，不该能碰应用自身的存储和 DOM。

## 上下文压缩

轮次上限开高之后，上下文会被工具输出撑爆（一次 `list_dir` 就可能几千字符）。
`compactToolOutputs()`：保留最近那批工具输出的全文，更早的压成一句摘要，总预算 12 万字符。
每条只会被压一次，压完前缀重新稳定。

代价是压缩那一下会让缓存前缀失配一次。但能触发压缩的对话，早就超出缓存能省下的量级了。

## 目录结构

```
src/
  lib/
    transport.ts       三平台的字节搬运，统一成一个接口
    sse.ts             SSE 解析 + tool_calls 累积 + 字段归一化（唯一一份）
    agent.ts           Agent 循环：下发工具 → 执行 → 回灌 → 再问
    paramSchema.ts     参数声明 + 请求体构造
    api.ts             base url / 模型列表 / 请求头
    store.ts           配置与会话的持久化
    effort.ts          思考强度的五级刻度 + 跨厂商映射
    skills.ts          技能：SKILL.md 解析、GitHub 安装、/ 唤起
    projects.ts        项目：规范 / 记忆 / 文档 / 提示词
    schedule.ts        定时任务：排程计算 + 自写的 cron 解析
    artifacts.ts       产物收集：落盘文件 + 答案里的成品代码块
    tools/registry.ts  工具声明：schema、危险等级、平台可用性
  components/          Perplexity 式 UI
electron/
  main.cjs             窗口 + IPC + HTTP 搬运
  store.cjs            本地存储，密钥走 safeStorage
  chrome-launch.cjs    拉起带调试端口的 Chrome（独立配置目录）
  attachments.cjs      读取用户挑的文件 / 图片
  remote-server.cjs    手机遥控的 HTTP 入口
  pdf-print.cjs        HTML → PDF，用 Electron 的 printToPDF
  tools/
    index.cjs          执行器分发
    common.cjs         guardPath 等公共件
    pdf-layout.cjs     PDF 版面重建（分栏 / 标题 / 表格 / 段落）
    documents.cjs      docx / xlsx / pdf 的读写
    *.cjs              其余工具
native/android/
  SncHttpPlugin.java   流式 HTTP 的原生插件
scripts/               构建 / 开发 / 安装插件 / 认领仓库
```
