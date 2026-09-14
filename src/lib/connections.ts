export type ClientKind = 'codex' | 'claude' | 'kimi';
export interface ClientModel { id:string; label:string; efforts:string[]; defaultEffort?:string }
export interface ClientStatus { kind:ClientKind; status:'missing'|'installed'|'login_required'|'ready'|'error'|'waiting_login'; message:string; models:ClientModel[]; binary?:string; connection?:{type:'account'|'api_key'|'custom_api';baseUrl?:string}; }
export interface ClientSelection { kind:ClientKind; model:string; effort?:string }
export interface ClientTurnResult { status:string; text:string; error?:string; sessionId?:string; }
export const CLIENT_LABELS: Record<ClientKind, string> = {
  codex: 'ChatGPT · Codex',
  claude: 'Claude Code',
  kimi: 'Kimi Code',
};
