// Getting a show and its audio into and out of a browser tab.
//
// The desktop stores audio paths RELATIVE TO THE SHOW FILE, so a show and its
// audio folder move between machines as a unit (docs/API.md). A browser has no
// filesystem, so the closest honest equivalent is a directory handle: the
// operator picks the folder the show lives in once, and relative paths resolve
// against it exactly as they do on the desktop.
//
// That works on Chromium. Everywhere else the fallback is picking files by
// hand, which cannot resolve a relative path at all and matches on basename
// instead. The difference is visible in the UI rather than papered over,
// because "I could not find this file" and "you have not given me permission
// to look" are different problems with different fixes.
//
// One promise deliberately NOT carried over: the desktop writes a show to a
// temp file and moves it into place, so a pulled USB stick mid-save cannot
// destroy it. A browser cannot do that. Chromium's writable stream commits on
// close, which is close, but the download fallback has no atomicity at all —
// so the UI never repeats the desktop's claim.

export interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

export interface FileSystemHandleLike {
  kind: 'file' | 'directory';
  name: string;
  queryPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export interface FileHandleLike extends FileSystemHandleLike {
  kind: 'file';
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: BufferSource | Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

export interface DirectoryHandleLike extends FileSystemHandleLike {
  kind: 'directory';
  getDirectoryHandle: (name: string) => Promise<DirectoryHandleLike>;
  getFileHandle: (name: string) => Promise<FileHandleLike>;
}

interface PickerWindow {
  showOpenFilePicker?: (opts?: {
    types?: FilePickerAcceptType[];
    multiple?: boolean;
  }) => Promise<FileHandleLike[]>;
  showSaveFilePicker?: (opts?: {
    types?: FilePickerAcceptType[];
    suggestedName?: string;
  }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>;
}

const picker = window as unknown as PickerWindow;

export function hasFileSystemAccess(): boolean {
  return typeof picker.showOpenFilePicker === 'function';
}

export function hasDirectoryAccess(): boolean {
  return typeof picker.showDirectoryPicker === 'function';
}

const showType: FilePickerAcceptType = {
  description: 'SimpleCue show',
  accept: { 'application/json': ['.cueshow'] },
};

const bundleType: FilePickerAcceptType = {
  description: 'webcue bundle',
  accept: { 'application/zip': ['.cueshowpack'] },
};

/** Cancelling a picker rejects with AbortError, which is not an error the
    operator needs told about. */
export function wasCancelled(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export async function pickShowFile(): Promise<{ file: File; handle: FileHandleLike | null } | null> {
  if (!picker.showOpenFilePicker) return null;

  const [handle] = await picker.showOpenFilePicker({ types: [showType], multiple: false });
  if (!handle) return null;

  return { file: await handle.getFile(), handle };
}

export async function pickBundleFile(): Promise<File | null> {
  if (!picker.showOpenFilePicker) return null;

  const [handle] = await picker.showOpenFilePicker({ types: [bundleType], multiple: false });
  return handle ? await handle.getFile() : null;
}

export async function pickSaveHandle(suggestedName: string): Promise<FileHandleLike | null> {
  if (!picker.showSaveFilePicker) return null;
  return picker.showSaveFilePicker({ types: [showType], suggestedName });
}

export async function pickDirectory(): Promise<DirectoryHandleLike | null> {
  if (!picker.showDirectoryPicker) return null;
  return picker.showDirectoryPicker({ mode: 'read' });
}

export async function writeFile(handle: FileHandleLike, data: string | Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

/** Falls back to a download when there is no handle to write through. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking immediately can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type PermissionOutcome = 'granted' | 'denied' | 'unsupported';

/** A stored handle stays valid across sessions but its permission does not, so
    it has to be re-granted — which is why "not granted" is its own state and
    not lumped in with "missing". */
export async function ensurePermission(
  handle: FileSystemHandleLike,
  mode: 'read' | 'readwrite' = 'read',
): Promise<PermissionOutcome> {
  if (!handle.queryPermission || !handle.requestPermission) return 'unsupported';

  if ((await handle.queryPermission({ mode })) === 'granted') return 'granted';
  return (await handle.requestPermission({ mode })) === 'granted' ? 'granted' : 'denied';
}

/** Walks a show-relative path against a directory handle. Separators are split
    on both kinds, because a show written on Windows holds backslashes and the
    codec deliberately does not rewrite them. */
export async function resolveInDirectory(
  dir: DirectoryHandleLike,
  relativePath: string,
): Promise<File | null> {
  const parts = relativePath.split(/[/\\]/).filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0) return null;

  let current = dir;

  try {
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i]!);
    }

    const handle = await current.getFileHandle(parts[parts.length - 1]!);
    return await handle.getFile();
  } catch {
    return null;
  }
}

//== Remembering handles ======================================================
// A FileSystemHandle survives structured cloning, so IndexedDB can hold one
// between sessions. localStorage cannot: it is strings only.

const DB_NAME = 'webcue';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function rememberHandle(key: string, handle: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Private windows and blocked site data both land here. Remembering a
    // folder is a convenience, so failing to is not worth telling anyone about.
  }
}

export async function recallHandle<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();

    const value = await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => reject(request.error);
    });

    db.close();
    return value;
  } catch {
    return null;
  }
}

export async function forgetHandle(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // As above.
  }
}
