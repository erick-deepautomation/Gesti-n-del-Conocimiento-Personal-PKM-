import init, { Engine } from '../wasm-pkg/pkm.js';
import { FsAccessStorage, IdbStorage, fsAccessSupported, type Storage } from './storage';
import { SAMPLE_VAULT } from './sample';
import type {
  Backend, Backlink, ChangeEvent, FileInfo, Graph, GraphOptions, NoteMeta, RenameResult, SearchHit, Stats,
  SwitchHit, TagCount, Unresolved, VaultInfo, VaultTask,
} from './types';

const isNote = (p: string) => p.toLowerCase().endsWith('.md');
const hidden = (p: string) => p.split('/').some((s) => s.startsWith('.'));
const MODE_KEY = 'nexo.web.mode';

/**
 * Host web/PWA: el mismo núcleo Rust compilado a WebAssembly, con los archivos
 * en IndexedDB o en una carpeta real (File System Access API).
 */
export class WebBackend implements Backend {
  readonly kind = 'web' as const;
  private engine!: Engine;
  private store!: Storage;
  private folderSet = new Set<string>();
  private urls = new Map<string, string>();
  private listeners: ((ev: ChangeEvent) => void)[] = [];

  private async ready() {
    if (!this.engine) {
      await init();
      this.engine = new Engine();
    }
  }

  private async load(store: Storage, seed: boolean): Promise<VaultInfo> {
    await this.ready();
    const t0 = performance.now();
    this.store = store;
    this.engine.clear();
    this.folderSet.clear();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
    let entries = await store.list();
    if (seed && !entries.some((e) => !e.dir && !hidden(e.path))) {
      for (const [p, c] of Object.entries(SAMPLE_VAULT)) await store.writeText(p, c);
      entries = await store.list();
    }
    const notes = entries.filter((e) => !e.dir && !hidden(e.path) && isNote(e.path));
    const texts = await Promise.all(notes.map((e) => store.readText(e.path)));
    notes.forEach((e, i) => this.engine.upsertNote(e.path, texts[i], e.mtime));
    for (const e of entries) {
      if (hidden(e.path)) continue;
      if (e.dir) this.folderSet.add(e.path);
      else if (!isNote(e.path)) this.engine.addFile(e.path, e.mtime, e.size);
    }
    this.engine.unresolved(); // precalcula la resolución de enlaces
    return {
      root: store.label,
      name: store.label,
      files: this.engine.files(),
      folders: [...this.folderSet].sort(),
      stats: this.engine.stats(),
      elapsedMs: Math.round(performance.now() - t0),
    };
  }

  async init() {
    const mode = localStorage.getItem(MODE_KEY);
    if (mode === 'fs') {
      const s = await FsAccessStorage.restore(false);
      if (s) return this.load(s, false);
      return null; // requiere gesto del usuario para volver a conceder permiso
    }
    if (mode === 'idb') return this.load(await IdbStorage.open(), true);
    return null;
  }

  openModes() {
    const m: { id: 'pick' | 'default'; label: string; hint: string }[] = [];
    if (fsAccessSupported()) {
      m.push({ id: 'pick', label: 'Abrir carpeta del disco', hint: 'Edita tus archivos .md reales (Chrome/Edge). Compatible con bóvedas de Obsidian' });
    }
    m.push({ id: 'default', label: 'Bóveda en el navegador', hint: 'Se guarda en IndexedDB; funciona sin conexión y en móviles' });
    return m;
  }

  async openVault(mode: 'pick' | 'default' = 'default') {
    if (mode === 'pick') {
      const s = (await FsAccessStorage.restore(true)) ?? (await FsAccessStorage.pick());
      if (!s) return null;
      localStorage.setItem(MODE_KEY, 'fs');
      return this.load(s, false);
    }
    localStorage.setItem(MODE_KEY, 'idb');
    return this.load(await IdbStorage.open(), true);
  }

  async files(): Promise<FileInfo[]> { return this.engine.files(); }
  async folders() { return [...this.folderSet].sort(); }

