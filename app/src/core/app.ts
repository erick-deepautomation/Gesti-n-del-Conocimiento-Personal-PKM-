import type { Backend, ChangeEvent, FileInfo, TagCount, VaultInfo } from '../backend/types';
import { confirmDialog, notice, promptText } from '../ui/modals';
import { Workspace, type Leaf, type OpenOptions } from '../ui/workspace';
import { Commands } from './commands';
import { Resolver } from './resolver';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import {
  Emitter, basename, debounce, dirname, extname, formatDate, isNote, joinPath, sanitizeName, stripExt, titleOf,
} from './util';

export interface AppEvents {
  'vault-opened': VaultInfo;
  'files-changed': void;
  modified: { path: string };
  'active-changed': { path: string | null; leaf: Leaf | null };
  renamed: { pairs: [string, string][] };
  deleted: { paths: string[] };
  settings: void;
  bookmarks: void;
  external: ChangeEvent;
  'reveal-file': { path: string };
  'search-request': { query: string };
}

/** Estado central de la aplicación: bóveda, archivos, ajustes, espacio de trabajo. */
export class App {
  readonly events = new Emitter<AppEvents>();
  readonly commands = new Commands();
  readonly resolver = new Resolver();
  readonly workspace: Workspace;
  vault: VaultInfo | null = null;
  files: FileInfo[] = [];
  folders = new Set<string>();
  settings: Settings = { ...DEFAULT_SETTINGS };
  bookmarks: string[] = [];
  recent: string[] = [];
  private tagsCached: TagCount[] | null = null;

  constructor(readonly backend: Backend) {
    this.workspace = new Workspace(this);
    this.events.on('modified', () => (this.tagsCached = null));
    this.events.on('files-changed', () => (this.tagsCached = null));
    backend.onExternalChange((ev) => void this.handleExternal(ev));
  }

  // ------------------------------------------------------------ bóveda

  async loadVault(info: VaultInfo) {
    this.vault = info;
    this.setFiles(info.files, info.folders);
    const raw = await this.backend.readConfig('settings.json');
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this.commands.overrides = this.settings.hotkeys;
    try {
      this.bookmarks = JSON.parse((await this.backend.readConfig('bookmarks.json')) ?? '[]');
    } catch {
      this.bookmarks = [];
    }
    try {
      this.recent = JSON.parse((await this.backend.readConfig('recent.json')) ?? '[]');
    } catch {
      this.recent = [];
    }
    this.applyAppearance();
    this.events.emit('vault-opened', info);
  }

  private setFiles(files: FileInfo[], folders: string[]) {
    this.files = files;
    this.folders = new Set(folders);
    for (const f of files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
    }
    this.resolver.setFiles(files);
  }

  async refreshFiles() {
    const [files, folders] = await Promise.all([this.backend.files(), this.backend.folders()]);
    this.setFiles(files, folders);
    this.events.emit('files-changed', undefined);
  }
  refreshFilesSoon = debounce(() => void this.refreshFiles(), 60);

  private async handleExternal(ev: ChangeEvent) {
    await this.refreshFiles();
    this.events.emit('external', ev);
    for (const l of this.workspace.leaves()) l.view.onExternalChange([...ev.changed, ...ev.removed]);
  }

  async tagCache(): Promise<TagCount[]> {
    this.tagsCached ??= await this.backend.tags();
    return this.tagsCached;
  }

  // ------------------------------------------------------------ ajustes y apariencia

  saveSettings = debounce(async () => {
    await this.backend.writeConfig('settings.json', JSON.stringify(this.settings, null, 2));
  }, 300);

  updateSettings(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    this.commands.overrides = this.settings.hotkeys;
    this.applyAppearance();
    this.saveSettings();
    this.events.emit('settings', undefined);
    for (const l of this.workspace.leaves()) l.view.onSettingsChanged();
  }

  applyAppearance() {
    const s = this.settings;
    const dark = s.theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : s.theme === 'dark';
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-light', !dark);
    document.body.classList.toggle('readable-line-width', s.readableLineLength);
    document.body.classList.toggle('show-inline-title', s.showInlineTitle);
    const st = document.body.style;
    st.setProperty('--accent', s.accent);
    st.setProperty('--font-text-size', s.fontSize + 'px');
    if (s.fontFamily) st.setProperty('--font-text', s.fontFamily);
    else st.removeProperty('--font-text');
    localStorage.setItem('nexo.theme', dark ? 'dark' : 'light');
    let css = document.getElementById('user-css') as HTMLStyleElement | null;
    if (!css) {
      css = document.createElement('style');
      css.id = 'user-css';
      document.head.append(css);
    }
    css.textContent = s.cssSnippet;
  }

  saveWorkspaceSoon = debounce(() => {
    void this.backend.writeConfig('workspace.json', JSON.stringify(this.workspace.serialize()));
  }, 800);

  // ------------------------------------------------------------ navegación

  activePath(): string | null {
    return this.workspace.activeLeaf()?.view.path() ?? null;
  }

