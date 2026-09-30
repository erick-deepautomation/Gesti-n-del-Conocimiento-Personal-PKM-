import type { App } from '../core/app';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, basename, extname, h, icon, modKey } from '../core/util';
import { View } from '../ui/workspace';

export class EmptyView extends View {
  readonly type = 'empty';
  constructor(app: App) {
    super(app);
    this.el.classList.add('empty-view');
    const action = (label: string, hk: string, cmd: string) =>
      h('div.empty-action', { onclick: () => void app.commands.run(cmd) }, label, h('span.empty-hotkey', hk));
    this.el.append(
      h('div.empty-state',
        h('div.empty-title', 'No hay ningún archivo abierto'),
        action('Crear nota nueva', `${modKey}+N`, 'file:new-note'),
        action('Ir a un archivo', `${modKey}+O`, 'switcher:open'),
        action('Abrir la nota diaria', `${modKey}+Shift+D`, 'daily:today'),
        action('Ver el grafo', `${modKey}+G`, 'graph:open'),
        action('Paleta de comandos', `${modKey}+P`, 'palette:open'),
      ),
    );
  }
  title() {
    return 'Nueva pestaña';
  }
  icon() {
    return 'plus';
  }
}

/** Visor de adjuntos: imágenes, PDF, audio, vídeo y otros. */
export class FileView extends View {
  readonly type = 'file';
  file: string | null = null;
  constructor(app: App) {
    super(app);
    this.el.classList.add('file-view');
  }
  title() {
    return this.file ? basename(this.file) : 'Archivo';
  }
  icon() {
    return this.file && IMAGE_EXT.has(extname(this.file)) ? 'image' : 'file';
  }
  path() {
    return this.file;
  }
  getState() {
    return { path: this.file };
  }
  async setState(st: Record<string, any>) {
    this.file = st.path;
    await this.render();
  }
  private async render() {
    if (!this.file) return;
    const ext = extname(this.file);
    const url = await this.app.backend.resourceUrl(this.file);
    let content: HTMLElement;
    if (IMAGE_EXT.has(ext)) content = h('img.file-image', { src: url, alt: basename(this.file) });
    else if (ext === 'pdf') content = h('iframe.file-pdf', { src: url });
    else if (VIDEO_EXT.has(ext)) content = h('video', { src: url, controls: true });
    else if (AUDIO_EXT.has(ext)) content = h('audio', { src: url, controls: true });
    else if (['txt', 'json', 'csv', 'js', 'ts', 'css', 'html', 'yml', 'yaml', 'xml', 'log'].includes(ext)) {
      content = h('pre.file-text', await this.app.backend.read(this.file).catch(() => ''));
    } else {
      content = h('div.file-unknown', icon('file', 48), h('p', basename(this.file)), h('a', { href: url, download: basename(this.file) }, 'Descargar'));
    }
    this.el.replaceChildren(h('div.file-wrap', content));
  }
  onRename(o: string, n: string) {
    if (this.file === o) {
      this.file = n;
      this.updateTitle();
    }
  }
}
