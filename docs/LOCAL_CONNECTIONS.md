# Local connections in the open-source desktop app

wickrunAI runs connectors on each user's computer. No central account, shared subscription, token relay, or machine-specific executable path is shipped in the repository. The browser build continues to use API connections; native process connections require Electron.

## Implemented routes

| Route | Authorization | Models and effort | Execution |
| --- | --- | --- | --- |
| ChatGPT / Codex | The official Codex app-server starts its own browser login. It owns credentials and renewal. | Read from `model/list`; no hard-coded subscription model IDs. | App-server turns, scoped operation approvals, cancellation, durable terminal results. Chat uses a read-only sandbox with command tools disabled. |
| Claude Code | Reuses authorization already held by the user's official native CLI. wickrunAI does not implement Claude consumer OAuth. | Official default or documented CLI aliases. The client validates account access and requested effort. | Structured `-p` result; Chat removes built-in and MCP tools. Work retains `dontAsk` permission restrictions; operations needing additional authority fail visibly. |
| Kimi Code | The official native Kimi client owns login. Users complete its login before connecting. | ACP-advertised model and effort options. | ACP protocol adapter with explicit completion and cancellation. Chat declines operation permissions. Work offers once-only approval for file edits with explicit paths verified inside the selected workspace; commands, terminal, network, unknown operations, and unverifiable paths are declined. |
| Grok and other compatible services | User-supplied API credentials, stored through the existing secret store. | Existing API model discovery and manual model IDs. | Existing API chat/Work runtime. Grok's base URL is `https://api.x.ai/v1`. |

An installed desktop chat app does not necessarily expose an automation interface. A connector must use a supported native protocol or API. Unsupported consumer subscription login is not presented as a working API connection. The connection picker distinguishes missing installation, pending login, connection failure, and available models.

The initial native conversation route accepts text and text attachments. Image attachments remain in the saved conversation, but a native turn currently asks the user to choose an image-capable API route instead of silently discarding them. Native clients may apply their own context compaction and account limits. API token-budget controls are not a claim of precise subscription metering.

Kimi's ACP permission metadata is a protocol boundary, not an operating-system sandbox. The adapter trusts the installed official client to describe the operation accurately and respect a declined permission. It rejects missing or truncated location metadata, paths escaping through symlinks, and permissions that offer only persistent approval. A rejected operation pauses the run with a capability explanation instead of reporting success.

## Connector boundary

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
