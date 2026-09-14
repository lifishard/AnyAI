export type NativeAiProvider='claude-desktop'|'chatgpt';
export interface NativeAiJob {id:string;workerId:string;prompt:string;status:'running'|'completed'|'failed'|'uncertain';text?:string;error?:string;usage?:{prompt_tokens?:number;completion_tokens?:number}}
export interface NativeAiTask {id:string;provider:NativeAiProvider;goal:string;workers:{id:string;name:string;model:string}[];maxJobs:number;maxOutputTokens:number;status:'waiting'|'working'|'completed'|'cancelled';jobs:NativeAiJob[];progress:{text:string;at:number}[];result?:string;createdAt:number}
export interface NativeAiState {connections:{provider:NativeAiProvider;configured:boolean;connected:boolean;client?:string}[];tasks:NativeAiTask[]}
export interface NativeAiInput {provider:NativeAiProvider;goal:string;workers:{profileId:string;model:string;outputField:'max_tokens'|'max_completion_tokens'}[];maxJobs:number;maxOutputTokens:number}
