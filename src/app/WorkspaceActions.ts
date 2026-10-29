import type { IdentityController } from '../features/identity/controller';
import { annotationDisabled } from '../features/collaboration/capabilities';
import { collaborationMenu } from '../features/collaboration/CollaborationMenu';
import type { CollaborationUI } from '../features/collaboration/useCollaboration';
import { classificationMenu } from '../features/annotations/classification';
import type { WorkspaceMenu } from './AppMenu';
import type { ProjectLifecycleUI } from '../features/project/useProjectLifecycle';
import { projectMenuItems } from '../features/project/ProjectActions';
import type { MediaUI } from '../features/media/useMedia';
import type { ExchangeUI } from '../features/exchange/useExchange';
import type { AnnotationUI } from '../features/annotations/useAnnotations';
import type { SelectionUI } from '../features/selection/useSelection';
import type { WorkspaceUI } from '../features/spectrogram/useWorkspace';
import type { PlaybackUI } from '../features/playback/usePlayback';
import { duration } from '../features/spectrogram/workspace';
import { zoomViewport } from '../features/spectrogram/viewport';
import { resolveRegion } from '../features/selection/actions';
import type { HelpTopic } from './HelpDialog';
export function workspaceMenus({identity,collaboration,project,mediaUI,exchange,annotations,selection,workspace,playback,mediaOpen,propertiesOpen,toggleMedia,toggleProperties,settings,globalSettings,inspector,devices,help,focusNote}: {
 identity?:IdentityController;collaboration?:CollaborationUI;project?:ProjectLifecycleUI;mediaUI?:MediaUI;exchange?:ExchangeUI;annotations:AnnotationUI;selection:SelectionUI;workspace:WorkspaceUI;playback:PlaybackUI;mediaOpen:boolean;propertiesOpen:boolean;toggleMedia:()=>void;toggleProperties:()=>void;settings:(id:string)=>void;globalSettings?:()=>void;inspector:(tab:string)=>void;devices?:(trigger:HTMLElement|null)=>void;help:(topic:HelpTopic)=>void;focusNote:(id:string)=>void;
}):WorkspaceMenu[]{
 const owner=project?.active,doc=owner?.store.snapshot.document,disabled=!owner||owner.store.editingDisabled;
 const target=selection.selection,region=owner&&target?resolveRegion(owner,target):null;
 const media=doc?.media.find(m=>m.id===(selection.context?.mediaId??workspace.state.activeMediaId));
 const view=media?workspace.view(media.id):null, regionDisabled=disabled||!region;
 const pair=doc?.media.filter(m=>m.id===workspace.state.activeMediaId||m.id===workspace.state.compareMediaId)??[];
 const timeLimit=media?(workspace.state.linkedTime?Math.max(duration(media),...pair.map(duration)):duration(media)):0;
 const guard=(action:()=>void)=>()=>{if(owner&&!owner.store.editingDisabled)action();};
 const patch=(p:Parameters<WorkspaceUI['patch']>[1])=>{if(media)workspace.patch(media.id,p);};
 const reset=()=>{if(media)patch({startSeconds:0,endSeconds:duration(media),lowHz:0,highHz:media.sampleRate/2});};
 const ready=!!region&&mediaUI?.statuses.some(s=>s.mediaId===region.mediaId&&s.status==='ready');
 return [
  {id:'file',label:'文件',items:project?projectMenuItems({project,onImport:mediaUI?.choose,onImportFolder:mediaUI?.chooseSourceFolder,onImportZip:mediaUI?.chooseSourceZip,sourceDisabled:mediaUI?.sourceDisabled,importDisabled:mediaUI?.disabled,exchange,onCreateCollaboration:collaboration?()=>void collaboration.show('create'):undefined}):[{id:'new',label:'新建项目',disabled:true}]},
  {id:'edit',label:'编辑',items:[
   {id:'undo',label:'撤销',disabled:disabled||!owner?.store.snapshot.canUndo,action:()=>annotations.history('undo')},
   {id:'redo',label:'重做',disabled:disabled||!owner?.store.snapshot.canRedo,action:()=>annotations.history('redo')},
   {id:'clear',label:'清除当前选区',disabled:regionDisabled,action:guard(selection.cancel)},
   ...(target?.object?[{id:'remove',label:target.object.kind==='annotation'?'删除标注':'删除屏蔽',disabled:regionDisabled||target.object.kind==='annotation'&&annotationDisabled(owner),action:()=>{void selection.actions?.remove(target);}}]:[])]},
  {id:'view',label:'视图',items:[
   {id:'single',label:'单文件',checked:!workspace.state.compareMediaId,disabled:disabled||!media,action:()=>workspace.compare(null)},
   {id:'compare',label:'双文件对比',disabled:disabled||(workspace.visibleMedia??doc?.media??[]).length<2,children:(workspace.visibleMedia??doc?.media)?.map(m=>({id:m.id,label:m.displayName,checked:workspace.state.compareMediaId===m.id,action:()=>workspace.compare(m.id)}))},
   ...(['horizontal','vertical'] as const).map(layout=>({id:layout,label:layout==='horizontal'?'左右对比':'上下对比',checked:workspace.state.compareLayout===layout,disabled:disabled||!workspace.state.compareMediaId,action:()=>workspace.layout(layout)})),
   {id:'linked',label:'联动时间轴',checked:workspace.state.linkedTime,disabled:disabled||!workspace.state.compareMediaId,action:()=>workspace.link(!workspace.state.linkedTime)},
   {id:'files',label:'音频列表',checked:mediaOpen,action:toggleMedia}, {id:'properties',label:'属性面板',checked:propertiesOpen,action:toggleProperties},
   {id:'zoom',label:'放大到选区',disabled:regionDisabled,action:()=>selection.withTarget(target,r=>workspace.patch(r.mediaId,{startSeconds:r.startSeconds,endSeconds:r.endSeconds,lowHz:r.lowHz,highHz:r.highHz}))},
   {id:'out',label:'缩小视图',disabled:disabled||!media,action:()=>{if(view&&media){const time=zoomViewport(view,timeLimit,media.sampleRate/2,'time',.5,2);const frequency=zoomViewport(view,timeLimit,media.sampleRate/2,'frequency',.5,2);patch({startSeconds:time.startSeconds,endSeconds:time.endSeconds,lowHz:frequency.lowHz,highHz:frequency.highHz});}}},
   {id:'reset',label:'重置当前视图',title:'Ctrl+0',disabled:disabled||!media,action:reset},
   {id:'kind',label:'频谱类型',disabled:disabled||!media,children:([{id:'stft',label:'STFT 频谱'},{id:'mel',label:'梅尔频谱'}] as const).map(k=>({...k,checked:view?.spectrumKind===k.id,action:()=>patch({spectrumKind:k.id})}))},
   {id:'global-settings',label:'全局播放与显示设置…',disabled:!globalSettings,action:()=>globalSettings?.()},
   {id:'settings',label:'分析 / 显示设置…',disabled:disabled||!media,action:()=>{if(media)settings(media.id);}}]},
  {id:'annotation',label:'标注',items:[
   {id:'category',label:'标注类型',disabled:regionDisabled||annotationDisabled(owner),children:[{id:'none',label:'清空标签',keepOpen:true,checked:false,action:()=>{if(target)void selection.actions?.classify(target,null);}},...(annotations.categories??doc?.categories??[]).map(c=>({id:c.id,label:c.name,keepOpen:true,checked:doc?.annotations.find(a=>a.id===target?.object?.id)?.categoryIds.includes(c.id)??false,action:()=>{if(target)void selection.actions?.classify(target,c.id);}}))]},
   {id:'note',label:'备注',disabled:regionDisabled||annotationDisabled(owner),action:()=>{if(target)void selection.actions?.note(target,focusNote);}},
   ...(doc ? [classificationMenu(doc, media ? { mediaId: media.id, channelIndex: null } : null, annotations.classify, '当前文件分类', annotationDisabled(owner), annotations.categories ?? doc.categories), classificationMenu(doc, media && view && (selection.context?.channelIndex ?? view.visibleChannels[0]) !== undefined ? { mediaId: media.id, channelIndex: selection.context?.channelIndex ?? view.visibleChannels[0] } : null, annotations.classify, '当前通道分类', annotationDisabled(owner), annotations.categories ?? doc.categories)] : []),
   {id:'categories',label:'类别管理',disabled,action:()=>inspector('categories')}, {id:'list',label:'标注列表',disabled,action:()=>inspector('list')}]},
  {id:'audio',label:'音频',items:[
   {id:'toggle',label:playback.playing?'暂停':'播放',disabled:disabled||!playback.media,action:guard(playback.toggle)},
   {id:'whole',label:'播放整段',disabled:disabled||!playback.media,action:guard(playback.playFile)},
   ...(['original','processed'] as const).map(source=>({id:source,label:source==='original'?'原音':'暂存编辑',checked:playback.workspaceSource===source,disabled,action:guard(()=>playback.updateWorkspaceSource(source))})),
   {id:'play',label:'播放选区',disabled:regionDisabled||!ready,action:()=>selection.withTarget(target,r=>playback.playSelection(r))},
   ...(['original','processed'] as const).map(source=>({id:'audition-'+source,label:source==='original'?'试听选区原音':'试听选区（应用屏蔽）',disabled:regionDisabled||!ready,action:()=>selection.withTarget(target,r=>playback.playSelection(r,source))})),
   {id:'mask',label:'屏蔽选区',disabled:regionDisabled,action:()=>{if(target)void selection.actions?.mask(target);}},
   {id:'devices',label:'输出设备…',disabled,action:trigger=>devices?.(trigger??null)}, {id:'mix',label:'通道混音',disabled:disabled||!playback.media,action:()=>inspector('mix')}]},
  ...(collaboration?[collaborationMenu(collaboration,identity,project?.busy)]:[]),
  {id:'help',label:'帮助',items:([{id:'shortcuts',label:'快捷键'},{id:'guide',label:'使用说明'},{id:'about',label:'版本与第三方声明'}] as const).map(t=>({...t,action:()=>help(t.id)}))},
 ];
}
