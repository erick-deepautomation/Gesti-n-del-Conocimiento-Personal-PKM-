import type { App } from '../core/app';
import { debounce, dirname, fold, h, joinPath, sanitizeName, titleOf } from '../core/util';
import { createEditor, scrollToLine, type EditorHandle } from '../editor/editor';
import { headingId, renderMarkdown } from '../render/markdown';
import { attachHoverPreview, attachLinkHandlers } from '../ui/links';
import { notice } from '../ui/modals';
import { View } from '../ui/workspace';

/** Vista de nota: editor (vista previa en vivo / fuente) y modo lectura. */
export class MarkdownView extends View {
  readonly type = 'markdown';
  file: string | null = null;
  mode: 'edit' | 'read' = 'edit';
  editor: EditorHandle;
  private scroller: HTMLElement;
  private sizer: HTMLElement;
  private editorHost: HTMLElement;
  private readingEl: HTMLElement;
  private inlineTitle: HTMLElement;
  private dirty = false;
  private lastSaved = '';
  private saving: Promise<void> = Promise.resolve();
  private renderSeq = 0;
  private scheduleSave = debounce(() => void this.flush(), 400);

  constructor(app: App) {
    super(app);
    this.el.classList.add('markdown-view');
    this.inlineTitle = h('div.inline-title', { contenteditable: 'true', spellcheck: 'false', 'aria-label': 'Título de la nota' });
    this.inlineTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.editor.view.focus();
      }
    });
    this.inlineTitle.addEventListener('blur', () => void this.commitTitle());
    this.editorHost = h('div.md-editor-host');
    this.readingEl = h('div.md-reading');
    this.sizer = h('div.md-sizer', this.inlineTitle, this.editorHost, this.readingEl);
    this.scroller = h('div.md-scroller', this.sizer);
    this.el.append(this.scroller);
    this.editor = createEditor(this.editorHost, app, () => this.file ?? '', () => this.onEdit());
    attachLinkHandlers(app, this.readingEl, () => this.file ?? '');
    attachHoverPreview(app, this.editorHost, () => this.file ?? '', '.cm-wikilink-rendered, .cm-link-rendered', true);
    this.scroller.addEventListener('click', (e) => {
      // Clic en el espacio vacío bajo el texto → enfocar el final del editor.
      if (this.mode === 'edit' && e.target === this.scroller) {
        const v = this.editor.view;
        v.focus();
        v.dispatch({ selection: { anchor: v.state.doc.length } });
      }
    });
  }

  title() {
    return this.file ? titleOf(this.file) : 'Nota';
  }
  icon() {
    return 'file';
  }
  path() {
    return this.file;
  }
  getState() {
    return { path: this.file, mode: this.mode, scroll: this.scroller.scrollTop };
  }

  async setState(st: Record<string, any>) {
    const path = st.path as string;
    if (!path) return;
    if (path !== this.file) {
      await this.flush();
      let content = '';
      try {
        content = await this.app.backend.read(path);
      } catch {
        notice(`No se pudo abrir ${path}`);
      }
      this.file = path;
      this.lastSaved = content;
      this.dirty = false;
      this.editor.setDoc(content);
      this.editor.view.dispatch({ effects: [] });
      this.inlineTitle.textContent = titleOf(path);
    }
    const mode = (st.mode as 'edit' | 'read' | undefined) ?? (this.mode === 'read' ? 'read' : this.app.settings.defaultMode);
    await this.setMode(mode, false);
    this.updateTitle();
    requestAnimationFrame(() => {
      if (st.line != null) this.scrollToLine(st.line);
      else if (st.subpath) this.scrollToSubpath(st.subpath);
      else if (st.scroll) this.scroller.scrollTop = st.scroll;
      else this.scroller.scrollTop = 0;
    });
  }

  content() {
    return this.editor.view.state.doc.toString();
  }

  private onEdit() {
    this.dirty = true;
    this.scheduleSave();
  }

  async flush() {
    this.scheduleSave.cancel();
    if (!this.dirty || !this.file) return this.saving;
    const text = this.content();
    const path = this.file;
    this.dirty = false;
    this.saving = this.saving.then(async () => {
      if (text === this.lastSaved) return;
      try {
        await this.app.writeFile(path, text);
        this.lastSaved = text;
      } catch (e) {
        this.dirty = true;
        notice(`Error al guardar: ${e}`);
      }
    });
    return this.saving;
  }

  async beforeLeave() {
    await this.flush();
  }

  async setMode(mode: 'edit' | 'read', focus = true) {
    this.mode = mode;
    this.el.classList.toggle('is-reading', mode === 'read');
    this.editorHost.style.display = mode === 'edit' ? '' : 'none';
    this.readingEl.style.display = mode === 'read' ? '' : 'none';
    if (mode === 'read') {
      await this.flush();
      await this.renderReading();
    } else if (focus) {
      this.editor.view.focus();
    }
    this.leaf?.refreshTab();
  }

  async toggleMode() {
    // Conserva la posición aproximada (línea superior visible).
    const line = this.topLine();
    await this.setMode(this.mode === 'edit' ? 'read' : 'edit');
    requestAnimationFrame(() => this.scrollToLine(line, false));
  }

  private topLine(): number {
    const top = this.scroller.getBoundingClientRect().top + 10;
    if (this.mode === 'edit') {
      const v = this.editor.view;
      const pos = v.posAtCoords({ x: v.contentDOM.getBoundingClientRect().left + 5, y: Math.max(top, v.contentDOM.getBoundingClientRect().top) });
      return pos == null ? 0 : v.state.doc.lineAt(pos).number - 1;
    }
    const blocks = [...this.readingEl.querySelectorAll<HTMLElement>('[data-line]')];
    const b = blocks.find((x) => x.getBoundingClientRect().bottom > top);
    return b ? Number(b.dataset.line) : 0;
  }

  async renderReading() {
    if (!this.file) return;
    const my = ++this.renderSeq;
    const tmp = h('div');
    await renderMarkdown(this.app, tmp, this.content(), {
      sourcePath: this.file,
      showProperties: true,
      onToggleTask: (line, checked) => this.setTaskLine(line, checked),
    });
    if (my !== this.renderSeq) return;
    this.readingEl.replaceChildren(...tmp.childNodes);
    this.readingEl.className = 'md-reading markdown-rendered';
  }

  private setTaskLine(line: number, checked: boolean) {
    const doc = this.editor.view.state.doc;
    if (line + 1 > doc.lines) return;
    const l = doc.line(line + 1);
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/.exec(l.text);
    if (!m) return;
    const pos = l.from + m[1].length;
    this.editor.view.dispatch({ changes: { from: pos, to: pos + 1, insert: checked ? 'x' : ' ' } });
    void this.flush();
  }

  scrollToLine(line: number, select = true) {
    if (this.mode === 'edit') {
      scrollToLine(this.editor.view, line, select);
      return;
    }
    const blocks = [...this.readingEl.querySelectorAll<HTMLElement>('[data-line]')];
    let best: HTMLElement | null = null;
    for (const b of blocks) {
      if (Number(b.dataset.line) <= line) best = b;
      else break;
    }
    best?.scrollIntoView({ block: 'start' });
  }

  scrollToSubpath(sub: string) {
    const doc = this.editor.view.state.doc;
    if (sub.startsWith('^')) {
      const id = sub.slice(1);
      for (let i = 1; i <= doc.lines; i++) {
        const t = doc.line(i).text.trimEnd();
        if (t.endsWith(' ^' + id) || t === '^' + id) return this.flash(i - 1);
      }
      return;
    }
    const target = fold(sub.split('#').pop()!.trim());
    for (let i = 1; i <= doc.lines; i++) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(doc.line(i).text);
      if (m && fold(m[1]) === target) {
        if (this.mode === 'read') {
          this.readingEl.querySelector('#' + CSS.escape(headingId(m[1])))?.scrollIntoView({ block: 'start' });
          return;
        }
        return this.flash(i - 1);
      }
    }
  }

  private flash(line: number) {
    this.scrollToLine(line);
    if (this.mode === 'read') {
      const el = [...this.readingEl.querySelectorAll<HTMLElement>('[data-line]')].find((b) => Number(b.dataset.line) === line);
      el?.classList.add('is-flashing');
      setTimeout(() => el?.classList.remove('is-flashing'), 1200);
    }
  }

  private async commitTitle() {
    if (!this.file) return;
    const name = sanitizeName(this.inlineTitle.textContent ?? '');
    if (!name || name === titleOf(this.file)) {
      this.inlineTitle.textContent = titleOf(this.file);
      return;
    }
    const newPath = joinPath(dirname(this.file), name + '.md');
    if (this.app.resolver.exists(newPath) && newPath.toLowerCase() !== this.file.toLowerCase()) {
      notice('Ya existe una nota con ese nombre');
      this.inlineTitle.textContent = titleOf(this.file);
      return;
    }
    await this.app.rename(this.file, newPath);
  }

  focus() {
    if (this.mode === 'edit') {
      // Nota recién creada y vacía → enfocar el título para escribirlo.
      if (this.content() === '' && this.file && titleOf(this.file).startsWith('Sin título') && this.app.settings.showInlineTitle) {
        this.inlineTitle.focus();
        document.getSelection()?.selectAllChildren(this.inlineTitle);
      } else this.editor.view.focus();
    }
  }

  onShow() {
    requestAnimationFrame(() => this.editor.view.requestMeasure());
  }

  onRename(oldP: string, newP: string) {
    if (!this.file) return;
    if (this.file === oldP) this.file = newP;
    else if (this.file.startsWith(oldP + '/')) this.file = newP + this.file.slice(oldP.length);
    else return;
    this.inlineTitle.textContent = titleOf(this.file);
    this.updateTitle();
  }

  async onExternalChange(paths: string[]) {
    if (!this.file || !paths.includes(this.file) || this.dirty) return;
    let text: string;
    try {
      text = await this.app.backend.read(this.file);
    } catch {
      return;
    }
    if (text === this.content()) return;
    this.lastSaved = text;
    this.editor.setDoc(text, true);
    if (this.mode === 'read') await this.renderReading();
  }

  onSettingsChanged() {
    this.editor.reconfigure();
    if (this.mode === 'read') void this.renderReading();
  }

  destroy() {
    void this.flush();
    this.editor.view.destroy();
  }
}
