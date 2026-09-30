// Tipos compartidos con pkm-core (camelCase vía serde).

export interface FileInfo {
  path: string;
  isNote: boolean;
  mtime: number;
  size: number;
}

export interface Stats {
  files: number;
  notes: number;
  terms: number;
  links: number;
  words: number;
}

export interface VaultInfo {
  root: string;
  name: string;
  files: FileInfo[];
  folders: string[];
  stats: Stats;
  elapsedMs: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface Task {
  line: number;
  done: boolean;
  text: string;
}

export interface ResolvedLink {
  target: string;
  subpath: string | null;
  display: string | null;
  embed: boolean;
  line: number;
  resolved: string | null;
}

export interface NoteMeta {
  path: string;
  title: string;
  frontmatter: Record<string, unknown> | null;
  aliases: string[];
  tags: string[];
  headings: Heading[];
  blockIds: string[];
  tasks: Task[];
  wordCount: number;
  charCount: number;
  links: ResolvedLink[];
  backlinkCount: number;
  mtime: number;
  size: number;
}

export interface Mention {
  line: number;
  text: string;
}

export interface Backlink {
  source: string;
  mentions: Mention[];
}

export interface Unresolved {
  target: string;
  sources: string[];
  count: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  matches: Mention[];
  terms: string[];
}

export interface SwitchHit {
  path: string;
  title: string;
  alias: string | null;
  isNote: boolean;
  score: number;
}

export interface VaultTask {
  path: string;
  line: number;
  done: boolean;
  text: string;
}

export interface GraphOptions {
  attachments?: boolean;
  unresolved?: boolean;
  tags?: boolean;
  orphans?: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: 'note' | 'attachment' | 'unresolved' | 'tag';
  degree: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: [number, number][];
}

export interface RenameResult {
  moved: [string, string][];
  edited: string[];
}

export interface ChangeEvent {
  changed: string[];
  removed: string[];
}

/** Contrato común para el host nativo (Tauri) y el web (WASM + IndexedDB / File System Access). */
export interface Backend {
  readonly kind: 'tauri' | 'web';
  /** Intenta reabrir la última bóveda sin interacción. */
  init(): Promise<VaultInfo | null>;
  /** Abre/elige una bóveda (diálogo nativo, selector de carpeta o bóveda interna). */
  openVault(mode?: 'pick' | 'default'): Promise<VaultInfo | null>;
  /** Opciones de apertura disponibles en esta plataforma. */
  openModes(): { id: 'pick' | 'default'; label: string; hint: string }[];

  files(): Promise<FileInfo[]>;
  folders(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  resourceUrl(path: string): Promise<string>;
  createFolder(path: string): Promise<void>;
  delete(path: string): Promise<string[]>;
  rename(oldPath: string, newPath: string): Promise<RenameResult>;
  readConfig(name: string): Promise<string | null>;
  writeConfig(name: string, content: string): Promise<void>;

  search(query: string, limit: number): Promise<SearchHit[]>;
  quickSwitch(query: string, limit: number): Promise<SwitchHit[]>;
  meta(path: string): Promise<NoteMeta | null>;
  backlinks(path: string): Promise<Backlink[]>;
  unlinkedMentions(path: string): Promise<Backlink[]>;
  unresolved(): Promise<Unresolved[]>;
  tags(): Promise<TagCount[]>;
  tasks(includeDone: boolean): Promise<VaultTask[]>;
  propertyKeys(): Promise<TagCount[]>;
  graph(opts: GraphOptions): Promise<Graph>;
  localGraph(path: string, depth: number, opts: GraphOptions): Promise<Graph>;
  stats(): Promise<Stats>;

  onExternalChange(cb: (ev: ChangeEvent) => void): void;
}
