import React from 'react';
import { feedbackSnapshot, setTaskFeedback, type TaskFeedback as Feedback, type UserOutcome, type FeedbackReason } from '../lib/observations';

export default function TaskFeedback({taskId}:{taskId?:string}) {
  const [feedback,setFeedback]=React.useState<Feedback|undefined>();const [current,setCurrent]=React.useState(false);const [available,setAvailable]=React.useState(false);const [busy,setBusy]=React.useState(false);
  React.useEffect(()=>{let live=true;const update=()=>{void feedbackSnapshot(taskId??'').then(s=>{if(live){setAvailable(s.available);setFeedback(s.feedback);setCurrent(s.current);}});};update();window.addEventListener('anyai:observations',update);return()=>{live=false;window.removeEventListener('anyai:observations',update);};},[taskId]);
  if(!taskId||!available)return null;
  const save=async(outcome?:UserOutcome,reason?:FeedbackReason)=>{setBusy(true);try{await setTaskFeedback(taskId,outcome?{outcome,reason,at:Date.now()}:undefined);}finally{setBusy(false);}};
  return <div className="task-feedback" aria-label="任务结果反馈"><span>这次结果可用吗？<small>可选，仅保存到本机</small></span>
    {feedback&&!current?<p>此前反馈属于较早阶段；这次续跑后的结果尚未评价。</p>:null}
    <div className="recovery-actions">{([['usable','可用'],['partial','部分可用'],['unresolved','未解决']] as const).map(([value,label])=><button className={`btn sm ${current&&feedback?.outcome===value?'primary':'ghost'}`} aria-pressed={current&&feedback?.outcome===value} disabled={busy} key={value} onClick={()=>void save(value,current?feedback?.reason:undefined)}>{label}</button>)}
    {feedback?<button className="btn sm ghost" disabled={busy} onClick={()=>void save()}>撤回反馈</button>:null}</div>
    {feedback&&current&&feedback.outcome!=='usable'?<label>主要原因（可选） <select aria-label="反馈原因" value={feedback.reason??''} disabled={busy} onChange={e=>void save(feedback.outcome,(e.target.value||undefined) as FeedbackReason|undefined)}><option value="">暂不选择</option><option value="omission">有遗漏</option><option value="incorrect">内容错误</option><option value="artifact">产物问题</option><option value="interrupted">执行中断</option><option value="other">其他</option></select></label>:null}
  </div>;
}
