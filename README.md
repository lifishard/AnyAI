<div align="center">

<img src="build/icon.png" width="96" alt="灯芯AI">

# wickrunAI · 灯芯AI

用自己的 API Key，在同一个任务里切换模型、继续工作。

[![CI](https://github.com/lifishard/wickrunAI/actions/workflows/ci.yml/badge.svg)](https://github.com/lifishard/wickrunAI/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[下载](https://github.com/lifishard/wickrunAI/releases) · [配置说明](docs/CONFIGURATION.md) · [构建方法](docs/BUILD.md) · [安全说明](SECURITY.md)

</div>

灯芯AI 是一个开源 AI 客户端，支持 Windows、macOS 和 Linux。你可以连接采用 OpenAI 兼容接口的模型，用它查资料、处理文档、读写文件，也可以授权它操作 Chrome 或调用本机的 Claude Code。

做长任务时，你可以先让一个模型搜集资料，暂停后换另一个模型整理或检查。灯芯AI 会保存你的要求、执行记录和原始资料；点击“接着跑”，新模型就能从保存的位置继续。你仍需要检查结果，特别是引用、计算和生成的文件。接力方式见 [模型接力说明](docs/MODEL_HANDOFF.md)。

使用前需要准备模型服务商的 API Key。模型调用费用由服务商收取。项目另有 Android 客户端，可通过局域网连接电脑；目前尚未完成真机验证。

## 可以做什么

| 用途 | 使用方式 |
|---|---|
| 查资料 | 配置 Tavily、Brave 或 SearXNG，在回答中查看来源链接 |
| 处理文件 | 添加工作目录后，让模型读取资料、生成文档或表格；在文件卡片中打开成品或查看保存位置 |
| 继续长任务 | 暂停、重启应用或切换模型后，从保留的任务记录继续 |
| 浏览器操作 | 启动专用的 Chrome 实例，登录需要使用的网站，再授权模型操作 |
| 编码与仓库工作 | 读取 GitHub 仓库、搜索代码，或调用已安装的 Claude Code；按权限设置执行命令 |
| 整理项目 | 为一组对话保存共用的说明、参考文档和常用提示词 |
| 使用技能 | 导入 `SKILL.md` 技能，在对话中用 `/名字` 调用 |
| 定时运行 | 设置间隔、每日、每周或 cron 任务；执行时需要相应设备和服务可用 |
| 检查调用情况 | 查看模型连接、用量和失败记录；遇到限流时，按恢复策略等待并重试 |

不同模型对工具调用、图片和思考参数的支持有差异。首次使用一个端点时，建议先测试连接，再试一个小任务。

## 安装

从 [Releases](https://github.com/lifishard/wickrunAI/releases) 下载对应平台的文件。新版文件使用 `wickrunAI` 前缀；历史版本仍保留发布时的名称。

| 平台 | 文件 |
|---|---|
| Windows 64 位 | `wickrunAI-x.y.z-win-x64-setup.exe`；免安装版为 `-portable.exe` |
| macOS Apple Silicon | `wickrunAI-x.y.z-mac-arm64.dmg` |
| macOS Intel | `wickrunAI-x.y.z-mac-x64.dmg` |
| Linux 64 位 | `wickrunAI-x.y.z-linux-x64.AppImage` 或 `.deb` |

当前安装包没有代码签名，Windows 或 macOS 可能显示发布者提示。下载后可使用 Release 中的 `SHA256SUMS.txt` 核对文件；也可以按下面的方法从源码构建。

### 首次使用

1. 打开“设置 → API 凭据”，添加 Base URL 和 API Key，点击“测试连接”。
2. 在输入框旁选择模型，发送一个问题确认能收到回复。
3. 需要处理本地文件时，在工具设置里添加工作目录。
4. 需要联网搜索时，配置一个搜索服务。需要操作网站时，启动工具中的 Chrome 并登录网站。

模型选择按会话保存。思考强度、工具权限和任务预算等选项见 [配置说明](docs/CONFIGURATION.md)。

### 从旧版升级

项目曾使用 SenseNova Chat 和 AnyAI 两个名称。从 AnyAI 升级时，灯芯AI 继续使用原来的数据目录，保留配置、会话、任务记录和工具浏览器的登录资料。目录仍叫 `anyai`，属于兼容安排。

安装新版前请退出旧版。应用目前没有自动更新功能，请从 Releases 下载新版本。

## 从源码构建

需要 Node.js 20 或更新版本。

```bash
git clone https://github.com/lifishard/wickrunAI.git
cd wickrunAI
npm install
npm run dist:win
```

在 macOS 或 Linux 上，最后一步分别使用 `npm run dist:mac` 或 `npm run dist:linux`。Windows 用户也可以双击 `打包桌面版.bat`。

维护者可用 `同步到github.bat` 提交源码，用 `发布三平台版本.bat` 触发 GitHub Actions 构建并发布安装包。发版流程和 Android 构建方法见 [构建说明](docs/BUILD.md)。

## 权限与数据

你可以按会话设置工具权限，并指定允许读写的工作目录。命令行和浏览器工具会对电脑或网站执行操作，授权前请核对任务和目标。

桌面端会在系统支持时使用操作系统的加密存储保护 API Key。配置、会话和任务资料保存在本机；调用模型或工具时，相关内容会发送到你配置的服务。密钥存储、远程连接和权限限制见 [安全说明](SECURITY.md)。

## 开发与反馈

桌面端使用 Electron 34，界面使用 React 19、Vite 和 TypeScript；Android 端使用 Capacitor 7。开发资料见 [架构说明](docs/ARCHITECTURE.md) 和 [贡献指南](CONTRIBUTING.md)。

源码版本为 1.3.4，已发布版本以 [Releases](https://github.com/lifishard/wickrunAI/releases) 为准。目前 Android 真机运行、部分服务商的思考参数映射仍需验证。图片附件需要支持图片输入的模型。

遇到问题，请在 [Issues](https://github.com/lifishard/wickrunAI/issues) 中提供应用版本、系统、端点、模型 ID 和复现步骤。附上日志或请求预览前，请删除 API Key 和私人内容。

## English

wickrunAI is an open-source desktop client for Windows, macOS, and Linux. Connect an OpenAI-compatible model service with your own API key to research topics, work with files, or use local tools.

You can pause a task, switch models, and continue with the saved instructions, task history, and source material. Review the output before using it. Model providers charge for API usage; wickrunAI does not supply API keys. The interface and documentation are in Chinese. The Android client has not yet been tested on a physical device.

## License

[Apache License 2.0](LICENSE). 分发时请保留 [NOTICE](NOTICE)。
