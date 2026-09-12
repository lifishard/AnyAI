import { bodyHash, makeSkill, normalizeBody, parseSkillMd, toSkillMd, type Skill } from './skills';

/* ------------------------------------------------------------------ *
 * 技能与本地文件夹的双向同步
 *
 * 目标是让 AnyAI 和 Claude Code / Desktop 共用同一份技能 —— 后者读的就是
 * ~/.claude/skills/<名字>/SKILL.md。
 *
 * ── 怎么判断该往哪个方向同步 ──
 *
 * 三方对比，跟 git 的三路合并同一个思路：
 *
 *   祖先 = skill.installedHash（上一次两边一致时的正文指纹）
 *   我方 = 应用里的正文
 *   对方 = 文件夹里的正文
 *
 *   只有我方变了  → 推出去
 *   只有对方变了  → 拉进来
 *   两边都变了    → **冲突，两份都留着**，谁也不覆盖谁
 *   没有祖先      → 按冲突处理（比如手写的技能第一次遇上同名文件）
 *
 * ── 三条刻意的规矩 ──
 *
 * 1. **永不删除**。任何一边少了什么，都不构成删除另一边的理由 ——
 *    可能是还没同步过来、改了名、或者故意只在一端留着。删错了没法撤销。
 * 2. **冲突不猜**。两边都改过就各留一份（文件夹那份进来时叫 <名字>-来自文件夹），
 *    让人自己看完再决定。按时间戳选新的那种做法，会在某天悄悄吃掉你半小时的修改。
 * 3. **纯函数**。这里不碰 IO，只产出一份计划。所以能单独测，也能先给人看再执行。
 * ------------------------------------------------------------------ */

export interface FolderItem {
  name: string;
  md: string;
  mtimeMs: number;
  path: string;
}

export interface SyncPlan {
  /** 要写进文件夹的（应用 → 磁盘） */
  push: { name: string; md: string }[];
  /** 要并进应用的（磁盘 → 应用），已经是完整的 Skill */
  pull: Skill[];
  /** 两边都改过，各留一份；这里是「进来的那一份」 */
  conflicts: { name: string; incoming: Skill }[];
  /** 两边一致，什么都不用做 */
  unchanged: string[];
}

/** 同步之后，应用这边每个技能的指纹要更新成什么 */
export interface SyncOutcome {
  skills: Skill[];
  plan: SyncPlan;
}

// 归一化只有一份实现，在 skills.ts —— 两份迟早会分叉，然后指纹对不上
const norm = normalizeBody;

export function planSync(appSkills: Skill[], folder: FolderItem[]): SyncPlan {
  const plan: SyncPlan = { push: [], pull: [], conflicts: [], unchanged: [] };

  const byName = new Map(appSkills.map((s) => [s.name, s]));
  const folderByName = new Map(folder.map((f) => [f.name, f]));

  // 应用里有的
  for (const app of appSkills) {
    const f = folderByName.get(app.name);
    if (!f) {
      plan.push.push({ name: app.name, md: toSkillMd(app) });
      continue;
    }

    const parsed = parseSkillMd(f.md, f.name);
    const mine = bodyHash(norm(app.body));
    const theirs = bodyHash(norm(parsed.body));

    if (mine === theirs) {
      plan.unchanged.push(app.name);
      continue;
    }

    const ancestor = app.installedHash;
    const iChanged = ancestor ? mine !== ancestor : true;
    const theyChanged = ancestor ? theirs !== ancestor : true;

    if (iChanged && !theyChanged) {
      plan.push.push({ name: app.name, md: toSkillMd(app) });
    } else if (!iChanged && theyChanged) {
      plan.pull.push(
        makeSkill({
          ...parsed,
          name: app.name,
          source: `folder:${f.path}`,
          installedHash: theirs,
        }),
      );
    } else {
      // 两边都动过：不覆盖任何一边
      plan.conflicts.push({
        name: app.name,
        incoming: makeSkill({
          ...parsed,
          name: `${app.name}-来自文件夹`,
          source: `folder:${f.path}`,
          installedHash: theirs,
        }),
      });
    }
  }

  // 只在文件夹里有的
  for (const f of folder) {
    if (byName.has(f.name)) continue;
    const parsed = parseSkillMd(f.md, f.name);
    if (!parsed.body.trim()) continue;
    plan.pull.push(
      makeSkill({
        ...parsed,
        name: f.name,
        source: `folder:${f.path}`,
        installedHash: bodyHash(norm(parsed.body)),
      }),
    );
  }

  return plan;
}

/**
 * 把计划落到应用这边的技能列表上。
 *
 * push 的那些也要更新 installedHash —— 推出去之后两边就一致了，
 * 下次再比对时它才是正确的「祖先」。不更新的话，下一次同步会把
 * 每一个推过的技能都误判成「我方又改了」。
 */
export function applyPlan(appSkills: Skill[], plan: SyncPlan): Skill[] {
  const out = [...appSkills];
  const idx = new Map(out.map((s, i) => [s.name, i]));

  for (const p of plan.push) {
    const i = idx.get(p.name);
    if (i === undefined) continue;
    out[i] = { ...out[i], installedHash: bodyHash(norm(out[i].body)) };
  }

  for (const inc of plan.pull) {
    const i = idx.get(inc.name);
    if (i === undefined) {
      out.push(inc);
      idx.set(inc.name, out.length - 1);
    } else {
      // 保留 id、启用状态和使用次数，只换内容
      out[i] = {
        ...inc,
        id: out[i].id,
        enabled: out[i].enabled,
        uses: out[i].uses,
        installedAt: out[i].installedAt,
      };
    }
  }

  for (const c of plan.conflicts) {
    if (idx.has(c.incoming.name)) continue; // 已经留过一份了，不再重复
    out.push(c.incoming);
    idx.set(c.incoming.name, out.length - 1);
  }

  return out;
}

/** 同步完之后，还要把冲突里「我方那份」也写出去吗？不写 —— 见文件头第 2 条 */
export function describeSync(plan: SyncPlan, dir: string): string {
  const bits: string[] = [];
  if (plan.push.length) bits.push(`导出 ${plan.push.length} 个`);
  if (plan.pull.length) bits.push(`导入 ${plan.pull.length} 个`);
  if (plan.conflicts.length) {
    bits.push(
      `${plan.conflicts.length} 个两边都改过，各留一份（${plan.conflicts
        .slice(0, 3)
        .map((c) => c.name)
        .join('、')}）—— 自己看完再决定留哪个`,
    );
  }
  if (plan.unchanged.length) bits.push(`${plan.unchanged.length} 个已一致`);
  return bits.length ? `${bits.join('；')}\n目录：${dir}` : `没有变化\n目录：${dir}`;
}
