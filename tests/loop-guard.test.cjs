const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {loader}=require('./load-ts.cjs');const {repeatedProse,repetitionWatchdog,repeatedReadCycle}=loader()(path.resolve(__dirname,'../src/lib/loop-guard.ts'));
const plan='好的，我现在清楚了数据结构，开始实现以下两件事情。\n\n1. 扩展 data/courses-seed.json 的 readings，使用真实数据补全。\n\n2. 在学期视图增加阅读清单展开面板，先读取当前文件确认结构。\n\n';
test('streaming repeated promises trip before consuming the full response',()=>{
 const watch=repetitionWatchdog();let stopped=false;
 for(const chunk of (plan.repeat(20)).match(/.{1,24}|\n/g)||[])if(watch.push(chunk)){stopped=true;break;}
 assert.equal(stopped,true);assert.equal(repeatedProse(plan.repeat(4)),true);
});
test('normal code, changing lists, and short acknowledgments are not loops',()=>{
 assert.equal(repeatedProse('```js\n'+plan.repeat(20)+'\n```'),false);
 assert.equal(repeatedProse(Array.from({length:30},(_,i)=>`记录 ${i}：这份资料的内容已经核实，下一步检查不同的来源 ${i}。`).join('\n\n')),false);
 assert.equal(repeatedProse('好的。\n\n'.repeat(20)),false);
});

test('rephrased multi-step promises are caught, but plans with changing values are not',()=>{
 const plans=[
  '我现在要完成两件事：\n1. 扩展 data/courses_seed.json 的 readings（用 Canvas 真实数据）\n2. 在学期视图加阅读清单展开面板',
  '现在清楚了，开始实现：\n1. 扩展 seed JSON 的 readings 字段（用 Canvas 真实数据）\n2. 在学期页加"阅读清单"展开面板',
  '先读取代码再实现：\n1. 扩展 seed JSON 的 readings 字段（用 Canvas 真实数据）\n2. 在学期页加阅读清单视图',
  '我将完成以下步骤：\n1. 扩展 seed JSON 的 readings 字段（用 Canvas 真实数据）\n2. 在学期页加阅读清单视图',
 ];
 assert.equal(repeatedProse(plans.join('\n\n')),true);
 assert.equal(repeatedProse(plans.map((p,i)=>p+'，课程编号 '+i).join('\n\n')),false);
});
test('alternating retrieval with unchanged evidence stops, changed evidence and new attempts do not',()=>{
 const step=(name,output)=>({name,args:{path:name},output,status:'ok',startedAt:2});
 const state={attemptStartedAt:1,steps:Array.from({length:6},(_,i)=>step(i%2?'read_file':'read_context','unchanged'))};
 assert.equal(repeatedReadCycle(state,'read_context',{path:'read_context'}),true);
 state.steps[4].output='new evidence';assert.equal(repeatedReadCycle(state,'read_context',{path:'read_context'}),false);
 state.attemptStartedAt=3;assert.equal(repeatedReadCycle(state,'read_context',{path:'read_context'}),false);
});
