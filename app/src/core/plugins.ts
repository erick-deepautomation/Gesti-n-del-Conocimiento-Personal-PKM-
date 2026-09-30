// Sistema de complementos: archivos JavaScript en `.pkm/plugins/<id>.js`
// que exportan `default function (api) { ... }`. Solo se cargan los
// habilitados explícitamente en Ajustes → Complementos.

import type { App } from './app';
import { notice } from '../ui/modals';
import { h, iconButton } from './util';

export interface PluginAPI {
  app: App;
  addCommand(cmd: { id: string; name: string; hotkey?: string; run: () => unknown }): void;
  addRibbonIcon(icon: string, title: string, onClick: () => void): void;
  addStatusBarItem(): HTMLElement;
  onEvent: App['events']['on'];
  notice(msg: string): void;
  vault: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    files(): string[];
    search: App['backend']['search'];
  };
}

type Cleanup = () => void;

export class PluginManager {
  private loaded = new Map<string, Cleanup[]>();
  constructor(private app: App, private ribbon: () => HTMLElement, private statusBar: () => HTMLElement) {}

  async available(): Promise<string[]> {
    const idx = await this.app.backend.readConfig('plugins/index.json');
    try {
      return idx ? (JSON.parse(idx) as string[]) : [];
    } catch {
      return [];
    }
  }

  async loadEnabled() {
    for (const id of this.app.settings.enabledPlugins) await this.load(id);
  }

  async load(id: string) {
    if (this.loaded.has(id)) return;
    const code = await this.app.backend.readConfig(`plugins/${id}.js`);
    if (!code) {
      notice(`Complemento no encontrado: ${id}`);
      return;
    }
    const cleanups: Cleanup[] = [];
    const api: PluginAPI = {
      app: this.app,
      addCommand: (c) => cleanups.push(this.app.commands.register({ ...c, id: `${id}:${c.id}` })),
      addRibbonIcon: (icon, title, onClick) => {
        const b = iconButton(icon, title, onClick, 'ribbon-button');
        this.ribbon().append(b);
        cleanups.push(() => b.remove());
      },
      addStatusBarItem: () => {
        const el = h('div.status-bar-item');
        this.statusBar().prepend(el);
        cleanups.push(() => el.remove());
        return el;
      },
      onEvent: ((k: any, fn: any) => {
        const off = this.app.events.on(k, fn);
        cleanups.push(off);
        return off;
      }) as App['events']['on'],
      notice,
      vault: {
        read: (p) => this.app.backend.read(p),
        write: (p, c) => this.app.writeFile(p, c),
        files: () => this.app.files.map((f) => f.path),
        search: (q, l) => this.app.backend.search(q, l),
      },
    };
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      const mod = await import(/* @vite-ignore */ url);
      const unload = await mod.default?.(api);
      if (typeof unload === 'function') cleanups.push(unload);
      this.loaded.set(id, cleanups);
    } catch (e) {
      notice(`Error en el complemento ${id}: ${e}`);
      cleanups.forEach((c) => c());
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  unload(id: string) {
    this.loaded.get(id)?.forEach((c) => c());
    this.loaded.delete(id);
  }

  isLoaded(id: string) {
    return this.loaded.has(id);
  }
}
