import assert from 'node:assert/strict';
export async function viewChurn(h, context) {
  let mountedChannelOwners=0;
  for(let i=0;i<300;i++) {
    const index=i%2?1:2, name=i%2?'six.flac':'mono16.wav';
    await h.selectMedia(name);
    await h.until(`document.querySelector('.file-pane h2')?.textContent===${JSON.stringify(name)} && !document.querySelector('.tile-status')`, `churn ${i}`);
    mountedChannelOwners+=await h.evaluate('return document.querySelectorAll(".channel-pane").length');
  }
  // This file has not been viewed before: it must successfully submit new native
  // tile work, rather than merely display an already retained frontend buffer.
  await h.selectMedia('stereo.mp3');
  await h.until(`document.querySelector('.file-pane h2')?.textContent==='stereo.mp3' && !document.querySelector('.tile-status')`,'fresh native analysis after owner churn');
  assert.ok(mountedChannelOwners>256);
  assert.equal(await h.evaluate('return document.querySelectorAll("canvas").length'),2);
  await h.screenshot('after-300-view-switches');
  context.churn={switches:300,mountedChannelOwners,freshNativeAnalysis:true};
  await h.selectMedia('six.flac');
  await h.until(`document.querySelector('.file-pane h2')?.textContent==='six.flac' && !document.querySelector('.tile-status')`);
}
