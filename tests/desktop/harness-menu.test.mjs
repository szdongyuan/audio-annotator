import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clickFresh} from './harness.mjs';
test('menu click reacquires a detached element without hiding other failures',async()=>{let finds=0,clicks=0;await clickFresh(async()=>{finds++;return{click:async()=>{if(finds===1){const e=new Error('detached');e.name='StaleElementReferenceError';throw e;}clicks++;}};});assert.equal(finds,2);assert.equal(clicks,1);const e=new Error('not clickable');await assert.rejects(clickFresh(async()=>({click:async()=>{throw e;}})),x=>x===e);});
