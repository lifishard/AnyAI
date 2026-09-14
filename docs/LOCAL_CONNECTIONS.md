# Local connections in the open-source desktop app

wickrunAI runs connectors on each user's computer. No central account, shared subscription, token relay, or machine-specific executable path is shipped in the repository. The browser build continues to use API connections; native process connections require Electron.

## Implemented routes

| Route | Authorization | Models and effort | Execution |
| --- | --- | --- | --- |
| ChatGPT / Codex | The official Codex app-server starts its own browser login. It owns credentials and renewal. | Read from `model/list`; no hard-coded subscription model IDs. | App-server turns, scoped operation approvals, cancellation, durable terminal results. Chat uses a read-only sandbox with command tools disabled. |
| Claude Code | Reuses authorization already held by the user's official native CLI. wickrunAI does not implement Claude consumer OAuth. | Official default or documented CLI aliases. The client validates account access and requested effort. | Structured `-p` result; Chat removes built-in and MCP tools. Work retains `dontAsk` permission restrictions; operations needing additional authority fail visibly. |
| Claude Desktop | Login and tool consent remain in the official desktop app. One-click setup adds the local `wickrun_ai` MCP server while preserving other servers. | The user selects the lead model in Claude Desktop; workers use explicitly selected API profiles and model IDs. | A dedicated collaboration panel sends tasks by official deep link. Claude calls MCP tools to delegate, inspect worker results, report progress and submit the final answer back to wickrunAI. |
| Kimi Code | The official native Kimi client owns login. Users complete its login before connecting. | ACP-advertised model and effort options. | ACP protocol adapter with explicit completion and cancellation. Chat declines operation permissions. Work offers once-only approval for file edits with explicit paths verified inside the selected workspace; commands, terminal, network, unknown operations, and unverifiable paths are declined. |
| Grok and other compatible services | User-supplied API credentials, stored through the existing secret store. | Existing API model discovery and manual model IDs. | Existing API chat/Work runtime. Grok's base URL is `https://api.x.ai/v1`. |

An installed desktop chat app does not necessarily expose an automation interface. A connector must use a supported native protocol or API. Unsupported consumer subscription login is not presented as a working API connection. The connection picker distinguishes missing installation, pending login, connection failure, and available models.

The initial native conversation route accepts text and text attachments. Image attachments remain in the saved conversation, but a native turn currently asks the user to choose an image-capable API route instead of silently discarding them. Native clients may apply their own context compaction and account limits. API token-budget controls are not a claim of precise subscription metering.

Kimi's ACP permission metadata is a protocol boundary, not an operating-system sandbox. The adapter trusts the installed official client to describe the operation accurately and respect a declined permission. It rejects missing or truncated location metadata, paths escaping through symlinks, and permissions that offer only persistent approval. A rejected operation pauses the run with a capability explanation instead of reporting success.

## Connector boundary

### Claude Desktop collaboration (2.1.5)

Open **本机 AI → Claude Desktop · 主脑协作 → 一键配置并打开**. The machine needs Claude Desktop and Node.js 20+. After the first configuration, fully quit and reopen Claude Desktop, then enable `wickrun_ai` in its connectors. Existing desktop configuration is preserved, with a `.prev` backup. Invalid configuration is reported without overwriting it.

In **任务与结果**, describe the goal, choose API workers and set a call limit. **创建任务并打开 Claude** opens an official `claude://claude.ai/new?q=...` link. The user must send the prefilled message in Claude and grant tool consent there. The app cannot silently sign in, send that first message, or turn a consumer login into API credentials.

The lead model can use six MCP tools: `wickrun_list_tasks`, `wickrun_get_task`, `wickrun_delegate_task`, `wickrun_read_worker_result`, `wickrun_report_progress`, and `wickrun_submit_result`. Requests execute only against the API profiles frozen when the user created the task. Credentials remain in the Electron host. Workers return text and have no shell, file, browser or model-selected network tools. Each task permits 1–20 calls, at most two concurrently; the UI caps each response at 2048 output tokens. Both common OpenAI-compatible output-limit fields are selectable. Provider/model compatibility and API billing still depend on the selected service.

