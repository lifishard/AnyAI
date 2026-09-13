import { execFileSync } from 'node:child_process';
export function releaseTag(root,version) {
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('发布版本必须为 x.y.z');
  const tag=`v${version}`,git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const head=git(['rev-parse','HEAD']);
  let local;
  try{local=git(['rev-parse','--verify',`refs/tags/${tag}^{}`]);}catch{}
  const refs=git(['ls-remote','--tags','origin',`refs/tags/${tag}`,`refs/tags/${tag}^{}`]).split('\n').filter(Boolean).map(l=>l.split(/\s+/));
  const remote=refs.find(r=>r[1].endsWith('^{}'))?.[0]??refs[0]?.[0];
  if((local&&local!==head)||(remote&&remote!==head))throw new Error(`${tag} 已指向其他提交。请更新版本号后发布，不能覆盖旧版本标签。`);
  if(!local)git(['tag','-a',tag,'-m',`wickrunAI ${version}`]);
  execFileSync('git',['push','origin',`refs/tags/${tag}`],{cwd:root,stdio:'inherit'});
  return {tag,head,alreadyPushed:Boolean(remote)};
}
