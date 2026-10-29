/** Exact UTF-8 size of a well-formed JSON string, without allocating its encoding. */
export function jsonStringBytes(value:string):number {
 if(!/[^\x20-\x21\x23-\x5b\x5d-\x7f]/.test(value))return value.length+2;
 let bytes=2;
 for(let i=0;i<value.length;i++){
  const unit=value.charCodeAt(i);
  if(unit===34||unit===92)bytes+=2;
  else if(unit<32)bytes+=[8,9,10,12,13].includes(unit)?2:6;
  else if(unit<128)bytes++;
  else if(unit<2048)bytes+=2;
  else if(unit>=0xd800&&unit<=0xdbff){
   const low=value.charCodeAt(i+1);
   if(low>=0xdc00&&low<=0xdfff){bytes+=4;i++;}else bytes+=6;
  }else bytes+=unit>=0xdc00&&unit<=0xdfff?6:3;
 }
 return bytes;
}
