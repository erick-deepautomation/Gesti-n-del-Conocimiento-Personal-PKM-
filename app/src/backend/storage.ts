// Almacenamiento para la versión web: IndexedDB (siempre disponible) o una
// carpeta real del disco mediante File System Access API (Chromium/Edge).

export interface StoredEntry {
  path: string;
  dir: boolean;
  mtime: number;
  size: number;
}

export interface Storage {
  readonly label: string;
  list(): Promise<StoredEntry[]>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Blob>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array | Blob): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ IndexedDB

interface IdbRecord {
  path: string;
  dir: boolean;
  mtime: number;
  size: number;
  data?: string | Blob;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function openDb(name: string, store = 'files', keyPath: string | null = 'path'): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(store)) {
        r.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class IdbStorage implements Storage {
  readonly label: string;
  private constructor(private db: IDBDatabase, name: string) {
    this.label = name;
  }

  static async open(vault = 'default'): Promise<IdbStorage> {
    return new IdbStorage(await openDb(`nexo-vault-${vault}`), 'Bóveda del navegador');
  }

  private tx(mode: IDBTransactionMode) {
    return this.db.transaction('files', mode).objectStore('files');
  }

  async list(): Promise<StoredEntry[]> {
    const all = (await req(this.tx('readonly').getAll())) as IdbRecord[];
    return all.map(({ path, dir, mtime, size }) => ({ path, dir, mtime, size }));
  }

  private async get(path: string): Promise<IdbRecord | undefined> {
    return (await req(this.tx('readonly').get(path))) as IdbRecord | undefined;
  }

  async readText(path: string) {
    const r = await this.get(path);
    if (!r || r.dir) throw new Error(`No existe: ${path}`);
    return typeof r.data === 'string' ? r.data : await (r.data as Blob).text();
  }

  async readBinary(path: string) {
    const r = await this.get(path);
    if (!r || r.dir) throw new Error(`No existe: ${path}`);
    return typeof r.data === 'string' ? new Blob([r.data]) : (r.data as Blob);
  }

  private async ensureParents(path: string) {
    let p = parentOf(path);
    const store = this.tx('readwrite');
    while (p) {
      store.put({ path: p, dir: true, mtime: Date.now(), size: 0 });
      p = parentOf(p);
    }
  }

  async writeText(path: string, content: string) {
    await this.ensureParents(path);
    await req(this.tx('readwrite').put({ path, dir: false, mtime: Date.now(), size: content.length, data: content }));
  }

  async writeBinary(path: string, data: Uint8Array | Blob) {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
    await this.ensureParents(path);
    await req(this.tx('readwrite').put({ path, dir: false, mtime: Date.now(), size: blob.size, data: blob }));
  }

  async mkdir(path: string) {
    await this.ensureParents(path + '/x');
  }

  async remove(path: string) {
    const all = await this.list();
    const store = this.tx('readwrite');
    for (const e of all) if (e.path === path || e.path.startsWith(path + '/')) store.delete(e.path);
    await new Promise((r) => (store.transaction.oncomplete = r));
  }

  async rename(oldPath: string, newPath: string) {
    const all = (await req(this.tx('readonly').getAll())) as IdbRecord[];
    const moving = all.filter((e) => e.path === oldPath || e.path.startsWith(oldPath + '/'));
    await this.ensureParents(newPath);
    const store = this.tx('readwrite');
    for (const e of moving) {
      store.delete(e.path);
      store.put({ ...e, path: newPath + e.path.slice(oldPath.length) });
    }
    await new Promise((r) => (store.transaction.oncomplete = r));
  }

  async exists(path: string) {
    return !!(await this.get(path));
  }
}

// ------------------------------------------------------------------ File System Access API

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  queryPermission?(o: { mode: string }): Promise<PermissionState>;
  requestPermission?(o: { mode: string }): Promise<PermissionState>;
};

export const fsAccessSupported = () => typeof (window as any).showDirectoryPicker === 'function';

export class FsAccessStorage implements Storage {
  readonly label: string;
  constructor(private root: DirHandle) {
    this.label = root.name;
  }

