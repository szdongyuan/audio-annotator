import { invoke } from '@tauri-apps/api/core';
const owned = new Set(['get_project_snapshot','apply_change','undo','redo','save_project','save_project_as','save_project_as_controlled','close_project','resolve_recovery','import_media','relink_media','media_status','scan_folder','scan_import_sources','playback_configure','playback_control','playback_status','request_tile','register_analysis_view','retire_analysis_view','cancel_generation']);
/** An immutable capability captured when OpenedProject is adopted, never global status. */
export function runtimeInvoke(runtimeNonce?:string):typeof invoke {
 if(!runtimeNonce)return invoke;
 return (command,args,options)=>invoke(command,runtimeNonce&&owned.has(command)?{...args,runtimeNonce}:args,options);
}
