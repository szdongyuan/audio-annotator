import type { WorkspaceSoundVersion } from './playbackIntent';
export function PlaybackModeControl({source,disabled,onChange}:{source:WorkspaceSoundVersion;disabled:boolean;onChange:(source:WorkspaceSoundVersion)=>void}) {
 return <div className="audition-controls"><select aria-label="声音版本" disabled={disabled} value={source} onChange={e=>onChange(e.target.value as WorkspaceSoundVersion)}><option value="original">原音</option><option value="processed">暂存编辑</option></select></div>;
}
