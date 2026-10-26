import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ProjectLifecycleUI } from '../project/useProjectLifecycle';
import type { CollaborationUI } from '../collaboration/useCollaboration';
import { IdentityController } from './controller';
import { profileClient, type ProfileCommands } from '../../bridge/profiles';
export function useIdentity(project:ProjectLifecycleUI,collaboration:CollaborationUI,api:ProfileCommands=profileClient){
 const current=useRef({project,collaboration});current.current={project,collaboration};
 const controller=useMemo(()=>new IdentityController({owner:()=>current.current.project.active,perform:(owner,action,save)=>current.current.project.performIdentity(owner,action,save),acceptStatus:status=>current.current.collaboration.controller?.accept(status)},api),[api]);
 useSyncExternalStore(controller.subscribe,controller.getVersion);
 useEffect(()=>{controller.start();return()=>controller.dispose();},[controller]);
 useEffect(()=>{void controller.refresh();},[controller,project.active]);
 return controller;
}
