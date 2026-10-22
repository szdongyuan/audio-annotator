import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
export async function longFixtures() {
  const root=path.resolve('.test-output/performance-fixtures'); await fs.mkdir(root,{recursive:true});
  const files=[];
  for(const [name,channels,seconds,base] of [['ten-minute-six.wav',6,600,300],['comparison-stereo.wav',2,600,730]]) {
    const file=path.join(root,name),rate=48000,size=44+seconds*rate*channels*2;
    if((await fs.stat(file).catch(()=>null))?.size!==size) {
      const handle=await fs.open(file,'w');
      const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(size-8,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(channels,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*channels*2,28);header.writeUInt16LE(channels*2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(size-44,40);
      const block=Buffer.alloc(rate*channels*2);for(let i=0;i<rate;i++)for(let c=0;c<channels;c++)block.writeInt16LE(Math.round(9000*Math.sin(2*Math.PI*(base+c*170)*i/rate)+2000*Math.sin(2*Math.PI*47*i/rate)),(i*channels+c)*2);
      try {await handle.write(header);for(let s=0;s<seconds;s++)await handle.write(block);}finally{await handle.close();}
    }
    const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
    files.push({file,channels,seconds,rate,size,sha256:hash.digest('hex')});
  }
  return files;
}
