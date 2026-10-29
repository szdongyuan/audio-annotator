import { inspectionClient, type InspectionBinding, type InspectionPreview } from '../../bridge/inspection';
import type { RuntimeCommands } from '../../bridge/runtime';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import type { ActiveProject } from '../project/useProjectLifecycle';

/** Canvas can read only this preview's tiles/status. All project mutations are denied. */
export function inspectionProject(result: InspectionPreview, binding: InspectionBinding): ActiveProject {
 const deny = async () => { throw { code: 'InvalidInput', message: '查看窗口只读', retryable: false }; };
 const forbidden = <T extends object>(): T => new Proxy({} as T, { get: (target, key) => key === 'then' ? undefined : Object.hasOwn(target, key) ? Reflect.get(target, key) : deny });
 const store = new ProjectStore(result.snapshot);
 const queue = new CommandQueue(store, { applyChange: deny, getSnapshot: deny, undo: deny, redo: deny } satisfies ProjectCommands);
 const lifecycle = new ProjectLifecycle(store, queue, { save: deny, close: deny });
 const commands: RuntimeCommands = { project: forbidden(), projects: forbidden(), folders: forbidden(), sources: forbidden(), playback: forbidden(),
  tiles: inspectionClient.tiles(binding, result.previewId), media: Object.assign(forbidden<RuntimeCommands['media']>(), { status: () => inspectionClient.status(binding, result.previewId) }) };
 return { store, queue, lifecycle, path: '', commands };
}
