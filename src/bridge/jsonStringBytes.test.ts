import {expect,it} from 'vitest';
import {jsonStringBytes} from './jsonStringBytes';
it('matches JSON UTF-8 bytes for every UTF-16 code unit, escaping and valid/invalid surrogate sequences',()=>{
 const encoder=new TextEncoder(),check=(s:string)=>expect(jsonStringBytes(s)).toBe(encoder.encode(JSON.stringify(s)).length);
 for(let unit=0;unit<=65535;unit++)check(String.fromCharCode(unit));
 for(const s of ['', 'plain ascii', '目录/音频.wav', '\"\\\b\t\n\f\r\0', '😀𝄞', '\ud800\ud800\udc00\udc00', '\udfff\ud800', 'x'.repeat(4096)])check(s);
 let seed=7301;
 for(let n=0;n<200;n++){let s='';for(let i=0;i<100;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+=String.fromCharCode(seed&65535);}check(s);}
});
