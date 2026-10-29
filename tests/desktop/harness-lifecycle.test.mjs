import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as harness from './harness.mjs';

test('candidate executable environment applies to every suite while explicit paths win',()=>{
 assert.equal(harness.testExecutable(undefined,{ANNOTATOR_WORKSPACE_EXE:'D:/owned/candidate.exe'}),path.resolve('D:/owned/candidate.exe'));
 assert.equal(harness.testExecutable('D:/owned/baseline.exe',{ANNOTATOR_WORKSPACE_EXE:'D:/owned/candidate.exe'}),'D:/owned/baseline.exe');
 assert.equal(harness.testExecutable(undefined,{}),path.resolve('target/debug/annotator-desktop.exe'));
});
async function listener() { const server=net.createServer(socket=>socket.end());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,port:server.address().port}; }
const close=server=>new Promise(resolve=>server.close(resolve));
test('actual start executable default honors supplied environment and explicit argument precedence', async () => {
 const source = await fs.readFile(new URL('./harness.mjs', import.meta.url), 'utf8');
 const initializer = source.match(/export async function start\(paths, output, executable, options = \{\}\) \{\r?\n\s*executable = ([^\r\n]+);/)?.[1];
 assert.ok(initializer);
 const resolve = env => new Function('testExecutable', `return executable => ${initializer};`)(executable => harness.testExecutable(executable, env));
 assert.equal(resolve({})(), path.resolve('target/debug/annotator-desktop.exe'));
 assert.equal(resolve({ ANNOTATOR_WORKSPACE_EXE: 'D:/owned/previous/annotator-desktop.exe' })(), path.resolve('D:/owned/previous/annotator-desktop.exe'));
 assert.equal(resolve({ ANNOTATOR_WORKSPACE_EXE: 'D:/owned/previous/annotator-desktop.exe' })('D:/owned/current.exe'), 'D:/owned/current.exe');
});
test('independent instances explicitly bind distinct validated ports and local roots without changing defaults',()=>{
 assert.deepEqual(harness.instanceOptions({}).ports,{driver:4445,native:4446,debug:9235});
 const options=harness.instanceOptions({ports:{driver:4455,native:4456,debug:9245},localDataEnv:'D:/owned/client-b'});
 assert.deepEqual(options.ports,{driver:4455,native:4456,debug:9245});assert.equal(options.localDataEnv,'D:/owned/client-b');
 for(const ports of [{driver:4455,native:4455,debug:9245},{driver:0,native:4456,debug:9245},{driver:4455.5,native:4456,debug:9245},{driver:4455,native:4456,debug:65536}])assert.throws(()=>harness.instanceOptions({ports}),/port/i);
});
test('custom occupied ports are refused without attaching to or terminating their listener',async()=>{
 const {server,port}=await listener();try{await assert.rejects(harness.assertTestPortsAvailable([port]),/refusing to attach/);assert.equal(server.listening,true);}finally{await close(server);}
});
test('teardown waits for an owned listener to retire before reusing its port',async()=>{
 const {server,port}=await listener();const timer=setTimeout(()=>server.close(),50);
 try {await harness.waitForTestPortsReleased([port],1000);assert.equal(server.listening,false);}finally{clearTimeout(timer);await close(server);}
});
test('port-release waiting times out without closing or attaching to another listener',async()=>{
 const {server,port}=await listener();
 try {await assert.rejects(harness.waitForTestPortsReleased([port],100),/still occupied/);assert.equal(server.listening,true);}finally{await close(server);}
});
