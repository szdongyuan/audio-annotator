import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import * as harness from './harness.mjs';
async function listener() { const server=net.createServer(socket=>socket.end());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,port:server.address().port}; }
const close=server=>new Promise(resolve=>server.close(resolve));
test('teardown waits for an owned listener to retire before reusing its port',async()=>{
 const {server,port}=await listener();const timer=setTimeout(()=>server.close(),50);
 try {await harness.waitForTestPortsReleased([port],1000);assert.equal(server.listening,false);}finally{clearTimeout(timer);await close(server);}
});
test('port-release waiting times out without closing or attaching to another listener',async()=>{
 const {server,port}=await listener();
 try {await assert.rejects(harness.waitForTestPortsReleased([port],100),/still occupied/);assert.equal(server.listening,true);}finally{await close(server);}
});
