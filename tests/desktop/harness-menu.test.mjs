import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clickFresh, revealMedia} from './harness.mjs';
import fs from 'node:fs/promises';
import {By} from './harness.mjs';
test('label waits for a visible real control and never clicks a hidden duplicate',async()=>{
 const source=await fs.readFile(new URL('./harness.mjs',import.meta.url),'utf8'),body=source.match(/async label\(label\) \{([\s\S]*?)\},\r?\n/)?.[1];assert.ok(body);
 const clicks=[],hidden={isDisplayed:async()=>false,click:async()=>{throw Error('hidden control is not interactable');}},visible={isDisplayed:async()=>true,click:async()=>clicks.push('visible')};
 let scans=0;const driver={findElements:async locator=>locator.value.startsWith('[role="menu"]')?[]:(++scans===1?[hidden]:[hidden,visible]),wait:async predicate=>{for(let i=0;i<4;i++){const value=await predicate();if(value)return value;}throw Error('visible control not found');}};
 const label=new Function('driver','By','clickFresh','h',`return async function(label){${body}}`)(driver,By,clickFresh,{element:async()=>hidden});
 await label('标注');assert.deepEqual(clicks,['visible']);assert.ok(scans>=2);
});
test('media selection reveals a collapsed ancestor through the real search control',async()=>{
 const calls=[];let revealed=false;
 const h={driver:{findElements:async()=>revealed?[{click:async()=>calls.push('click')}]:[]},input:async(label,text)=>{calls.push([label,text]);revealed=true;},until:async()=>calls.push('wait')};
 await revealMedia(h,'目录/中文.wav');
 assert.deepEqual(calls,[['搜索音频','目录/中文.wav'],'wait','click']);
});
test('menu click reacquires a detached element without hiding other failures',async()=>{let finds=0,clicks=0;await clickFresh(async()=>{finds++;return{click:async()=>{if(finds===1){const e=new Error('detached');e.name='StaleElementReferenceError';throw e;}clicks++;}};});assert.equal(finds,2);assert.equal(clicks,1);const e=new Error('not clickable');await assert.rejects(clickFresh(async()=>({click:async()=>{throw e;}})),x=>x===e);});
