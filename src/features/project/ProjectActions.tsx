import { Plus, Save } from 'lucide-react';
import type { ProjectLifecycleUI } from './useProjectLifecycle';
import type { ExchangeUI } from '../exchange/useExchange';
import type { MenuItem } from '../../components/menu/menuModel';
type Props = { onCreateCollaboration?: () => void; project: ProjectLifecycleUI; onImport?: () => void; onImportFolder?: (returnFocus?:HTMLElement|null) => void; onImportZip?: (returnFocus?:HTMLElement|null) => void; sourceDisabled?: boolean; importDisabled?: boolean; exchange?: ExchangeUI };
export function projectMenuItems({project,onImport,onImportFolder,onImportZip,sourceDisabled=false,importDisabled=true,exchange,onCreateCollaboration}:Props):MenuItem[]{
 const busy=project.busy||!!project.recovery||!!project.active?.store.editingDisabled;
 return [
  {id:'new',label:'新建项目',disabled:busy,action:()=>{void project.open('create');}},
  {id:'open',label:'打开项目…',disabled:busy,action:()=>{void project.open('open');}},
  {id:'open-view',label:'只读打开项目…',disabled:busy,action:()=>{void project.open('viewOnly');}},
  {id:'save',label:'保存',disabled:busy||!project.active,action:()=>{void project.save();}},
  {id:'save-as',label:'另存我的项目副本…',disabled:busy||!project.active,action:()=>{void project.saveAs();}},
  {id:'import',label:'导入音频',disabled:busy||project.active?.collaboration?.canImportMedia===false||importDisabled,action:onImport},
  {id:'import-folder',label:'导入文件夹…',disabled:busy||sourceDisabled||project.active?.collaboration?.canImportMedia===false||importDisabled||!onImportFolder,action:onImportFolder},
  {id:'import-zip-audio',label:'导入 ZIP 音频…',disabled:busy||sourceDisabled||importDisabled||!onImportZip,action:onImportZip},
  {id:'import-share',label:'导入分享文件…',disabled:busy||!exchange,action:returnFocus=>exchange?.show('import',returnFocus)},
  {id:'export',label:project.active?.collaboration?'导出我的标注 / 项目包…':'分享项目…',disabled:busy||!project.active||!exchange,action:returnFocus=>exchange?.show('export',returnFocus)},
  ...(onCreateCollaboration&&project.active&&!project.active.collaboration?[{id:'collaboration-create',label:'创建协作副本…',disabled:busy||!project.active||!!project.active.collaboration,action:onCreateCollaboration}]:[]),
  {id:'close',label:'关闭项目',disabled:busy||!project.active,action:()=>{void project.close();}},
 ];
}
export function ProjectActions(props:Props){const items=projectMenuItems(props);return <nav className="project-actions" aria-label="项目操作"><button className="button button-quiet" disabled={items.find(i=>i.id==='save')?.disabled} onClick={e=>items.find(i=>i.id==='save')?.action?.(e.currentTarget)}><Save size={14}/>保存</button><button className="button button-quiet" disabled={items.find(i=>i.id==='import')?.disabled} onClick={e=>items.find(i=>i.id==='import')?.action?.(e.currentTarget)}><Plus size={14}/>导入音频</button></nav>;}