Jobs are saved before sending. Reusing the same request key returns the same job; changed payloads with that key are rejected. Cancellation and interrupted execution are never automatically retried. The host rejects tools for other providers' tasks and rejects late final results after cancellation. Final results and worker evidence are stored locally and can be copied or saved from the panel. This is a separate Desktop collaboration queue; it does not silently replace the selected Chat/Work CLI connection.

“已配置” means the files exist. “MCP 已连接” requires a recent actual MCP initialization/heartbeat; it does not certify the account's model entitlement. “已收到最终结果” requires the result submission tool. Keep wickrunAI running while Claude uses its tools. A chat that stops before submitting can be continued using the existing task entry.

The bundled stdio server reads a private per-provider configuration file and forwards to an authenticated loopback-only broker. Its address is refreshed after restarts. Other local MCP clients holding that file have the same access; do not share it. To disconnect, remove `wickrun_ai` from Claude Desktop's MCP settings, quit Claude Desktop, and cancel outstanding tasks here.

ChatGPT continues to use the existing official Codex connection. This release does not add another ChatGPT authorization flow.

References: [Claude Desktop local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [official desktop links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link).

`electron/conversation-clients.cjs` owns lifecycle and dispatch. `electron/client-discovery.cjs` locates native binaries using each user's environment and standard installation locations. Only native executables are launched, with `shell: false`; prompts travel over stdin or protocol messages. Environment filtering excludes API credentials and arbitrary process-injection options.

The renderer-facing contract is defined in `src/lib/connections.ts` and `src/lib/transport.ts`:

- Check: return installation/login status and normalized model/effort options.
- Connect: let a supported official client perform its own authorization flow.
- Run: dispatch one recorded request using the saved connection and mode.
- Events: send visible answer text and scoped approval requests; do not expose hidden reasoning or credential diagnostics.
- Approve: accept a decision for the exact live request; persist it before granting authority.
- Cancel/recover: stop the current turn or recover its saved terminal outcome.

To add a provider, implement its adapter, normalize advertised capabilities, register its kind in the shared contract and host dispatcher, and add offline protocol/lifecycle tests. Adding an adapter requires a source-code change; the app does not download or execute arbitrary connector scripts from a model response.

## Conversation continuity and recovery

The application retains the portable conversation transcript, text attachments, user answers, progress, and existing task checkpoints. A native session ID is useful evidence, but is not the only copy of the user's context. Changing providers keeps the same local conversation.

Before native dispatch, the host writes an execution record. It saves terminal outcomes separately from visible chat bubbles. A request with a saved result can be recovered without another model call; an in-flight request without a confirmed outcome remains uncertain and must not be silently replayed. The source CLI may still have its own transcript or subscription accounting; wickrunAI does not delete or overwrite those records.

Structured question cards are available in Chat and Work. Every question accepts a choice or free text, with no automatic selection. Unsubmitted drafts, submitted answers, and the suspended tool cursor are saved. Answers resume the pending request once; they do not grant file, command, or account permissions. Native clients can return the documented question marker included in their prompt; invalid or incomplete native output cannot clear an uncertain execution state.

## Official protocol references

- [Codex app-server and account login](https://learn.chatgpt.com/docs/app-server)
- [Codex configuration and tool controls](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude Code CLI options](https://code.claude.com/docs/en/cli-reference) and [model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Agent SDK authentication restrictions for third-party products](https://code.claude.com/docs/en/agent-sdk/overview)
- [Kimi CLI and ACP command](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [xAI API setup](https://docs.x.ai/developers/quickstart)

Offline tests validate protocol boundaries and UI state transitions without using real subscriptions. They do not certify that every installed client version or every account plan supports every capability. Platform-specific release validation remains necessary.
