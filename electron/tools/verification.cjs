'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { guardPath } = require('./common.cjs');

/** Only deterministic, read-only claims. Never infer semantic completeness from a file. */
function inspectDeliverable(args, ctx) {
  const respond = (status, detail) => ({ok:true,content:JSON.stringify({status,detail}),summary:detail});
  try {
    if (!['file_exists','json','ics'].includes(args.kind)) return respond('unverifiable','不支持这项程序检查');
    if (typeof args.path !== 'string' || !path.isAbsolute(args.path)) return respond('unverifiable','文件检查需要绝对路径');
    const p = guardPath(args.path,ctx.workspaceRoots);
    const stat = fs.statSync(p);
    if (!stat.isFile()) return respond('failed','指定路径不是文件');
    if (args.kind === 'file_exists') return respond('passed',`文件存在，${stat.size} 字节；尚未检查内容正确性或完整性`);
    if (stat.size > 8*1024*1024) return respond('unverifiable','文件超过 8MB 检查上限；未读取或推断内容');
    const raw = fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');
    const problems = [];
    if (args.kind === 'json') {
      let value;
      try { value = JSON.parse(raw); } catch { return respond('failed','JSON 解析失败'); }
      if (args.count !== undefined && (!Array.isArray(value) || value.length !== args.count)) problems.push('顶层数组条数与要求不符');
      if (args.requiredKeys?.length) {
        const rows = Array.isArray(value) ? value : [value];
        if (!rows.length || rows.some(r => !r || typeof r !== 'object' || args.requiredKeys.some(k => !Object.hasOwn(r,k) || r[k] === null || r[k] === ''))) problems.push('记录缺少指定必填字段');
      }
    } else {
      const text = raw.replace(/\r?\n[ \t]/g,'');
      const lines = text.trim().split(/\r?\n/);
      if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR' || !lines.includes('VERSION:2.0')) problems.push('缺少日历边界或 VERSION:2.0');
      const events = text.match(/BEGIN:VEVENT\r?\n[\s\S]*?\r?\nEND:VEVENT/g) || [];
      if ((text.match(/BEGIN:VEVENT/g)||[]).length !== events.length || (text.match(/END:VEVENT/g)||[]).length !== events.length) problems.push('事件边界不成对');
      if (args.count !== undefined && events.length !== args.count) problems.push(`事件数 ${events.length} 与要求 ${args.count} 不符`);
      const ids = [];
      for (const event of events) {
        const uid = event.match(/^UID:(.+)$/m)?.[1]?.trim();
        if (!uid || !/^DTSTART(?:;[^:]*)?:\d{8}(?:T\d{6}Z?)?\r?$/m.test(event) || !/^DTSTAMP:\d{8}T\d{6}Z\r?$/m.test(event)) problems.push('事件缺少 UID、DTSTART 或 UTC DTSTAMP，或日期格式不符');
        if (uid) ids.push(uid);
      }
      if (new Set(ids).size !== ids.length) problems.push('存在重复事件 UID');
    }
    if (args.contains?.some(s => typeof s !== 'string' || !raw.includes(s))) problems.push('文件缺少指定字面内容');
    return respond(problems.length ? 'failed':'passed',problems.length ? [...new Set(problems)].join('；')
      : `${args.kind === 'json' ? 'JSON 可解析，指定条数/字段':'ICS 基本边界、事件标识和日期格式，指定条数'}及字面条件检查通过；未证明语义、日期真实性或来源覆盖完整`);
  } catch(e) { return respond(e.code === 'ENOENT' ? 'failed':'unverifiable',`无法完成文件检查：${e.message}`); }
}

function recoverExactWrite(args, ctx) {
  try {
    if (typeof args.content !== 'string') return null;
    const p = guardPath(args.path,ctx.workspaceRoots,{mustExist:true}), stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > 8*1024*1024) return null;
    if (!fs.readFileSync(p).equals(Buffer.from(args.content,'utf8'))) return null;
    return {ok:true,content:'已只读核实：目标文件字节与本次写入内容完全一致；未再次写入。',summary:'已核实中断前的文件写入',filePath:p};
  } catch { return null; }
}
module.exports = {inspectDeliverable,recoverExactWrite};
