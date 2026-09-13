/** Small UTF-8, uncompressed ZIP writer. Export packages contain text only. */
export function zipTextFiles(files:Record<string,string>):Uint8Array {
  const encoder=new TextEncoder(),chunks:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
  const crc32=(bytes:Uint8Array)=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
  const header=(size:number)=>{const bytes=new Uint8Array(size);return {bytes,view:new DataView(bytes.buffer)};};
  const entries=Object.entries(files);if(entries.length>100)throw new Error('导出文件数过多');
  for(const [name,text]of entries){
    if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw new Error('导出文件名无效');
    const filename=encoder.encode(name),body=encoder.encode(text),crc=crc32(body);
    const local=header(30+filename.length);const v=local.view;
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint16(12,33,true);
    v.setUint32(14,crc,true);v.setUint32(18,body.length,true);v.setUint32(22,body.length,true);v.setUint16(26,filename.length,true);local.bytes.set(filename,30);
    const c=header(46+filename.length),cv=c.view;cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint16(14,33,true);
    cv.setUint32(16,crc,true);cv.setUint32(20,body.length,true);cv.setUint32(24,body.length,true);cv.setUint16(28,filename.length,true);cv.setUint32(42,offset,true);c.bytes.set(filename,46);
    chunks.push(local.bytes,body);central.push(c.bytes);offset+=local.bytes.length+body.length;
  }
  const size=central.reduce((n,c)=>n+c.length,0),end=header(22);end.view.setUint32(0,0x06054b50,true);end.view.setUint16(8,entries.length,true);end.view.setUint16(10,entries.length,true);end.view.setUint32(12,size,true);end.view.setUint32(16,offset,true);
  const total=offset+size+22;if(total>32*1024*1024)throw new Error('导出包超过 32MB，请缩小时间范围');
  const result=new Uint8Array(total);let cursor=0;for(const part of [...chunks,...central,end.bytes]){result.set(part,cursor);cursor+=part.length;}return result;
}