  static async pick(): Promise<FsAccessStorage | null> {
    try {
      const h = (await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'nexo-vault' })) as DirHandle;
      await saveHandle(h);
      return new FsAccessStorage(h);
    } catch {
      return null;
    }
  }

  /** Reabre la última carpeta; puede requerir un gesto del usuario para el permiso. */
  static async restore(interactive: boolean): Promise<FsAccessStorage | null> {
    const h = await loadHandle();
    if (!h) return null;
    let perm = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (perm !== 'granted' && interactive) perm = (await h.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
    return perm === 'granted' ? new FsAccessStorage(h) : null;
  }

  private async dir(path: string, create = false): Promise<DirHandle> {
    let d = this.root;
    for (const seg of path.split('/').filter(Boolean)) d = (await d.getDirectoryHandle(seg, { create })) as DirHandle;
    return d;
  }

  private async file(path: string, create = false): Promise<FileSystemFileHandle> {
    const d = await this.dir(parentOf(path), create);
    return d.getFileHandle(path.split('/').pop()!, { create });
  }

  async list(): Promise<StoredEntry[]> {
    const out: StoredEntry[] = [];
    const walk = async (d: DirHandle, prefix: string) => {
      const pending: Promise<void>[] = [];
      for await (const h of d.values()) {
        if (h.name.startsWith('.') && prefix === '' && h.name !== '.pkm' && h.name !== '.trash') continue;
        const p = prefix ? `${prefix}/${h.name}` : h.name;
        if (h.kind === 'directory') {
          out.push({ path: p, dir: true, mtime: 0, size: 0 });
          pending.push(walk(h as DirHandle, p));
        } else {
          pending.push(
            (h as FileSystemFileHandle).getFile().then((f) => {
              out.push({ path: p, dir: false, mtime: f.lastModified, size: f.size });
            }),
          );
        }
      }
      await Promise.all(pending);
    };
    await walk(this.root, '');
    return out;
  }

  async readText(path: string) {
    return (await (await this.file(path)).getFile()).text();
  }

  async readBinary(path: string) {
    return (await this.file(path)).getFile();
  }

  async writeText(path: string, content: string) {
    const w = await (await this.file(path, true)).createWritable();
    await w.write(content);
    await w.close();
  }

  async writeBinary(path: string, data: Uint8Array | Blob) {
    const w = await (await this.file(path, true)).createWritable();
    await w.write(data as any);
    await w.close();
  }

  async mkdir(path: string) {
    await this.dir(path, true);
  }

  async remove(path: string) {
    const d = await this.dir(parentOf(path));
    await d.removeEntry(path.split('/').pop()!, { recursive: true });
  }

  async rename(oldPath: string, newPath: string) {
    // Copia recursiva + borrado (el API aún no expone "move" de forma universal).
    const copy = async (from: string, to: string) => {
      let isDir = false;
      try {
        await this.dir(from);
        isDir = true;
      } catch {
        /* es archivo */
      }
      if (isDir) {
        await this.mkdir(to);
        const d = await this.dir(from);
        for await (const h of d.values()) await copy(`${from}/${h.name}`, `${to}/${h.name}`);
      } else {
        await this.writeBinary(to, await this.readBinary(from));
      }
    };
    await copy(oldPath, newPath);
    await this.remove(oldPath);
  }

  async exists(path: string) {
    try {
      await this.file(path);
      return true;
    } catch {
      try {
        await this.dir(path);
        return true;
      } catch {
        return false;
      }
    }
  }
}

async function saveHandle(h: DirHandle) {
  const db = await openDb('nexo-handles', 'handles', null);
  await req(db.transaction('handles', 'readwrite').objectStore('handles').put(h, 'last'));
}

async function loadHandle(): Promise<DirHandle | null> {
  try {
    const db = await openDb('nexo-handles', 'handles', null);
    return ((await req(db.transaction('handles', 'readonly').objectStore('handles').get('last'))) as DirHandle) ?? null;
  } catch {
    return null;
  }
}
