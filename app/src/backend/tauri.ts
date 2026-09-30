import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  Backend, Backlink, ChangeEvent, FileInfo, Graph, GraphOptions, NoteMeta, RenameResult, SearchHit, Stats,
  SwitchHit, TagCount, Unresolved, VaultInfo, VaultTask,
} from './types';

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Host nativo: todas las operaciones van al proceso Rust (índice paralelo + E/S directa). */
export class TauriBackend implements Backend {
  readonly kind = 'tauri' as const;
  private root = '';

  private async opened(path: string): Promise<VaultInfo> {
    const info = await invoke<VaultInfo>('open_vault', { path });
    this.root = info.root;
    return info;
  }

  async init() {
    const last = await invoke<string | null>('last_vault');
    if (last) {
      try {
        return await this.opened(last);
      } catch {
        return null;
      }
    }
    return null;
  }

  openModes() {
    const modes: { id: 'pick' | 'default'; label: string; hint: string }[] = [];
    if (!isMobile) modes.push({ id: 'pick', label: 'Abrir carpeta como bóveda', hint: 'Cualquier carpeta de Markdown, incluidas bóvedas de Obsidian' });
    modes.push({ id: 'default', label: 'Usar bóveda local', hint: 'Crea «Nexo Vault» en Documentos' });
    return modes;
  }

  async openVault(mode: 'pick' | 'default' = 'pick') {
    if (mode === 'default') return this.opened(await invoke<string>('default_vault'));
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, multiple: false, title: 'Elige la carpeta de la bóveda' });
    if (!dir || Array.isArray(dir)) return null;
    return this.opened(dir);
  }

  files() { return invoke<FileInfo[]>('list_files'); }
  folders() { return invoke<string[]>('list_folders'); }
  read(path: string) { return invoke<string>('read_note', { path }); }
  write(path: string, content: string) { return invoke<void>('write_note', { path, content }); }
  writeBinary(path: string, data: Uint8Array) { return invoke<void>('write_binary', { path, data: Array.from(data) }); }
  async resourceUrl(path: string) {
    const sep = this.root.includes('\\') ? '\\' : '/';
    return convertFileSrc(this.root + sep + path.split('/').join(sep));
  }
  createFolder(path: string) { return invoke<void>('create_folder', { path }); }
  delete(path: string) { return invoke<string[]>('delete_path', { path }); }
  rename(oldPath: string, newPath: string) { return invoke<RenameResult>('rename_path', { old: oldPath, new: newPath }); }
  readConfig(name: string) { return invoke<string | null>('read_config', { name }); }
  writeConfig(name: string, content: string) { return invoke<void>('write_config', { name, content }); }

  search(query: string, limit: number) { return invoke<SearchHit[]>('search', { query, limit }); }
  quickSwitch(query: string, limit: number) { return invoke<SwitchHit[]>('quick_switch', { query, limit }); }
  meta(path: string) { return invoke<NoteMeta | null>('meta', { path }); }
  backlinks(path: string) { return invoke<Backlink[]>('backlinks', { path }); }
  unlinkedMentions(path: string) { return invoke<Backlink[]>('unlinked_mentions', { path }); }
  unresolved() { return invoke<Unresolved[]>('unresolved'); }
  tags() { return invoke<TagCount[]>('tags'); }
  tasks(includeDone: boolean) { return invoke<VaultTask[]>('tasks', { includeDone }); }
  propertyKeys() { return invoke<TagCount[]>('property_keys'); }
  graph(opts: GraphOptions) { return invoke<Graph>('graph', { opts }); }
  localGraph(path: string, depth: number, opts: GraphOptions) { return invoke<Graph>('local_graph', { path, depth, opts }); }
  stats() { return invoke<Stats>('stats'); }

  onExternalChange(cb: (ev: ChangeEvent) => void) {
    void listen<ChangeEvent>('vault-changed', (e) => cb(e.payload));
  }
}
