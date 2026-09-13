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

1.2 起使用 `adaptive.ts`、`task-context.ts` 与 `context-memory.ts` 的组合流程。
先按已知窗口、输出/思考预留和单次可用额度计算工作预算，外置过大的附件并折叠旧工具结果；
预计下一批结果放不下时，再对较早且已完成的消息批次生成带来源的增量摘要。
原始 `working`、完整工具证据、用户要求和文件索引保留。摘要失败或取消不会替换旧摘要。
历史条数限制仍是用户的显式选择；压缩和切换请求前缀可能影响上游缓存，不能保证每次都命中。

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

## 1.1 任务持久化与文件交付

`agent.ts` 使用 request/tools/final 阶段及工具游标驱动一次运行。首次请求、工具执行前后、
暂停和完成均等待 `onRunState` 保存。`runs.ts` 把独立运行记录与聊天记录合并；聊天的延迟保存
即使来不及发生，启动时也可以恢复原始问题与回答。删除运行会写入 tombstone，迟到的保存不能复活它。

桌面端 `run-store.cjs` 将记录写入 userData/runtime-v2，按 runs/jobs/results/exchanges 分开存储。
写入通过临时文件、fsync 和重命名提交，并保留上一版。API 凭据与请求认证头不写入这些记录，
但原始任务材料、请求正文和工具证据会作为本地任务数据保存。

工具执行器在派发前记录意图，完成后记录返回值；同一 runId/callId 的已完成结果直接重用，
仍在执行的调用共享同一 promise，进程重启后状态不明的修改操作不会自动重做。
超过 12,000 字符的工具返回保存全文，模型获得摘要和 `read_tool_result` 引用。
`contextView` 只生成有界请求视图，按完整工具调用批次压缩，不修改原始执行记录。

`pacer.ts` 串行调度同一凭据的请求，排队可取消；一分钟 token 账本按 requestId 预留并用实际 usage 替换。
`wiretap.ts` 按请求编号而非“最后一次响应”选择诊断证据。桌面 HTTP 对首字等待及连续无数据计时，
流持续有数据时重置计时器，并单独记录用户暂停与超时。

`file-records.cjs` 使用目录权限检查、realpath 和 stat 核实输入/输出文件。
`ArtifactStrip` 展示核实路径、文件大小和操作；历史未核实记录有明确标识。
`MessageQuote` 保存所选原文快照与来源消息编号；quoteOnly 形成历史边界，系统/项目规范照常注入。

回归入口：`npm test`。覆盖排队取消、额度记账、SSE 错误、失败现场、分页结构检查、
持久化与恢复、工具去重、局部引用、上下文调用配对、真实文件核实及最终回答失败。

## 1.2 自适应上下文与里程碑

详细决策和文献依据见 [设计计划](ADAPTIVE_CONTEXT_PLAN.md)，验收进度见 [施工路线图](ADAPTIVE_CONTEXT_ROADMAP.md)。

- `adaptive.ts`：端点/协议/模型路由键；可编辑路由覆盖；模型元数据与明确上游限额取较小值；输出与思考计入同一生成预留；按真实输入 usage 校准估计。校准按路由、思考档位、文本/图片分别保存，七天失效。
- `limits.ts`：仅解析明确的上限句式，不从请求大小或错误代码猜窗口。每项观察独立计时，新的 RPM 头不会让陈旧窗口重新有效。
- `pacer.ts` / `transport.ts`：共享额度组内串行发送；总 token、输入 token、输出 token 分账；读取 limit/remaining/reset 与 Retry-After，窗口容量不随瞬时余额归零。开启“缓存输入不占额度”后按 usage 扣除缓存读取；无缓存预报时先保守预留。
- `context-memory.ts`：`update_plan` 在本地合并里程碑，完成项必须引用成功工具步骤或已交付的回答原文；更新计划本身不能作为完成证据。`read_context` 分页访问原消息、文本附件，或取回原图。引用限定范围同时约束检索，不能绕回未选择的历史。
- `agent.ts`：本地缩减优先；摘要调用仍走当前模型、当前思考设置、同一队列和阶段预算。候选只覆盖完整旧批次；摘要结构/来源/长度与缩减效果检查成功后才提交。目标、待办与核实文件独立保存，语义摘要不拥有修改这些记录的权限。

