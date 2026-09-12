import React from 'react';
import { EFFORT_LEVELS, describeEffort, matchMapping, type EffortLevel, type EffortMapping } from '../lib/effort';

/**
 * 思考强度，挂在输入框右下角。
 *
 * 对外只有一档五级刻度，切模型不用重学各家的字段名 ——
 * 翻译交给 src/lib/effort.ts 里那张可编辑的映射表。
 */
export default function EffortPicker(props: {
  level: EffortLevel;
  onLevel: (l: EffortLevel) => void;
  model: string;
  mappings: EffortMapping[];
  /** thinkingStyle 不是 auto 时，说明用户在配置面板里手动接管了 */
  manual: boolean;
  onOpenMappings: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const cur = EFFORT_LEVELS.find((l) => l.value === props.level) ?? EFFORT_LEVELS[0];
  const mapping = matchMapping(props.model, props.mappings);
  const supported = Boolean(mapping && mapping.style !== 'none');

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button
        className={`btn sm ghost effort-btn${props.level !== 'off' && supported ? ' on' : ''}`}
        title={props.manual ? '配置面板里手动接管了思考字段，这里不生效' : describeEffort(props.model, props.level, props.mappings)}
        onClick={() => setOpen((v) => !v)}
      >
        🧠 {props.manual ? '手动' : cur.label}
      </button>

      {open ? (
        <div className="popup effort-popup">
          <div className="picker-label">思考强度</div>

          {props.manual ? (
            <div className="picker-error">
              配置面板里把「思考字段下发方式」改成了手动，这里选什么都不生效。
              想用这个刻度，把那边改回「自动（按模型映射）」。
            </div>
          ) : null}

          {EFFORT_LEVELS.map((l) => (
            <button
              key={l.value}
              className={`popup-item${l.value === props.level ? ' on' : ''}`}
              disabled={props.manual}
              onClick={() => {
                props.onLevel(l.value);
                setOpen(false);
              }}
            >
              <span className="popup-icon">{l.short}</span>
              <span>
                <strong>{l.label}</strong>
                <small>{describeEffort(props.model, l.value, props.mappings)}</small>
              </span>
            </button>
          ))}

          <div className="picker-foot" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>
              {mapping
                ? `当前模型匹配「${mapping.label}」${mapping.unverified ? '（这条是推的，没实测）' : ''}`
                : '没有匹配到映射规则'}
            </span>
            <button className="btn sm ghost" onClick={props.onOpenMappings}>
              改映射
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
