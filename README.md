<div align="center">

<img src="build/icon.png" width="96" alt="AnyAI">

# AnyAI

**自带 API Key 的多模型 Agent 客户端 · 桌面 / Android**

任何 OpenAI 兼容的端点都能接 —— 日日新、Kimi、DeepSeek、自建聚合网关。
不是聊天壳子：它会联网查证、读写本地文件、控制 Chrome、调 GitHub API，
也能把整件编码活儿转包给本机的 Claude Code。

[![CI](https://github.com/lifishard/AnyAI/actions/workflows/ci.yml/badge.svg)](https://github.com/lifishard/AnyAI/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[下载](#安装) · [配置说明](docs/CONFIGURATION.md) · [从源码构建](docs/BUILD.md) · [架构](docs/ARCHITECTURE.md) · [安全](SECURITY.md)

</div>

---

> **English** — AnyAI is a bring-your-own-key desktop (Electron) and Android (Capacitor)
> client for any OpenAI-compatible endpoint. It runs a real function-calling agent loop:
> web search with citations, local file read/write, shell, Chrome control over CDP,
> GitHub API, and delegation to a locally installed Claude Code CLI. Models, credentials,
> reasoning effort, sampling parameters and the enabled tool set are all configured in the
> UI — nothing is hardcoded. Docs are in Chinese; the UI is in Chinese.
> **It can execute commands and write files on your machine — read [SECURITY.md](SECURITY.md) first.**

---

## 它是什么

一个自己拿 Key 的客户端。你出 Key，它出界面和能力。

**没有一处写死**：模型、凭据、思考强度、流式开关、采样参数、启用哪些工具，全部在界面上调。
模型列表是从 `GET {base}/models` 拉的，上游上新模型不用等这个项目更新。

界面是 Perplexity 那一套 —— 答案里带可点的来源编号，下面跟着这一轮调了哪些工具。

## 能做什么

| | |
|---|---|
| 🔍 **联网查证** | Tavily / Brave / SearXNG 三选一，结果编号成可点来源 |
| 📁 **读写本地文件** | 限定在你手动添加的工作目录内，路径守卫解引用符号链接 |
| 📄 **文档读写** | pdf / docx / xlsx / csv → Markdown；Markdown → docx / pdf / xlsx / html |
| 🌐 **控制 Chrome** | 通过 CDP 控制一个独立配置目录的实例，不碰你日常那份 |
| 🐙 **GitHub** | 搜代码、读仓库、开 issue、装技能 |
| 🤖 **Claude Code** | 本机装了就能把整件编码活儿转包出去 |
| 💻 **命令行** | 工作目录内的 cwd，执行前确认 |
| 📦 **产物面板** | 生成的文件和成品代码块在右侧预览，给路径、在文件夹中显示、用默认程序打开 |
| 🗂 **项目** | 一组对话共享规范 / 记忆 / 文档 / 常用提示词 |
| ⚡ **技能** | `/名字` 唤起，兼容 Anthropic 的 SKILL.md，能从 GitHub 直接装 |
| ⏰ **定时任务** | 每隔 N 分钟 / 每天 / 每周 / cron，错过会补跑 |
| 📱 **Android** | 手机端通过内网遥控复用电脑的本地能力 |

细节都在 [配置说明](docs/CONFIGURATION.md)。

## 安装

### 下载现成的

去 [Releases](https://github.com/lifishard/AnyAI/releases) 拿对应平台的包：

| 平台 | 文件 |
|---|---|
| Windows | `AnyAI-x.y.z-win-x64.exe`（安装版）或带 `portable` 的免安装版 |
| macOS | `AnyAI-x.y.z-mac-arm64.dmg`（Apple Silicon）/ `-x64.dmg`（Intel） |
| Linux | `AnyAI-x.y.z-linux-x64.AppImage` 或 `.deb` |

**没有代码签名。** Windows SmartScreen 会拦一下（更多信息 → 仍要运行），
macOS 要右键 → 打开，或者：

```bash
xattr -dr com.apple.quarantine /Applications/AnyAI.app
```

这是没有证书的预期行为，不是包坏了。介意的话就从源码构建。

### 从源码构建

```bash
git clone https://github.com/lifishard/AnyAI.git
cd anyai
npm install
npm run dist:win      # 或 dist:mac / dist:linux
```

Windows 上不想开命令行：双击 `打包桌面版.bat`。
完整说明（含 Android、两个常见的 Windows 打包失败、发版流程）见 [docs/BUILD.md](docs/BUILD.md)。

## 五分钟跑起来

1. **加一份 API 凭据** —— 设置 → API 凭据 → 添加。填 Base URL 和 Key，点「测试连接」把模型列表拉回来。
2. **选模型** —— 输入框左下角。这个选择是**当前会话**的，不是全局的。
3. **调思考强度** —— 输入框右下角，一档五级，各家 API 的字段差异由映射表翻译。
4. **想联网**：设置 → 工具 → 搜索，填一个 Tavily / Brave 的 Key。
5. **想让它碰文件**：设置 → 工具 → 工作目录，加一个目录。
   **不加的话所有文件和命令行工具直接拒绝执行** —— 这是故意的默认值。

每一项的详细说明、取舍原因和疑难排查，全在 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

## 安全

**这不是普通聊天应用，它能在你的机器上执行命令、读写文件、控制浏览器。**

三道闸门：工作目录白名单（realpath 解引用）、执行前确认（每个会话独立，三档）、
密钥走系统级加密存储且不进渲染进程。

同样重要的是**挡不住什么**：白名单内部的破坏、提示词注入。
装之前请看完 [SECURITY.md](SECURITY.md)。

## 怎么搭起来的

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

三个平台搬字节的方式不同，**但解析只有一份**（`src/lib/sse.ts`）：

| | 网络请求走哪 | 工具在哪执行 |
|---|---|---|
| 桌面（Electron） | 主进程 `fetch` | 主进程，直接跑 |
| Android（Capacitor） | 自写的 `SncHttp` 原生插件 | 转发到电脑 |
| 浏览器（开发态） | Vite 代理插件 | 转发到电脑 |

技术栈：React 19 + Vite + TypeScript，Electron 34 桌面端，Capacitor 7 Android 端。
详细设计（含 PDF 版面重建、思考强度映射、上下文压缩）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 项目状态

1.0.0，能用，但有几件事没验证过，写在这里免得你踩：

- **Android 端完全没在真机上跑过。** 那个 Java 插件的流式读取（跨块的多字节 UTF-8）
  是按原理写的，没验证
- **思考强度映射表里标了「推测」的几条**（Kimi、日日新）按厂商惯例填的，
  报 400 就改那一行，不用改代码
- **图片附件要模型支持多模态**，纯文本模型收到图片会直接 400
- **没有自动更新**，更新靠自己下新版本

发现问题欢迎开 [issue](https://github.com/lifishard/AnyAI/issues)，
带上端点、模型 ID 和请求体预览（记得去掉 Key）。参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[Apache License 2.0](LICENSE)。

选 Apache 而不是 MIT 的理由只有一条：这个应用默认就能在别人机器上执行命令，
Apache-2.0 的免责和责任限制条款（第 7、8 条）写得比 MIT 那一段全大写细。
附带好处是明确的专利授权与专利报复条款，以及「商标不随代码授权」——
fork 出去的版本不能继续叫 AnyAI。

分发时请一并保留 [`NOTICE`](NOTICE)。

> 原名 SenseNova Chat。改名之后 Electron 的用户数据目录会变，
> 应用启动时会自动把旧目录（`%APPDATA%\SenseNova Chat`）的配置搬过来，密钥不用重填。