`RunState` 新增 `runtimeVersion`、`milestones`、`compactions`、`contextSnapshot` 和 `requestStats`。
请求记录区分待发送/成功/失败/摘要未采用/取消，并保存估计、实际 usage、耗时和原因。
摘要请求在原始交换记录中使用 `purpose=compaction`，不与主回答或诊断请求混淆。
实际 usage 优先；没有 usage 的成功请求保守估算，明确无输出的拒绝不记为完整生成，已发出但中断的请求记录估算。

完成任务需要不存在未完成里程碑。模型连续两次口头收尾仍不更新计划时暂停；受阻项直接保留，
不会通过删除未完成项“完成”任务。阶段轮次、累计 token、总时长和恢复等待各自限制运行。

当前实现仍为 OpenAI 兼容 Chat Completions。Responses、Messages、Gemini 原生协议及其不透明压缩/签名状态不是本次实现范围。
摘要的事实忠实性仍取决于模型；结构与来源检查、精确原文保护和按需核验不能被解读为跨模型正确率保证。
本轮只积累版本化记录与回归证据，不启用自动修改策略或提示词的 RSI 循环。

## 1.3 交付验收、明确恢复与本地观测

设计依据见 [讨论稿](DELIVERY_RECOVERY_OBSERVABILITY_DESIGN.md)，施工与验收见 [路线图](DELIVERY_RECOVERY_OBSERVABILITY_ROADMAP.md)。

`delivery.ts` 管理用户来源、要求修订、程序检查/模型复核以及交付报告。要求与执行里程碑分别保存；`update_requirements` 不能借助内部继续指令伪造用户来源，也不能删除遗漏项。`verify_requirements` 的程序结果由只读 `inspect_deliverable` 计算，模型无法指定通过状态。`verification.cjs` 检查文件存在、JSON 解析/条数/字段及 ICS 基础结构；字面覆盖和语义正确性明确区分。交付前再次读取并核对程序条件；失败或未检查项在有限修复后暂停，无法核验项明确保留为未核实交付。

`RecoveryCard` 展示阻塞说明、已保存成果、待处理要求和下一步，并允许补充信息。补充发生在工具批次中时先使用 `reconcile_operation` 核实旧操作：尚未开始则取消，有完成记录则取回，已开始但未知则暂停等待核实。补充消息在完整工具调用/结果批次之后加入，以维持协议配对。只有 `write_file` 的实际字节与原写入完全一致时才自动取回完成状态，不重写文件。

`observations.ts` 在任务持久化后更新独立白名单统计索引；任务、阶段、事件和反馈分别记录。统计存储错误会显示缺口但不会中断任务。任务删除会移除关联统计；单独清空统计不会删除任务或原文件，也不会重新导入旧任务。90 天、500 任务、4MB 索引和事件/阶段上限控制体积，裁剪公开说明。

统计区分正常结束、验收、用户评价；反馈绑定评价时的阶段，续跑后先前评价不会被当成当前评价。等待用户确认单独计时，超过五分钟的观测间隔不推断为运行时间。请求 usage 缺失与预算预留保留各自含义，不换算没有依据的金额。先前版本缺少的观测不回填成成功或零消耗。

`ObservationPanel` 按任务开始时间、曾使用模型和版本筛选，提供关联任务查看和导出预览。`observation-export.ts` 生成 Markdown 摘要及 JSONL/manifest；`export-zip.ts` 生成 UTF-8 ZIP，桌面端通过用户选择的保存路径写出。默认包不含标题、正文、路径、完整接口地址或凭据；指定任务的内容片段需单独选择并预览，常见凭据会替换，凭据存储及思考字段不会加入。没有外部上传或定时后台模型调用。

## 跨模型任务连续性（1.3.1）

`handoff.ts` 从持久化执行记录构造历史交接材料。`contextArchive` 与 `contextArchiveSteps` 保留前序原文及证据，和当前任务工作记录、工具统计分离；按消息 ID 去重，去除独立思考字段。原始用户更正前台保留，引用边界和删除/修改来源限制可导入的快照。`read_context` 同时查询当前和历史原文，`read_tool_result` 自动加入可用的桌面检索工具。

继续原任务保留同一 runId、压缩记忆和工具游标，预算使用当前配置重新计算。消息条数裁剪停用；无检索能力时不产生无法使用的缩略引用。连续相同参数操作返回相同结果时在第四次派发前记录未执行结果、推进工具游标并暂停，保持协议配对和续跑能力。

`HandoffInfo` 区分准备与实际发送，界面与 `context_handoff` 白名单事件共用事实状态；不把已发送等同于已理解。流程及验证见 [上下文与模型接力](MODEL_HANDOFF.md)。
