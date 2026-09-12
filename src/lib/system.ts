/* ------------------------------------------------------------------ *
 * system 消息的唯一拼装点。
 *
 * 为什么单独一个文件：agent.ts 发请求，api.ts 里的 previewBody 给人看
 * 「到底发出去了什么」。两边各拼一份的结果，就是预览里看不到技能 ——
 * 人以为技能没生效，实际上发了；或者反过来。预览和真实请求必须共用
 * 同一段代码，否则它就不是预览，是另一段会骗人的代码。
 * ------------------------------------------------------------------ */

/**
 * 给模型的工具使用守则。
 * 只有真的下发了 tools 才追加，否则白白占 token 还会让模型胡乱提工具。
 */
export const TOOL_SYSTEM_SUFFIX = `
你可以调用工具来完成任务。守则：
1. 涉及最新信息、具体数字、价格、版本号，或任何你不确定的事实，先用 web_search 查证再回答，不要凭记忆编造。
2. 引用了搜索结果或网页内容时，在相应句子末尾用 [1]、[2] 标注来源编号，编号对应工具返回结果里给出的编号。不要编造编号。
3. 搜索结果的摘要不够判断时，用 fetch_url 读全文；需要登录态或 JS 渲染后才有内容的页面，改用 chrome_read_page。
4. 会改变状态的操作（写文件、执行命令、提交 issue），先用一句话说明你要做什么再调用。
5. 信息够了就直接回答，不要为了用工具而用工具。同一个工具不要用相同参数反复调用。
`.trim();

/**
 * 顺序是有讲究的：用户自己的 systemPrompt 在最前（它优先级最高），
 * 然后是项目规范 + 技能正文，最后才是工具守则。
 */
export function composeSystem(systemPrompt: string, extraSystem: string, withTools: boolean): string {
  return [systemPrompt.trim(), extraSystem.trim(), withTools ? TOOL_SYSTEM_SUFFIX : '']
    .filter(Boolean)
    .join('\n\n');
}
