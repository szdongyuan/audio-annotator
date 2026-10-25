// Native contract/fault evidence, distinct from Selenium UI acceptance suites.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { start } from './harness.mjs';

const parent = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/default-collaboration-v040/task5/desktop-evidence/collaboration-native');
await fs.mkdir(parent, { recursive: true });
const output = await fs.mkdtemp(path.join(parent, 'ipc-'));
const source = path.join(output, 'source'), shared = path.join(output, 'shared'), local = path.join(output, 'local');
for (const p of [source, shared, local]) await fs.mkdir(p);
const report = { method: 'Fresh debug e2e Tauri binary, actual IPC through owned WebView2/Selenium; native commands, not UI acceptance', output, checks: [] };
let h;
try {
  h = await start({}, output, undefined, {localDataEnv:local});
  const invoke = async (command, args = {}) => {
    const r = await h.driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error}));', command, args);
    if (!r.ok) throw Object.assign(new Error(JSON.stringify(r.error)), r.error);
    return r.value;
  };
  const channel = async name => {
    await h.evaluate('window[arguments[0]]=[];window[arguments[0]+"Id"]=window.__TAURI_INTERNALS__.transformCallback(e=>{if(e.message)window[arguments[0]].push(e.message);});', name);
    return h.evaluate('return "__CHANNEL__:"+window[arguments[0]+"Id"]', name);
  };
  // Explicit ordinary compatibility fixture for legacy relink/recovery contracts.
  const bootstrap=path.join(output,'bootstrap');await fs.mkdir(bootstrap);
  let opened = await invoke('create_project', { path: bootstrap, name: 'Native collaboration copy' });
  await invoke('close_project',{projectId:opened.snapshot.document.projectId,expectedRevision:0,runtimeNonce:opened.collaboration.runtimeNonce,discard:true});
  await fs.writeFile(path.join(source,'project.json'),JSON.stringify(opened.snapshot.document));
  opened=await invoke('open_project',{path:path.join(source,'project.json')});
  let snapshot = opened.snapshot, nonce;
  const expected = () => ({ projectId: snapshot.document.projectId, expectedRevision: snapshot.document.revision, runtimeNonce: nonce });
  const adopt = transition => {
    opened = transition.opened ?? transition;
    snapshot = opened.snapshot;
    nonce = opened.collaboration?.runtimeNonce;
    if (transition.status) assert.equal(nonce, transition.status.runtimeNonce);
  };
  const addCategory = async name => { snapshot = await invoke('apply_change', { ...expected(), change: { type: 'addCategory', category: { id: crypto.randomUUID(), name, color: '#aabbcc' } } }); };
  const save = async () => invoke('save_project', expected());
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const s = await invoke('collaboration_status');
      if (!s.busy) return s;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Native worker did not finish');
  };
  const importChannel = await channel('mediaEvents');
  const importTask=await invoke('import_media', { projectId: snapshot.document.projectId, paths: [path.resolve('tests/fixtures/audio/mono16.wav')], onEvent: importChannel });
  await h.until('window.mediaEvents.some(e=>e.type==="finished")');
  const media = await h.evaluate('return window.mediaEvents.find(e=>e.type==="ready")?.media');
  assert.ok(media);
  snapshot = await invoke('apply_change', { ...expected(), change: { type: 'importMedia', media } });
  await invoke('release_media_import',{taskId:importTask,mediaId:media.id});
  await addCategory('creator'); await save();
  const sourceBytes = await fs.readFile(path.join(source, 'project.json'));
  nonce = (await invoke('collaboration_status')).runtimeNonce;
  adopt(await invoke('collaboration_create', { expected: expected(), operationId: crypto.randomUUID(), target: shared, credentials: { login: 'alice', displayName: 'Alice', password: 'password123' }, onProgress: await channel('copyEvents') }));
  assert.equal(opened.collaboration.identityMode, 'local');
  assert.deepEqual(await fs.readFile(path.join(source, 'project.json')), sourceBytes);
  const defaultManifest = JSON.parse(await fs.readFile(path.join(shared, 'collaboration.json')));
  const fields=['id','displayName','sourceRef','sha256','byteLength','sampleRate','frameCount','channelCount','channelLayout'];
  const publicManifest={...defaultManifest,formatVersion:1,media:snapshot.document.media.map(m=>Object.fromEntries(fields.map(k=>[k,m[k]])))};
  delete publicManifest.catalogVersion; // Format1 has inline media, not the format2 catalog discriminator.
  await save();await settle();await invoke('close_project',{...expected(),discard:false});
  // Only the freshly created, uniquely owned copy is transformed into an explicit format1 fixture.
  for(const directory of ['accounts','annotations']){const target=path.join(shared,directory);assert.ok(path.relative(output,target)&&!path.relative(output,target).startsWith('..'));await fs.rm(target,{recursive:true});await fs.mkdir(target);}
  await fs.writeFile(path.join(shared,'collaboration.json'),JSON.stringify(publicManifest));
  adopt(await invoke('open_project',{path:path.join(shared,'collaboration.json')}));
  adopt(await invoke('collaboration_identity',{expected:expected(),operationId:crypto.randomUUID(),action:{type:'register',login:'alice',displayName:'Alice',password:'password123'}}));
  await addCategory('creator');await save();await settle();
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(shared, publicManifest.media[0].sourceRef))).digest('hex'), media.sha256);
  assert.ok((await h.evaluate('return window.copyEvents')).some(e => e.phase === 'copyMedia'));
  report.checks.push('explicit ordinary source → default copied media/progress and source immutability; explicit format1 fixture then covers legacy guest/recovery compatibility');
  await assert.rejects(invoke('apply_change', { projectId: snapshot.document.projectId, expectedRevision: snapshot.document.revision, change: { type: 'removeMedia', mediaId: media.id } }));
  await assert.rejects(invoke('import_media', { ...expected(), paths: ['unused.wav'], onEvent: importChannel }));
  const owner = expected();
  adopt(await invoke('collaboration_identity', { expected: expected(), operationId: crypto.randomUUID(), action: { type: 'logout' } }));
  assert.equal(opened.collaboration.actor, null); assert.equal(snapshot.document.categories.length, 0);
  await assert.rejects(invoke('get_project_snapshot', owner));
  await addCategory('guest-local'); await save(); await settle();
  const guest = expected();
  await assert.rejects(invoke('collaboration_identity', { expected: expected(), operationId: crypto.randomUUID(), action: { type: 'login', login: 'alice', password: 'wrongpass' } }));
  assert.equal((await invoke('collaboration_status')).runtimeNonce, guest.runtimeNonce);
  adopt(await invoke('collaboration_identity', { expected: expected(), operationId: crypto.randomUUID(), action: { type: 'register', login: 'bob', displayName: 'Bob', password: 'password123' } }));
  assert.equal(snapshot.document.categories.length, 0);
  adopt(await invoke('collaboration_publish_guest', { expected: expected(), operationId: crypto.randomUUID() }));
  assert.equal(snapshot.document.categories[0].name, 'guest-local');
  await save(); await settle();
  let synced = await invoke('collaboration_refresh', { expected: expected() });
  assert.equal(synced.snapshot.authors.filter(a => a.layer).length, 2);
  assert.equal(synced.pending, false);
  assert.ok(!JSON.stringify(synced).includes('password'));
  await assert.rejects(invoke('apply_change', { ...guest, change: { type: 'addCategory', category: { id: crypto.randomUUID(), name: 'stale', color: '#aabbcc' } } }));
  const playbackBefore = await invoke('playback_status', { runtimeNonce: nonce });
  await assert.rejects(invoke('playback_configure', { runtimeNonce: guest.runtimeNonce, request: { projectId: snapshot.document.projectId, mediaId: media.id, mode: { mode: 'original' }, bypass: false, looping: false, volume: 0.99, deviceId: null, seekSeconds: null, play: true } }));
  await assert.rejects(invoke('playback_control', { runtimeNonce: guest.runtimeNonce, action: 'reset' }));
  assert.deepEqual(await invoke('playback_status', { runtimeNonce: nonce }), playbackBefore);
  await assert.rejects(invoke('register_analysis_view', { projectId: snapshot.document.projectId, runtimeNonce: guest.runtimeNonce }));
  const viewId = await invoke('register_analysis_view', { projectId: snapshot.document.projectId, runtimeNonce: nonce });
  await invoke('retire_analysis_view', { projectId: snapshot.document.projectId, runtimeNonce: nonce, viewId });
  report.checks.push('logout guest, wrong-password preservation, register Bob, native guest copy, independent author layers, stale-owner rejection, catalog guard, credential-free status');
  report.checks.push('delayed previous identity playback configure/control and analysis lease registration reject; current playback status unchanged');
  await invoke('collaboration_preferences', { expected: expected(), preferences: { volume: 0.3, deviceId: null, loopEnabled: true, source: 'original' } });
  const manifest = path.join(shared, 'collaboration.json'), hidden = path.join(shared, 'owned-offline.json');
  await fs.rename(manifest, hidden);
  try {
    await addCategory('offline'); await save(); await settle();
    const offline = await invoke('collaboration_refresh', { expected: expected() });
    assert.equal(offline.pending, true); assert.ok(offline.error); assert.equal(offline.snapshot.authors.filter(a => a.layer).length, 2);
  } finally { await fs.rename(hidden, manifest); }
  synced = await invoke('collaboration_refresh', { expected: expected() });
  assert.equal(synced.pending, false);
  // A real Windows ACL failure on this fixture's author directory, not a mock
  // IPC error. Restore the exact DACL in finally; do not touch shared/user paths.
  const authorDirectory = path.join(shared, 'annotations', synced.actor.authorId);
  const ps = script => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';${script}`], { encoding: 'utf8', windowsHide: true }).trim();
  const quoted = authorDirectory.replaceAll("'", "''");
  const dacl = ps(`(Get-Acl -LiteralPath '${quoted}').Sddl`);
  try {
    ps(`$a=Get-Acl -LiteralPath '${quoted}';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$r=[Security.AccessControl.FileSystemAccessRule]::new($s,[Security.AccessControl.FileSystemRights]'CreateFiles,CreateDirectories',[Security.AccessControl.AccessControlType]::Deny);$a.AddAccessRule($r);Set-Acl -LiteralPath '${quoted}' -AclObject $a`);
    await addCategory('durable-readonly'); await save(); await settle();
    const readonly = await invoke('collaboration_refresh', { expected: expected() });
    assert.equal(readonly.pending, true); assert.ok(readonly.error);
    assert.equal(snapshot.document.categories.at(-1).name, 'durable-readonly');
  } finally {
    ps(`$a=Get-Acl -LiteralPath '${quoted}';$a.SetSecurityDescriptorSddlForm('${dacl.replaceAll("'", "''")}');Set-Acl -LiteralPath '${quoted}' -AclObject $a`);
  }
  assert.equal(ps(`(Get-Acl -LiteralPath '${quoted}').Sddl`), dacl);
  synced = await invoke('collaboration_refresh', { expected: expected() });
  assert.equal(synced.pending, false);
  report.checks.push('real owned Windows DACL denies shared author writes; native save remains durable/pending; exact DACL restoration permits retry');
  await invoke('close_project', { ...expected(), discard: false });
  adopt(await invoke('open_project', { path: manifest }));
  assert.equal(opened.collaboration.actor, null);
  adopt(await invoke('collaboration_identity', { expected: expected(), operationId: crypto.randomUUID(), action: { type: 'login', login: 'bob', password: 'password123' } }));
  assert.equal(opened.collaboration.preferences.volume, 0.3);
  assert.equal(snapshot.document.categories.length, 3);
  report.checks.push('native offline local save, retained layers and pending; restore owned fixture, reconnect publish, close/reopen/login restores Bob preferences and own content');
  const relinkTask=await invoke('relink_media', { ...expected(), mediaId: media.id, path: path.resolve('tests/fixtures/audio/mono16.wav'), onEvent: await channel('relinkEvents') });
  await h.until('window.relinkEvents.some(e=>e.type==="finished")');
  const relinked = await h.evaluate('return window.relinkEvents.find(e=>e.type==="ready")?.media');
  assert.ok(relinked);
  snapshot = await invoke('apply_change', { ...expected(), change: { type: 'relinkMedia', media: relinked } });
  await invoke('release_media_import',{taskId:relinkTask,mediaId:relinked.id});
  const privateEdit = crypto.randomUUID();
  snapshot = await invoke('apply_change', { ...expected(), change: { type: 'addEdit', edit: { id: privateEdit, region: { mediaId: media.id, channelIndex: 0, startSeconds: 0, endSeconds: media.frameCount / media.sampleRate / 2, lowHz: 10, highHz: 100 }, enabled: true, processingVersion: 1 } } });
  await save(); await settle();
  const exchange = async (command, args) => {
    await invoke(command, { ...args, onEvent: await channel('exchangeEvents') });
    await h.until('window.exchangeEvents.some(e=>e.type!=="progress")');
    const event = await h.evaluate('return window.exchangeEvents.find(e=>e.type!=="progress")');
    assert.equal(event.type, 'completed', JSON.stringify(event));
    return event;
  };
  const copiedMedia = path.join(shared, publicManifest.media[0].sourceRef), hiddenMedia = `${copiedMedia}.owned-offline`;
  const jsonPath = path.join(output, 'own.json'), zipPath = path.join(output, 'own.zip');
  await fs.rename(copiedMedia, hiddenMedia);
  try {
    await exchange('export_annotations', { expected: expected(), path: jsonPath });
    await exchange('export_bundle', { expected: expected(), path: zipPath });
  } finally { await fs.rename(hiddenMedia, copiedMedia); }
  const exported = await fs.readFile(jsonPath, 'utf8');
  for (const secret of ['sourceRef', 'password', privateEdit, 'creator', local, source]) assert.ok(!exported.includes(secret), secret);
  assert.deepEqual(JSON.parse(exported).edits, []);
  const imported = await exchange('import_exchange', { expected: expected(), source: zipPath, parent: output });
  adopt(imported.opened);
  assert.equal(snapshot.document.edits.length, 0);
  assert.equal(snapshot.document.categories.length, 3);
  assert.equal(snapshot.document.media[0].sha256, media.sha256);
  report.checks.push('validated private relink supplies bundle bytes while shared original is unavailable; JSON and imported ZIP contain only own labels with no masks, paths or credentials; default imported copy remains usable');
  await invoke('close_project', { ...expected(), discard: false });
  const rootKeys = await fs.readdir(path.join(local, 'collaboration'));
  const sharedKeys=[];for(const key of rootKeys)if(await fs.access(path.join(local,'collaboration',key,publicManifest.projectId)).then(()=>true,()=>false))sharedKeys.push(key);assert.equal(sharedKeys.length,1);
  const guestCache = path.join(local, 'collaboration', sharedKeys[0], publicManifest.projectId, 'guest');
  await fs.writeFile(path.join(guestCache, 'workspace.json'), '{ owned recovery fault');
  adopt(await invoke('open_project', { path: manifest }));
  assert.equal(snapshot, null);
  assert.ok(opened.recovery);
  const recoveryNonce = nonce;
  await assert.rejects(invoke('collaboration_refresh', { expected: { runtimeNonce: nonce, projectId: publicManifest.projectId, expectedRevision: 0 } }));
  adopt(await invoke('resolve_recovery', { runtimeNonce: nonce, source: 'recovery' }));
  assert.notEqual(nonce, recoveryNonce);
  assert.equal(snapshot.document.categories[0].name, 'guest-local');
  await assert.rejects(invoke('get_project_snapshot', { projectId: snapshot.document.projectId, runtimeNonce: recoveryNonce }));
  await invoke('close_project', { ...expected(), discard: false });
  report.checks.push('owned private-primary corruption returns recovery without active snapshot; refresh is gated, full-envelope recovery returns an atomically bound new nonce and preserved guest content');
  const accounts = await fs.readdir(path.join(shared, 'accounts'));
  const account = accounts.find(n => n.endsWith('.json'));
  await assert.rejects(invoke('open_project', { path: path.join(shared, 'accounts', account) }));
  await assert.rejects(fs.access(path.join(shared, 'accounts/.project.lock')));
  report.checks.push('unknown account JSON cannot create a project lock in shared directory');
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { await h?.quit(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
