// Paths come from the main process in the OS's own form, so the renderer
// has to read both separators: C:\Users\me\code and /home/me/code.

/** The last part of a path: the folder or file name. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? "";
}
