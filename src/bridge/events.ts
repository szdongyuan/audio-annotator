import type { AppError, Id } from './types';

/** Background work lives outside ProjectDocument, including terminal outcomes. */
export type TaskEvent =
  | { status: 'running'; taskId: Id; projectId: Id; mediaId: Id | null; generation: number; progress: number }
  | { status: 'completed' | 'cancelled'; taskId: Id; projectId: Id; generation: number }
  | { status: 'failed'; taskId: Id; projectId: Id; generation: number; error: AppError };
export type MediaRuntimeState = 'verifying' | 'ready' | 'missing' | 'failed';
