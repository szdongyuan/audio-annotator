import type { ActiveProject } from '../project/useProjectLifecycle';
export const annotationDisabled=(owner:ActiveProject|null|undefined)=>!owner||owner.store.editingDisabled||owner.collaboration?.canWriteAnnotations===false;
