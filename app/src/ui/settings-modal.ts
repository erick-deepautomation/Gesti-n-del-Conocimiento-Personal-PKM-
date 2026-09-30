import type { App } from '../core/app';
import { eventToHotkey, prettyHotkey } from '../core/commands';
import type { PluginManager } from '../core/plugins';
import type { Settings } from '../core/settings';
import { h } from '../core/util';
import { Modal } from './modals';

type Key = keyof Settings;

export function openSettings(app: App, plugins: PluginManager) {
  const m = new Modal('settings-modal');
  const nav = h('div.settings-nav');
  const body = h('div.settings-body');
  m.el.append(nav, body);

  const row = (name: string, desc: string, control: HTMLElement) =>
    h('div.setting-item', h('div.setting-info', h('div.setting-name', name), desc ? h('div.setting-desc', desc) : null), h('div.setting-control', control));

  const toggle = (key: Key) => {
    const i = h('input.toggle', { type: 'checkbox' }) as HTMLInputElement;
    i.checked = !!app.settings[key];
    i.addEventListener('change', () => app.updateSettings({ [key]: i.checked } as Partial<Settings>));
    return i;
  };
  const text = (key: Key, placeholder = '') => {
    const i = h('input', { type: 'text', value: String(app.settings[key] ?? ''), placeholder }) as HTMLInputElement;
    i.addEventListener('change', () => app.updateSettings({ [key]: i.value } as Partial<Settings>));
    return i;
  };
  const num = (key: Key, min: number, max: number) => {
    const i = h('input', { type: 'number', min: String(min), max: String(max), value: String(app.settings[key]) }) as HTMLInputElement;
    i.addEventListener('change', () => app.updateSettings({ [key]: Number(i.value) } as Partial<Settings>));
    return i;
  };
  const select = (key: Key, opts: [string, string][]) => {
    const s = h('select', opts.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    s.value = String(app.settings[key]);
    s.addEventListener('change', () => app.updateSettings({ [key]: s.value } as Partial<Settings>));
    return s;
  };

  const tabs: Record<string, () => HTMLElement[]> = {
    Editor: () => [
      row('Vista previa en vivo', 'Oculta la sintaxis Markdown fuera del cursor', toggle('livePreview')),
      row('Modo por defecto', 'Al abrir notas', select('defaultMode', [['edit', 'Edición'], ['read', 'Lectura']])),
      row('Números de línea', '', toggle('lineNumbers')),
      row('Plegar encabezados y listas', 'Muestra el margen de plegado', toggle('foldGutter')),
      row('Corrector ortográfico', '', toggle('spellcheck')),
      row('Modo Vim', 'Atajos de teclado de Vim en el editor', toggle('vimMode')),
      row('Título en línea', 'Muestra el nombre de archivo como título editable', toggle('showInlineTitle')),
    ],
    Apariencia: () => {
      const color = h('input', { type: 'color', value: app.settings.accent }) as HTMLInputElement;
      color.addEventListener('input', () => app.updateSettings({ accent: color.value }));
      const css = h('textarea.settings-css', { spellcheck: 'false', placeholder: '/* CSS personalizado */\n.markdown-rendered h1 { color: tomato; }' }) as HTMLTextAreaElement;
      css.value = app.settings.cssSnippet;
      css.addEventListener('change', () => app.updateSettings({ cssSnippet: css.value }));
      return [
        row('Tema', '', select('theme', [['dark', 'Oscuro'], ['light', 'Claro'], ['system', 'Según el sistema']])),
        row('Color de acento', '', color),
        row('Tamaño de fuente', 'En píxeles', num('fontSize', 10, 32)),
        row('Fuente del texto', 'Familia CSS (vacío = predeterminada)', text('fontFamily', 'Inter, sans-serif')),
        row('Ancho de línea legible', 'Limita el ancho del texto', toggle('readableLineLength')),
        h('div.setting-item.is-block', h('div.setting-name', 'Fragmento CSS'), css),
      ];
    },
    'Archivos y enlaces': () => [
      row('Carpeta para notas nuevas', 'Vacío = raíz; «.» = misma carpeta que la nota activa', text('newNoteFolder')),
      row('Carpeta de adjuntos', 'Donde se guardan imágenes pegadas; «./sub» = relativa a la nota', text('attachmentFolder')),
      row('Actualizar enlaces al renombrar', 'Siempre activo: reescribe [[enlaces]] y [md](enlaces)', toggle('autoUpdateLinks')),
      row('Confirmar antes de eliminar', 'Los archivos van a .trash dentro de la bóveda', toggle('confirmDelete')),
    ],
    'Notas diarias': () => [
      row('Carpeta', '', text('dailyFolder')),
      row('Formato de fecha', 'YYYY, MM, DD, dddd, MMMM…', text('dailyFormat')),
      row('Plantilla', 'Ruta de la nota plantilla', text('dailyTemplate')),
    ],
    Plantillas: () => [
      row('Carpeta de plantillas', '', text('templatesFolder')),
      row('Formato de {{date}}', '', text('dateFormat')),
      row('Formato de {{time}}', '', text('timeFormat')),
      h('p.setting-desc', 'Variables: {{title}}, {{date}}, {{time}}, {{date:DD/MM/YYYY}}.'),
    ],
    Atajos: () => {
      const filter = h('input', { type: 'search', placeholder: 'Filtrar…' }) as HTMLInputElement;
      const list = h('div.hotkey-list');
      const draw = () => {
        const q = filter.value.toLowerCase();
        list.replaceChildren(
          ...app.commands
            .all()
            .filter((c) => c.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => {
              const hk = app.commands.hotkeyOf(c.id);
              const btn = h('button.hotkey-button', hk ? prettyHotkey(hk) : 'Asignar') as HTMLButtonElement;
              btn.addEventListener('click', () => {
                btn.textContent = 'Pulsa una combinación…';
                const onKey = (e: KeyboardEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === 'Escape') {
                    window.removeEventListener('keydown', onKey, true);
                    draw();
                    return;
                  }
                  const combo = eventToHotkey(e);
                  if (!combo) return;
                  window.removeEventListener('keydown', onKey, true);
                  app.updateSettings({ hotkeys: { ...app.settings.hotkeys, [c.id]: combo } });
                  draw();
                };
                window.addEventListener('keydown', onKey, true);
              });
              const reset = h('button.mini-button', { title: 'Restablecer', onclick: () => { const hk2 = { ...app.settings.hotkeys }; delete hk2[c.id]; app.updateSettings({ hotkeys: hk2 }); draw(); } }, '↺');
              return h('div.setting-item', h('div.setting-info', h('div.setting-name', c.name)), h('div.setting-control', btn, reset));
            }),
        );
      };
      filter.addEventListener('input', draw);
      draw();
      return [filter, list];
    },
    Complementos: () => {
      const wrap = h('div');
      void plugins.available().then((ids) => {
        if (!ids.length) {
          wrap.append(h('p.setting-desc', 'No hay complementos. Copia archivos `<id>.js` en `.pkm/plugins/` y lista sus ids en `.pkm/plugins/index.json`.'));
          return;
        }
        for (const id of ids) {
          const t = h('input.toggle', { type: 'checkbox' }) as HTMLInputElement;
          t.checked = app.settings.enabledPlugins.includes(id);
          t.addEventListener('change', async () => {
            const set = new Set(app.settings.enabledPlugins);
            if (t.checked) {
              set.add(id);
              await plugins.load(id);
            } else {
              set.delete(id);
              plugins.unload(id);
            }
            app.updateSettings({ enabledPlugins: [...set] });
          });
          wrap.append(row(id, plugins.isLoaded(id) ? 'Cargado' : '', t));
        }
      });
      return [h('p.setting-desc.is-warning', 'Los complementos ejecutan código con acceso a tu bóveda. Activa solo los que confíes.'), wrap];
    },
    'Acerca de': () => {
      const s = h('div');
      void app.backend.stats().then((st) =>
        s.append(
          h('p', `Bóveda: ${app.vault?.name} (${app.backend.kind === 'tauri' ? 'nativa' : 'web'})`),
          h('p', `${st.notes} notas · ${st.files} archivos · ${st.links} enlaces · ${st.words.toLocaleString()} palabras · ${st.terms.toLocaleString()} términos indexados`),
          h('p', `Carga inicial: ${app.vault?.elapsedMs ?? 0} ms`),
        ),
      );
      return [h('h3', 'Nexo PKM 0.1.0'), h('p', 'Gestión del conocimiento personal. Markdown plano, local-first y compatible con Obsidian.'), s];
    },
  };

  const show = (name: string) => {
    nav.querySelectorAll('.settings-nav-item').forEach((x) => x.classList.toggle('is-active', x.textContent === name));
    body.replaceChildren(h('h2', name), ...tabs[name]());
  };
  for (const name of Object.keys(tabs)) nav.append(h('div.settings-nav-item', { onclick: () => show(name) }, name));
  m.el.append(h('button.modal-close', { onclick: () => m.close(), 'aria-label': 'Cerrar' }, '×'));
  m.open();
  show('Editor');
}
