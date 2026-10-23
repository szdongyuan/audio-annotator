// Generate a conservative inventory (includes Rust build/proc-macro dependencies).
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const result=spawnSync('cargo',['metadata','--format-version','1','--filter-platform','x86_64-pc-windows-msvc'],{encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});
if(result.status)throw Error(result.stderr);
const metadata=JSON.parse(result.stdout),lock=JSON.parse(await fs.readFile('package-lock.json','utf8'));
const entries=[];const target='licenses';await fs.mkdir(path.join(target,'sources'),{recursive:true});
for(const p of metadata.packages.filter(p=>p.source))entries.push({name:p.name,version:p.version,license:p.license,repository:p.repository,root:path.dirname(p.manifest_path),kind:'Rust (runtime or build)'});
for(const [location,p] of Object.entries(lock.packages).filter(([k,p])=>k&&!p.dev)) {
  const json=JSON.parse(await fs.readFile(path.join(location,'package.json'),'utf8'));
  entries.push({name:json.name,version:json.version,license:json.license,repository:json.repository?.url??json.repository,root:location,kind:'npm runtime'});
}
const notices=[`THIRD-PARTY NOTICES — Audio Annotator ${lock.version}`,'This file does not assign a license to Audio Annotator itself. See the project owner for distribution terms.','Unmodified Symphonia MPL-2.0 sources are distributed alongside this notice in sources/*.crate. Cargo .crate files are gzip-compressed tar archives.','Inventory is conservative: Rust build-time and procedural macro dependencies are included even when they do not ship executable code. FFmpeg, Selenium, and all other npm devDependencies are development-only and are not included in the application.',''];
const missing=[];
for(const p of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
  const files=(await fs.readdir(p.root)).filter(f=>/^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i.test(f));
  p.notices=[];
  for(const f of files) {const full=path.join(p.root,f);if((await fs.stat(full)).isFile()){p.notices.push(f);notices.push(`\n===== ${p.name} ${p.version} (${p.license}) — ${f} =====\n`,await fs.readFile(full,'utf8'));}}
  if(!p.notices.length) {
    const vcs=JSON.parse(await fs.readFile(path.join(p.root,'.cargo_vcs_info.json'),'utf8'));
    const repo=p.repository.replace(/\.git$/,'').replace('https://github.com/','https://raw.githubusercontent.com/');
    const fallback=path.join(target,'upstream',`${p.name}-${p.version}.txt`);
    let text=await fs.readFile(fallback,'utf8').catch(()=>null);
    if(!text) {
      for(const filename of ['LICENSE','LICENSE-MIT','LICENSE.md','COPYING','LICENSE.txt','LICENSE-MPL-2.0','LICENSE-APACHE']) {
        const url=`${repo}/${vcs.git.sha1}/${filename}`;
        const response=await fetch(url); if(response.ok) {text=`Source: ${url}\n\n${await response.text()}`;break;}
      }
      if(text){await fs.mkdir(path.dirname(fallback),{recursive:true});await fs.writeFile(fallback,text);}
    }
    if(text){p.notices.push(fallback);notices.push(`\n===== ${p.name} ${p.version} (${p.license}) =====\n`,text);}else missing.push(p.name);
  }
  if(p.license?.includes('MPL')) {
    const registry=path.dirname(path.dirname(p.root)),registryName=path.basename(path.dirname(p.root));
    const archive=path.join(path.dirname(registry),'cache',registryName,`${p.name}-${p.version}.crate`);
    await fs.copyFile(archive,path.join(target,'sources',path.basename(archive)));
  }
  delete p.root;
}
await fs.writeFile(path.join(target,'THIRD-PARTY-NOTICES.txt'),notices.join('\n'));
await fs.writeFile(path.join(target,'inventory.json'),JSON.stringify({generatedFor:'Windows x64; locked Cargo and npm dependencies',entries,missingNoticeFiles:missing},null,2));
console.log(JSON.stringify({packages:entries.length,missingNoticeFiles:missing}));
if(missing.length)throw Error(`Review missing third-party notices before distribution: ${missing.join(', ')}`);
