import { Plus, Save } from 'lucide-react';
import type { ProjectLifecycleUI } from './useProjectLifecycle';
import type { ExchangeUI } from '../exchange/useExchange';
import type { MenuItem } from '../../components/menu/menuModel';
type Props = { project: ProjectLifecycleUI; onImport?: () => void; onImportFolder?: () => void; importDisabled?: boolean; exchange?: ExchangeUI };
export function projectMenuItems({project,onImport,onImportFolder,importDisabled=true,exchange}:Props):MenuItem[]{
 const busy=project.busy||!!project.recovery||!!project.active?.store.editingDisabled;
 return [
  {id:'new',label:'新建项目',disabled:busy,action:()=>{void project.open('create');}},
  {id:'open',label:'打开项目…',disabled:busy,action:()=>{void project.open('open');}},
  {id:'save',label:'保存',disabled:busy||!project.active,action:()=>{void project.save();}},
  {id:'save-as',label:'项目另存为…',disabled:busy||!project.active,action:()=>{void project.saveAs();}},
  {id:'import',label:'导入音频',disabled:busy||importDisabled,action:onImport},
  {id:'import-folder',label:'导入文件夹…',disabled:busy||importDisabled||!onImportFolder,action:onImportFolder},
  {id:'import-share',label:'导入分享文件…',disabled:busy||!exchange,action:()=>exchange?.show('import')},
  {id:'export',label:'分享项目…',disabled:busy||!project.active||!exchange,action:()=>exchange?.show('export')},
  {id:'close',label:'关闭项目',disabled:busy||!project.active,action:()=>{void project.close();}},
 ];
}
export function ProjectActions(props:Props){const items=projectMenuItems(props);return <nav className="project-actions" aria-label="项目操作"><button className="button button-quiet" disabled={items[2].disabled} onClick={items[2].action}><Save size={14}/>保存</button><button className="button button-quiet" disabled={items[4].disabled} onClick={items[4].action}><Plus size={14}/>导入音频</button></nav>;}
