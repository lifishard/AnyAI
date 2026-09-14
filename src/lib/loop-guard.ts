import type { RunState, ToolStep } from '../types';

/** Conservative prose repetition detection. Code and changing list values are not evidence. */
export function repeatedProse(text:string):boolean {
  const prose=text.slice(-12000).replace(/```[\s\S]*?(?:```|$)/g,'');
  // Models also rephrase the same numbered plan without ever emitting a tool call.
  // Require three multi-step plans, stable numbers, and substantial shared wording.
  const plans=prose.split(/\n\s*\n/).filter(p=>/(?:^|\n)\s*1[.)]/.test(p) && /\n\s*2[.)]/.test(p))
    .map(p=>p.slice(p.search(/(?:^|\n)\s*1[.)]/)).replace(/^\s*\d+[.)]/gm,'').replace(/[\s`"“”'，。；：、（）()]/g,''))
    .filter(p=>p.length>=40).slice(-8);
  const grams=(p:string)=>new Set(Array.from({length:Math.max(0,p.length-2)},(_,i)=>p.slice(i,i+3)));
  for(const plan of plans){
    const a=grams(plan),numbers=plan.match(/\d+/g)?.join(',') || '';
    const similar=plans.filter(other=>{
      if((other.match(/\d+/g)?.join(',') || '')!==numbers)return false;
      const b=grams(other),shared=[...a].filter(g=>b.has(g)).length;
      return shared/Math.min(a.size,b.size)>=0.7 && Math.min(a.size,b.size)/Math.max(a.size,b.size)>=0.6;
    });
    if(similar.length>=3 && similar.reduce((n,p)=>n+p.length,0)>=120)return true;
  }
  const parts=prose.split(/\n\s*\n|\n(?=\s*\d+[.)])/).slice(-16)
    .map(p=>p.replace(/\s+/g,'').replace(/^[\d.)*#\-]+/,'')).filter(p=>p.length>=20);
  const counts=new Map<string,number>();for(const p of parts)counts.set(p,(counts.get(p)||0)+1);
  let repeated=0,total=0;
  for(const [p,n] of counts){total+=p.length*n;if(n>=3)repeated+=p.length*n;}
  if(total>=300 && repeated>=240 && repeated/total>=0.65)return true;
  // Also catch a single paragraph repeating inside one long SSE response.
  const flat=prose.replace(/\s+/g,' ').trim().slice(-6000);
  if(flat.length<360)return false;
  for(let size=100;size<=Math.min(600,Math.floor(flat.length/3));size+=25){
    const tail=flat.slice(-size);let count=0,pos=0;
    while((pos=flat.indexOf(tail,pos))>=0){count++;pos+=tail.length;}
    if(count>=3 && count*size>=flat.length*0.65)return true;
  }
  return false;
}

export function repetitionWatchdog() {
  let text='',checked=0;
  return {push(delta:string){text=(text+delta).slice(-12000);checked+=delta.length;if(checked<96)return false;checked=0;return repeatedProse(text);}};
}

function stable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
  return JSON.stringify(value) ?? '';
}
const readOnly=(s:ToolStep)=>/^(read_|list_|search_|fetch_|chrome_(read|list|search|fetch|snapshot))/.test(s.name);
/** Detect A-B-A-B-A-B retrieval cycles, comparing actual results, within this attempt. */
export function repeatedReadCycle(state:RunState,name:string,args:unknown):boolean {
  const steps=(state.steps??[]).filter(s=>s.startedAt>=(state.attemptStartedAt??0));
  for(let width=2;width<=4;width++){
    const tail=steps.slice(-width*3);
    if(tail.length!==width*3 || tail.some(s=>s.status==='running'||!readOnly(s)))continue;
    const first=tail[0];if(first.name!==name||stable(first.args)!==stable(args))continue;
    const sig=(s:ToolStep)=>stable([s.name,s.args,s.status,s.output,s.error,s.files]);
    if(tail.every((s,i)=>sig(s)===sig(tail[i%width])))return true;
  }
  return false;
}
