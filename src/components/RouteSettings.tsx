import type { GenerationConfig, KeyProfile, RouteOverrides } from '../types';
import { routeKey } from '../lib/adaptive';
import { Field } from './ui';
export default function RouteSettings({ profile, config, onChange }: {
  profile: KeyProfile; config: GenerationConfig; onChange: (profile: KeyProfile) => void;
}) {
  const key = routeKey(profile,config.model), route = profile.routeProfiles?.[key] ?? {};
  const update = (patch: Partial<RouteOverrides>) => onChange({ ...profile,routeProfiles:{ ...profile.routeProfiles,[key]:{ ...route,...patch } } });
  return <div className="section route-settings">
    <div className="section-title">当前路由能力</div>
    <p className="hint">适用于 {profile.name} · {config.model}。留空表示未知，优先读取模型元数据和上游明确限额。网关地址改变后重新记录。</p>
    {([['contextWindow','模型上下文窗口'],['maxOutput','单次输出上限（含思考）'],['tpm','每分钟总 token'],['itpm','每分钟输入 token'],['otpm','每分钟输出 token'],['rpm','每分钟请求数']] as const).map(([key,label]) =>
      <Field key={key} label={label}><input aria-label={label} type="number" min={1} placeholder="未知 / 自动学习" value={route[key] ?? ''} onChange={e => update({ [key]:Number(e.target.value)>0 ? Math.floor(Number(e.target.value)) : undefined })} /></Field>)}
    <Field label="共享额度组" hint="同一账户或项目的多份凭据可填写相同组名，共用队列；不确定时留空。">
      <input aria-label="共享额度组" value={profile.quotaGroup ?? ''} placeholder="例如：我的工作账户" onChange={e => onChange({ ...profile,quotaGroup:e.target.value })} />
    </Field>
    <details><summary>输出与思考兼容设置</summary>
      <Field label="输出上限字段">
        <select aria-label="输出上限字段" value={route.outputField ?? ''} onChange={e => update({ outputField:(e.target.value || undefined) as RouteOverrides['outputField'] })}>
          <option value="">沿用生成参数</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option><option value="none">不支持此字段</option>
        </select>
      </Field>
      <Field label="自动思考档位映射" hint="选择当前网关实际支持的写法；不会自动降低你选择的档位。">
        <select aria-label="自动思考档位映射" value={route.effortStyle ?? 'mapping'} onChange={e => update({ effortStyle:e.target.value as RouteOverrides['effortStyle'] })}>
          <option value="mapping">沿用全局映射表</option><option value="none">不下发思考参数</option><option value="reasoning_effort">reasoning_effort</option><option value="thinking_object">thinking 对象</option><option value="thinking_budget">thinking_budget</option>
        </select>
      </Field>
      {route.effortStyle && !['mapping','none'].includes(route.effortStyle) ? (['low','medium','high','xhigh','max'] as const).map(level =>
        <Field label={level} key={level}><input aria-label={`${level} 思考映射`} placeholder={route.effortStyle === 'reasoning_effort' ? '上游支持的字符串' : '思考 token 预算'} value={route.effortValues?.[level] ?? ''} onChange={e => update({ effortValues:{ ...route.effortValues,[level]:e.target.value } })} /></Field>) : null}
      <Field label="缓存输入是否占输入额度">
        <select aria-label="缓存输入是否占输入额度" value={route.cachedInputCounts === false ? 'no' : 'yes'} onChange={e => update({ cachedInputCounts:e.target.value === 'yes' })}>
          <option value="yes">计入 / 未确认</option><option value="no">上游确认缓存读取不计入</option>
        </select>
      </Field>
    </details>
  </div>;
}
