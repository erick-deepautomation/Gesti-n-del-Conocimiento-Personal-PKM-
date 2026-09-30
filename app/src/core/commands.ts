import { isMac } from './util';

export interface Command {
  id: string;
  name: string;
  hotkey?: string;
  icon?: string;
  /** Si devuelve false el comando no aparece ni se ejecuta. */
  when?: () => boolean;
  run: () => unknown;
}

/** Normaliza un evento de teclado a "Mod+Shift+K". `Mod` = Cmd en macOS, Ctrl en el resto. */
export function eventToHotkey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(k)) return '';
  // Con Alt/Shift, e.key puede cambiar (p. ej. "Dead" o símbolos): usar el código físico.
  if (e.code.startsWith('Key')) k = e.code.slice(3);
  else if (e.code.startsWith('Digit')) k = e.code.slice(5);
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

export function prettyHotkey(hk: string): string {
  return hk
    .split('+')
    .map((p) => (p === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : p === 'Shift' ? (isMac ? '⇧' : 'Shift') : p === 'Alt' ? (isMac ? '⌥' : 'Alt') : p))
    .join(isMac ? '' : '+');
}

export class Commands {
  private cmds = new Map<string, Command>();
  overrides: Record<string, string> = {};

  register(c: Command) {
    this.cmds.set(c.id, c);
    return () => this.cmds.delete(c.id);
  }

  get(id: string) {
    return this.cmds.get(id);
  }

  hotkeyOf(id: string): string | undefined {
    return this.overrides[id] ?? this.cmds.get(id)?.hotkey;
  }

  list(): Command[] {
    return [...this.cmds.values()].filter((c) => !c.when || c.when());
  }

  all(): Command[] {
    return [...this.cmds.values()];
  }

  run(id: string) {
    const c = this.cmds.get(id);
    if (c && (!c.when || c.when())) return c.run();
  }

  /** Devuelve true si el atajo se consumió. */
  handleKey(e: KeyboardEvent): boolean {
    const hk = eventToHotkey(e);
    if (!hk || !hk.includes('+')) {
      if (hk !== 'F1' && hk !== 'F2') return false;
    }
    for (const c of this.cmds.values()) {
      if (this.hotkeyOf(c.id) === hk && (!c.when || c.when())) {
        e.preventDefault();
        e.stopPropagation();
        void c.run();
        return true;
      }
    }
    return false;
  }
}
