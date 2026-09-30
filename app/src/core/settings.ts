export interface Settings {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  fontSize: number;
  fontFamily: string;
  readableLineLength: boolean;
  lineNumbers: boolean;
  vimMode: boolean;
  spellcheck: boolean;
  livePreview: boolean;
  defaultMode: 'edit' | 'read';
  showInlineTitle: boolean;
  foldGutter: boolean;
  newNoteFolder: string;
  attachmentFolder: string;
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string;
  templatesFolder: string;
  dateFormat: string;
  timeFormat: string;
  confirmDelete: boolean;
  autoUpdateLinks: boolean;
  hotkeys: Record<string, string>;
  cssSnippet: string;
  enabledPlugins: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#8b5cf6',
  fontSize: 16,
  fontFamily: '',
  readableLineLength: true,
  lineNumbers: false,
  vimMode: false,
  spellcheck: true,
  livePreview: true,
  defaultMode: 'edit',
  showInlineTitle: true,
  foldGutter: true,
  newNoteFolder: '',
  attachmentFolder: 'Adjuntos',
  dailyFolder: 'Diario',
  dailyFormat: 'YYYY-MM-DD',
  dailyTemplate: 'Plantillas/Nota diaria.md',
  templatesFolder: 'Plantillas',
  dateFormat: 'YYYY-MM-DD',
  timeFormat: 'HH:mm',
  confirmDelete: true,
  autoUpdateLinks: true,
  hotkeys: {},
  cssSnippet: '',
  enabledPlugins: [],
};
