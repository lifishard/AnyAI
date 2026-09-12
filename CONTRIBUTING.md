# 参与开发

## 提 issue 之前

先说清楚三件事，否则基本没法复现：

1. **平台和版本** —— Windows / macOS / Linux，安装版还是免安装版
2. **哪个端点和模型** —— base url（去掉 key）+ 模型 ID。多数「它坏了」最后是某个上游的
   兼容性差异
3. **请求体和报错原文** —— 右侧配置面板有「预览请求体」，把它和完整报错贴上来

**不要贴 API Key。** 截图也检查一遍。

安全问题见 [SECURITY.md](SECURITY.md)，别在公开 issue 里贴利用细节。

## 本地跑起来

见 [docs/BUILD.md](docs/BUILD.md)。简版：

```bash
npm install
npm run dev:electron
```

## 提 PR 之前

```bash
npm run typecheck    # CI 里这一步是阻断的
npm run build
```

## 这个项目的几条取舍

改之前值得知道，免得白写：

- **解析只写一份。** SSE 切分、`tool_calls` 累积、字段归一化只能在 `src/lib/sse.ts`。
  别在 Java 或 Node 那边再实现一遍 —— 原生层只搬字节
- **不做命令黑名单。** `run_command` 不拦任何命令。黑名单式过滤基本都能绕过，
  拦得住的只有诚实的人，中间还给人一种「已经有防护了」的错觉。真正的闸门是人工确认
- **没勾的参数不下发。** 加参数走 `PARAM_DEFS`，别在请求体构造里写 if
- **不硬编码模型列表。** 权威来源永远是 `GET {base}/models`
- **产物判据保持收紧。** 普通代码片段不该进产物栏

## 加一个工具

两处，缺一不可：

1. `src/lib/tools/registry.ts` —— 声明 schema、危险等级、需不需要电脑
2. `electron/tools/index.cjs` —— 实际执行器

碰路径的工具**必须**走 `guardPath`。会改变状态的**必须**标成需要确认。

## 加一个厂商的思考强度映射

`src/lib/effort.ts` 的 `defaultEffortMappings()` 里加一条，
**永远排在 `baked-in` 那条后面**。实测过的把注释里的「推测」去掉。

## 许可

提交 PR 即表示你同意你的贡献以 [Apache License 2.0](LICENSE) 授权
（Apache-2.0 第 5 条的默认约定，不需要额外签 CLA）。
