import { beforeEach, expect, it, vi } from 'vitest';
const { invoke }=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke,Channel:class {onmessage:unknown}}));
import { exchangeClient, parseExportPreview } from './exchange';
const id='00000000-0000-4000-8000-000000000001',token='00000000-0000-4000-8000-000000000002';
const preview=()=>({token,runtimeNonce:id,projectId:id,documentRevision:7,organizationRevision:3,bundle:true,preserveFolders:true,directories:['audio/','audio/_CON/'],mediaPaths:{[id]:'audio/中文.wav'},changes:[{kind:'folder',id,originalPath:'audio/CON/',plannedPath:'audio/_CON/'}]});
beforeEach(()=>invoke.mockReset());
it('validates exact preview shape, binding revisions, Unicode safe physical paths and adjustments',()=>{
 expect(parseExportPreview(preview())).toEqual(preview());
 for(const mutate of [(p:any)=>p.extra=1,(p:any)=>delete p.organizationRevision,(p:any)=>p.documentRevision=-1,(p:any)=>p.token='x',(p:any)=>p.mediaPaths[id]='audio/../bad.wav',(p:any)=>p.directories.push('audio/CON/'),(p:any)=>p.mediaPaths[id]='audio/COM¹.wav',(p:any)=>p.mediaPaths[id]='audio/'+'长'.repeat(241),(p:any)=>p.changes[0].extra=1,(p:any)=>p.directories.push('audio/_con/'),(p:any)=>p.mediaPaths[id]='audio/missing/name.wav']){const p=preview();mutate(p);expect(()=>parseExportPreview(p)).toThrow();}
});
it('gets native default preserved preview before export and sends only its opaque acceptance token',async()=>{
 invoke.mockResolvedValueOnce(preview()).mockResolvedValueOnce('task');
 const expected={projectId:id,expectedRevision:7,runtimeNonce:id};
 await expect(exchangeClient.start({kind:'bundle',expected,path:'D:/out.zip'},()=>{})).resolves.toBe('task');
 expect(invoke.mock.calls[0]).toEqual(['export_path_preview',{expected,bundle:true,preserveFolders:true}]);
 expect(invoke.mock.calls[1][0]).toBe('export_bundle');expect(invoke.mock.calls[1][1]).toMatchObject({previewToken:token,expected,path:'D:/out.zip'});expect(invoke.mock.calls[1][1]).not.toHaveProperty('mediaPaths');
});
it('rejects foreign runtime, project, document and mode replies before starting output',async()=>{
 for(const change of [{runtimeNonce:token},{projectId:token},{documentRevision:8},{bundle:false},{preserveFolders:false}]){
 invoke.mockReset();invoke.mockResolvedValueOnce({...preview(),...change});
 await expect(exchangeClient.start({kind:'bundle',expected:{projectId:id,expectedRevision:7,runtimeNonce:id},path:'x'},()=>{})).rejects.toThrow();expect(invoke).toHaveBeenCalledTimes(1);
 }
});
