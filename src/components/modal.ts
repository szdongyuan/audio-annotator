/** Native dialogs can be open without being in the browser's modal top layer. */
export function isNativeModal(dialog: HTMLDialogElement): boolean {
  if (!dialog.open) return false;
  try { return dialog.matches(':modal'); } catch { return true; }
}
