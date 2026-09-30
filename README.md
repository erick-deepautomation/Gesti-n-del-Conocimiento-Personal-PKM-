# Nexo PKM

Gestor de conocimiento personal **local-first**, con bóvedas de Markdown plano **compatibles con Obsidian**. Un único núcleo en Rust funciona en todas las plataformas:

| Plataforma | Cómo se ejecuta |
|---|---|
| Windows, macOS, Linux | App nativa con **Tauri 2** (núcleo Rust nativo y multihilo, con vigilancia del sistema de archivos) |
| Android, iOS | La misma app Tauri 2 (`tauri android` / `tauri ios`) |
| Cualquier navegador / PWA | El mismo núcleo compilado a **WebAssembly**; guarda en IndexedDB o en una carpeta real (File System Access API en Chrome/Edge); funciona sin conexión |

## Arquitectura

```
crates/pkm-core   Núcleo Rust sin E/S: parser, índice, enlaces, búsqueda, grafo, renombrado
crates/pkm-wasm   Enlace WebAssembly (wasm-bindgen) del núcleo
src-tauri/        Host nativo: E/S de disco, escaneo en paralelo (rayon), vigilante (notify)
app/              Interfaz TypeScript + CodeMirror 6 (sin framework, con DOM directo)
```

El núcleo recibe el contenido de los archivos y devuelve las ediciones que hay que aplicar. Así el mismo código funciona en nativo y en WASM.

### Rendimiento

`cargo run --release -p pkm-core --features parallel --example bench -- 20000` (8 núcleos, 20 000 notas, 57 MB, 320 000 enlaces):

| Operación | Tiempo |
|---|---|
| Indexar la bóveda completa | ~470 ms |
| Retroenlaces de una nota | ~0,04 ms |
| Editar una nota (reindexado incremental + retroenlaces) | ~1,3 ms |
| Renombrar y reescribir los enlaces en 16 notas | ~5 ms |
| Selector rápido difuso | ~6 ms |
| Búsqueda de texto completo BM25 con prefijos (términos presentes en todas las notas) | ~50 ms |
| Grafo completo (20 000 nodos) | ~90 ms |

Cómo se consigue:
- La resolución de enlaces se cachea por nota. Solo se recalcula todo cuando cambia el conjunto de archivos.
- El índice invertido usa `BTreeMap`, lo que permite buscar por prefijo en O(log n).
- La vista previa en vivo solo decora las líneas visibles del editor.
- El guardado se agrupa (400 ms de espera) y la escritura en disco es atómica.
- El grafo se dibuja en Canvas 2D con fuerzas Barnes–Hut.
- Mermaid y Vim se cargan solo cuando se usan.

## Funciones (paridad con Obsidian)

- **Editor**: vista previa en vivo, modo fuente y modo lectura (Ctrl+E). Frontmatter YAML, plegado, Vim, corrector, atajos de formato. Al pegar o arrastrar una imagen se guarda como adjunto.
- **Enlaces**: `[[wikilinks]]`, `[[Nota#Encabezado]]`, `[[Nota#^bloque]]`, `[[Nota|alias]]` y enlaces Markdown relativos. Autocompletado de notas, alias, encabezados, bloques y etiquetas.
- **Incrustaciones** con `![[…]]`: notas, secciones, bloques, imágenes (con tamaño `|300`), PDF, audio y vídeo.
- **Retroenlaces** y **menciones sin enlazar** (con botón «Enlazar»), enlaces salientes y enlaces sin resolver.
- **Renombrar o mover** actualiza automáticamente todos los enlaces (wiki y Markdown) y las referencias en los lienzos.
- **Búsqueda** de texto completo sin distinguir acentos, con operadores `"frase"`, `-excluir`, `tag:`, `path:`, `file:` y `task:`.
- **Selector rápido** (Ctrl+O), que también crea notas, y **paleta de comandos** (Ctrl+P) con atajos configurables.
- **Grafo** global y local, con filtros y fuerzas ajustables. **Lienzos** `.canvas` (JSON Canvas 1.0).
- Callouts plegables, tareas, `==resaltado==`, `%%comentarios%%`, KaTeX, Mermaid, código resaltado, tablas y notas al pie.
- Etiquetas anidadas, propiedades, esquema, marcadores, panel de tareas de toda la bóveda, recuento de palabras.
- Notas diarias, plantillas (`{{title}}`, `{{date:FORMATO}}`, `{{time}}`), nota aleatoria.
- Pestañas, paneles divididos, historial atrás/adelante, espacio de trabajo persistente y vista previa al pasar el ratón.
- Temas claro y oscuro, color de acento, fragmentos CSS, exportación a PDF y HTML, papelera `.trash`.
- **Complementos** en JavaScript (`.pkm/plugins/<id>.js` y `.pkm/plugins/index.json`) con una API para comandos, iconos, barra de estado, eventos y acceso a la bóveda.

La configuración se guarda en `.pkm/` dentro de la bóveda. Tus notas no se tocan: abre la misma carpeta en Obsidian cuando quieras.

**Aún no incluido**: sincronización propia (usa Git, Syncthing o iCloud sobre la carpeta), Publish, el ecosistema de complementos de Obsidian (su API es distinta) y la edición avanzada de tablas y propiedades desde la interfaz.

## Desarrollo

Requisitos: Rust estable con `wasm32-unknown-unknown`, `wasm-pack` y Node 20 o superior. Para escritorio, además, los [requisitos de Tauri](https://tauri.app/start/prerequisites/).

```bash
cd app && npm ci
npm run wasm          # compila pkm-core a WebAssembly
npm run dev           # versión web en http://localhost:5173
npm run build         # PWA estática en app/dist

# Escritorio (desde la raíz del repositorio)
app/node_modules/.bin/tauri dev
app/node_modules/.bin/tauri build
# Móvil
app/node_modules/.bin/tauri android init && app/node_modules/.bin/tauri android dev

cargo test -p pkm-core --features parallel
```

La integración continua (`.github/workflows/ci.yml`) ejecuta los tests, compila la versión web y genera instaladores para Windows, macOS y Linux.

## Licencia

MIT
