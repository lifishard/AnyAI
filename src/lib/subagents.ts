import type {RunState} from '../types';
export interface SubagentWorker {id:string;profileId:string;model:string;label?:string}
export interface SubagentConfig {enabled:boolean;workers:SubagentWorker[];maxCalls:number;allowEdits?:boolean}
export interface SubagentJob {id:string;requestKey:string;workerId:string;model:string;task:string;status:'queued'|'running'|'completed'|'paused'|'failed'|'cancelled'|'uncertain';content:string;error?:string;startedAt:number;finishedAt?:number;steps:number;tokens:number;checkpoint?:RunState}