  viewTypeFor(path: string) {
    const ext = extname(path);
    if (ext === 'md') return 'markdown';
    if (ext === 'canvas') return 'canvas';
    return 'file';
  }

  async open(path: string, opts: OpenOptions & { line?: number; subpath?: string; mode?: 'edit' | 'read' } = {}) {
    const { line, subpath, mode, ...o } = opts;
    const leaf = await this.workspace.openState({ type: this.viewTypeFor(path), state: { path, line, subpath, mode } }, o);
    this.pushRecent(path);
    this.saveWorkspaceSoon();
    return leaf;
  }

  private pushRecent(path: string) {
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 50);
    void this.backend.writeConfig('recent.json', JSON.stringify(this.recent));
  }

  /** Abre el destino de un enlace (`Nota#Encabezado`), creándolo si no existe. */
  async openLinkText(href: string, source: string, opts: OpenOptions = {}) {
    const hash = href.indexOf('#');
    const target = hash >= 0 ? href.slice(0, hash) : href;
    const subpath = hash >= 0 ? href.slice(hash + 1) : undefined;
    let path = target ? this.resolver.resolve(target, source) : source;
    if (!path) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        window.open(target, '_blank', 'noopener');
        return;
      }
      // Crear la nota en la carpeta indicada (o en la carpeta por defecto).
      const clean = target.replace(/\.md$/i, '');
      const folder = clean.includes('/') ? dirname(clean) : this.newNoteFolder(source);
      path = await this.createNote(folder, basename(clean), '', false);
    }
    await this.open(path, { ...opts, subpath });
  }

  newNoteFolder(source?: string | null) {
    const f = this.settings.newNoteFolder;
    if (f === '.' && source) return dirname(source);
    return f;
  }

  searchFor(query: string) {
    this.events.emit('search-request', { query });
  }

  // ------------------------------------------------------------ operaciones de archivo

  uniquePath(folder: string, base: string, ext: string) {
    let name = sanitizeName(base) || 'Sin título';
    let p = joinPath(folder, `${name}.${ext}`);
    let n = 1;
    while (this.resolver.exists(p)) p = joinPath(folder, `${name} ${n++}.${ext}`);
    return p;
  }

  async createNote(folder = this.newNoteFolder(this.activePath()), name = 'Sin título', content = '', open = true): Promise<string> {
    const path = this.uniquePath(folder, name, 'md');
    await this.backend.write(path, content);
    this.resolver.add(path);
    await this.refreshFiles();
    if (open) await this.open(path, { mode: 'edit' });
    return path;
  }

  async createCanvas(folder = this.newNoteFolder(this.activePath())) {
    const path = this.uniquePath(folder, 'Lienzo sin título', 'canvas');
    await this.backend.write(path, JSON.stringify({ nodes: [], edges: [] }, null, 2));
    await this.refreshFiles();
    await this.open(path);
    return path;
  }

  async createFolder(parent = '') {
    const name = await promptText('Nueva carpeta', '', 'Nombre de la carpeta');
    if (!name) return;
    const path = joinPath(parent, sanitizeName(name));
    await this.backend.createFolder(path);
    this.folders.add(path);
    await this.refreshFiles();
  }

  async writeFile(path: string, content: string) {
    await this.backend.write(path, content);
    const known = this.resolver.exists(path);
    if (!known) {
      this.resolver.add(path);
      this.refreshFilesSoon();
    }
    this.events.emit('modified', { path });
  }

  async rename(oldPath: string, newPath: string) {
    if (oldPath === newPath) return;
    for (const l of this.workspace.leaves()) await l.view.beforeLeave();
    try {
      const res = await this.backend.rename(oldPath, newPath);
      await this.refreshFiles();
      for (const l of this.workspace.leaves()) {
        l.renamePath(oldPath, newPath);
        l.view.onRename(oldPath, newPath);
      }
      this.bookmarks = this.bookmarks.map((b) => (b === oldPath ? newPath : b.startsWith(oldPath + '/') ? newPath + b.slice(oldPath.length) : b));
      void this.saveBookmarks();
      await this.updateCanvasRefs(res.moved);
      this.events.emit('renamed', { pairs: res.moved });
      for (const e of res.edited) this.events.emit('modified', { path: e });
      for (const l of this.workspace.leaves()) l.view.onExternalChange(res.edited);
      if (res.edited.length) notice(`Enlaces actualizados en ${res.edited.length} nota(s)`);
      this.saveWorkspaceSoon();
    } catch (e) {
      notice(String(e));
    }
  }

  /** Los lienzos (.canvas) referencian archivos por ruta: actualizarlos tras mover/renombrar. */
  private async updateCanvasRefs(moved: [string, string][]) {
    const map = new Map(moved.map(([o, n]) => [o.toLowerCase(), n]));
    const open = new Set(this.workspace.leaves().filter((l) => l.view.type === 'canvas').map((l) => l.view.path()));
    for (const f of this.files) {
      if (extname(f.path) !== 'canvas' || open.has(f.path)) continue;
      try {
        const data = JSON.parse(await this.backend.read(f.path));
        let touched = false;
        for (const n of data.nodes ?? []) {
          const target = n.file && map.get(String(n.file).toLowerCase());
          if (target) {
            n.file = target;
            touched = true;
          }
        }
        if (touched) await this.backend.write(f.path, JSON.stringify(data, null, '\t'));
      } catch {
        /* lienzo no válido: se ignora */
      }
    }
  }

  async promptRename(path: string) {
    const isFolder = this.folders.has(path) && !this.resolver.exists(path);
    const current = isFolder ? basename(path) : isNote(path) ? titleOf(path) : basename(path);
    const name = await promptText(isFolder ? 'Renombrar carpeta' : 'Renombrar archivo', current);
    if (!name || name === current) return;
    const clean = sanitizeName(name);
    const newPath = joinPath(dirname(path), isFolder || !isNote(path) ? clean : clean + '.md');
    await this.rename(path, newPath);
  }

  async move(path: string, folder: string) {
    const newPath = joinPath(folder, basename(path));
    if (newPath === path || folder === path || folder.startsWith(path + '/')) return;
    await this.rename(path, newPath);
  }

  async delete(path: string) {
    const isFolder = this.folders.has(path) && !this.resolver.exists(path);
    if (this.settings.confirmDelete) {
      const ok = await confirmDialog(
        isFolder ? 'Eliminar carpeta' : 'Eliminar archivo',
        `¿Mover «${basename(path)}»${isFolder ? ' y todo su contenido' : ''} a la papelera (.trash)?`,
        'Eliminar',
        true,
      );
      if (!ok) return;
    }
    const removed = await this.backend.delete(path);
    await this.refreshFiles();
    for (const l of [...this.workspace.leaves()]) {
      const p = l.view.path();
      if (p && (removed.includes(p) || p === path)) this.workspace.closeLeaf(l);
    }
    this.bookmarks = this.bookmarks.filter((b) => b !== path && !b.startsWith(path + '/'));
    void this.saveBookmarks();
    this.events.emit('deleted', { paths: removed });
  }

  async saveAttachment(file: File, source: string): Promise<string> {
    const ext = extname(file.name) || (file.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg');
    const base = file.name && !/^image\.\w+$/.test(file.name) ? stripExt(file.name) : `Imagen pegada ${formatDate(new Date(), 'YYYYMMDDHHmmss')}`;
    let folder = this.settings.attachmentFolder;
    if (folder === '.' || folder.startsWith('./')) folder = joinPath(dirname(source), folder.slice(2));
    const path = this.uniquePath(folder, base, ext);
    await this.backend.writeBinary(path, new Uint8Array(await file.arrayBuffer()));
    this.resolver.add(path);
    await this.refreshFiles();
    return path;
  }

  // ------------------------------------------------------------ notas diarias y plantillas

  applyTemplate(tpl: string, title: string) {
    const now = new Date();
    return tpl
      .replace(/{{\s*title\s*}}/g, title)
      .replace(/{{\s*date(?::([^}]+))?\s*}}/g, (_m, f) => formatDate(now, (f ?? this.settings.dateFormat).trim()))
      .replace(/{{\s*time(?::([^}]+))?\s*}}/g, (_m, f) => formatDate(now, (f ?? this.settings.timeFormat).trim()));
  }

  async dailyNote(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const name = formatDate(d, this.settings.dailyFormat);
    const path = joinPath(this.settings.dailyFolder, name + '.md');
    if (!this.resolver.exists(path)) {
      let tpl = '';
      const t = this.settings.dailyTemplate && this.resolver.resolve(this.settings.dailyTemplate, '');
      if (t) tpl = this.applyTemplate(await this.backend.read(t), name);
      await this.backend.write(path, tpl);
      await this.refreshFiles();
    }
    await this.open(path);
  }

  /** Nota diaria adyacente a la activa (anterior/siguiente existente). */
  async adjacentDaily(dir: 1 | -1) {
    const folder = this.settings.dailyFolder;
    const daily = this.files.filter((f) => f.isNote && dirname(f.path) === folder).map((f) => f.path).sort();
    const cur = this.activePath();
    const i = cur ? daily.indexOf(cur) : -1;
    const next = i < 0 ? daily[dir > 0 ? 0 : daily.length - 1] : daily[i + dir];
    if (next) await this.open(next);
    else notice('No hay más notas diarias');
  }

  templates(): string[] {
    const folder = this.settings.templatesFolder;
    return this.files.filter((f) => f.isNote && (f.path.startsWith(folder + '/') || !folder)).map((f) => f.path);
  }

  // ------------------------------------------------------------ marcadores

  async saveBookmarks() {
    await this.backend.writeConfig('bookmarks.json', JSON.stringify(this.bookmarks));
    this.events.emit('bookmarks', undefined);
  }

  toggleBookmark(path: string) {
    if (this.bookmarks.includes(path)) this.bookmarks = this.bookmarks.filter((b) => b !== path);
    else this.bookmarks.push(path);
    void this.saveBookmarks();
  }
}
