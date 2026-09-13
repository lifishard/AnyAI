import fs from 'node:fs';
import path from 'node:path';
export function requiredAssets(version){
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid release version');
  return [`AnyAI-${version}-win-x64-setup.exe`,`AnyAI-${version}-win-x64-portable.exe`,
    ...['x64','arm64'].flatMap(arch=>['dmg','zip'].map(ext=>`AnyAI-${version}-mac-${arch}.${ext}`)),
    `AnyAI-${version}-linux-x64.AppImage`,`AnyAI-${version}-linux-x64.deb`];
}
export function verifyReleaseAssets(dir,version){
  const names=requiredAssets(version);
  for(const name of names){
    const file=path.join(dir,name);
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()||fs.statSync(file).size<1024*1024)throw new Error(`Missing or incomplete release asset: ${name}`);
    const fd=fs.openSync(file,'r'),head=Buffer.alloc(8);
    try{fs.readSync(fd,head,0,8,0);}finally{fs.closeSync(fd);}
    const prefix=name.endsWith('.exe')?'MZ':name.endsWith('.zip')?'PK':name.endsWith('.deb')?'!<arch>\n':name.endsWith('.AppImage')?'\x7fELF':null;
    if(prefix&&!head.subarray(0,Buffer.byteLength(prefix)).equals(Buffer.from(prefix)))throw new Error(`Unexpected asset format: ${name}`);
  }
  return names;
}
