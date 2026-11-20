/** Folder rows expose an empty value for the root and an ID for a folder. */
export type FolderHit = { folderId: string | null };
export function folderAtPoint(x: number, y: number): FolderHit | null {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-folder]');
    return row ? { folderId: row.dataset.dropFolder || null } : null;
}
export function physicalFolderAtPoint(x: number, y: number, scale = window.devicePixelRatio || 1): FolderHit | null {
    return folderAtPoint(x / scale, y / scale);
}
