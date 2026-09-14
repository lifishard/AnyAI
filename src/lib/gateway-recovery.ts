import type { KeyProfile } from '../types';
export interface GatewayRecoveryResult { state:'ready'|'offline'|'occupied'|'auth'|'unhealthy'|'failed'|'starting'|'unsupported'; message:string; baseUrl?:string; started?:boolean; modelCount?:number }
export function canRecoverGateway(profile?: KeyProfile | null) {
  try { const u=new URL(profile?.baseUrl || '');return u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && /^\/v1\/?$/.test(u.pathname) && (/^omni$/i.test(profile?.name || '') || /omnirout(?:e|er)/i.test(profile?.name || '')); } catch {return false;}
}
