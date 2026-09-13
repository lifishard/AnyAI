import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneReleases } from './release-retention.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('版本格式无效');
const platforms=process.argv.slice(2).filter(a=>['--win','--mac','--linux'].includes(a));
if(!platforms.length)throw new Error('指定 --win、--mac 或 --linux');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),...platforms,
  '--publish','never',`--config.directories.output=release/${version}`],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
const plan=pruneReleases(path.join(root,'release'),version);
console.log(`安装包：release/${version}；保留 ${plan.keep.join('、')}，清理 ${plan.remove.length-plan.skipped.length} 项旧产物。`);

if(plan.skipped.length)console.log(`仍在运行的旧产物暂留：${plan.skipped.join("、")}；关闭后再次打包即可清理。`);