  async read(path: string) {
    return this.engine.content(path) ?? (await this.store.readText(path));
  }

  private addFolders(path: string) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.folderSet.add(parts.slice(0, i).join('/'));
  }

  async write(path: string, content: string) {
    await this.store.writeText(path, content);
    this.addFolders(path);
    if (isNote(path)) this.engine.upsertNote(path, content, Date.now());
    else this.engine.addFile(path, Date.now(), content.length);
  }

  async writeBinary(path: string, data: Uint8Array) {
    await this.store.writeBinary(path, data);
    this.addFolders(path);
    this.engine.addFile(path, Date.now(), data.length);
  }

  async resourceUrl(path: string) {
    let u = this.urls.get(path);
    if (!u) {
      u = URL.createObjectURL(await this.store.readBinary(path));
      this.urls.set(path, u);
    }
    return u;
  }

  async createFolder(path: string) {
    await this.store.mkdir(path);
    this.addFolders(path + '/x');
  }

  async delete(path: string) {
    const trash = `.trash/${path.split('/').pop()}`;
    if (await this.store.exists(trash)) await this.store.remove(trash);
    await this.store.rename(path, trash);
    if (this.folderSet.has(path)) {
      for (const f of [...this.folderSet]) if (f === path || f.startsWith(path + '/')) this.folderSet.delete(f);
      return this.engine.removeFolder(path) as string[];
    }
    this.engine.remove(path);
    return [path];
  }

  async rename(oldPath: string, newPath: string): Promise<RenameResult> {
    if (await this.store.exists(newPath)) throw new Error(`Ya existe: ${newPath}`);
    await this.store.rename(oldPath, newPath);
    this.urls.delete(oldPath);
    let moved: [string, string][];
    let edits: { path: string; content: string }[];
    if (this.folderSet.has(oldPath)) {
      [moved, edits] = this.engine.renameFolder(oldPath, newPath);
      for (const f of [...this.folderSet]) {
        if (f === oldPath || f.startsWith(oldPath + '/')) {
          this.folderSet.delete(f);
          this.folderSet.add(newPath + f.slice(oldPath.length));
        }
      }
      this.addFolders(newPath + '/x');
    } else {
      moved = [[oldPath, newPath]];
      edits = this.engine.rename(oldPath, newPath);
      this.addFolders(newPath);
    }
    for (const e of edits) await this.store.writeText(e.path, e.content);
    return { moved, edited: edits.map((e) => e.path) };
  }

  async readConfig(name: string) {
    try {
      return await this.store.readText(`.pkm/${name}`);
    } catch {
      return null;
    }
  }

  async writeConfig(name: string, content: string) {
    await this.store.writeText(`.pkm/${name}`, content);
  }

  async search(q: string, limit: number): Promise<SearchHit[]> { return this.engine.search(q, limit); }
  async quickSwitch(q: string, limit: number): Promise<SwitchHit[]> { return this.engine.quickSwitch(q, limit); }
  async meta(path: string): Promise<NoteMeta | null> { return this.engine.meta(path) ?? null; }
  async backlinks(path: string): Promise<Backlink[]> { return this.engine.backlinks(path); }
  async unlinkedMentions(path: string): Promise<Backlink[]> { return this.engine.unlinkedMentions(path); }
  async unresolved(): Promise<Unresolved[]> { return this.engine.unresolved(); }
  async tags(): Promise<TagCount[]> { return this.engine.tags(); }
  async tasks(includeDone: boolean): Promise<VaultTask[]> { return this.engine.tasks(includeDone); }
  async propertyKeys(): Promise<TagCount[]> { return this.engine.propertyKeys(); }
  async graph(opts: GraphOptions): Promise<Graph> { return this.engine.graph(opts); }
  async localGraph(path: string, depth: number, opts: GraphOptions): Promise<Graph> { return this.engine.localGraph(path, depth, opts); }
  async stats(): Promise<Stats> { return this.engine.stats(); }

  onExternalChange(cb: (ev: ChangeEvent) => void) {
    this.listeners.push(cb);
  }
}
