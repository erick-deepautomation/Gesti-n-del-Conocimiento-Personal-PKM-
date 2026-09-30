// Bóveda de ejemplo que se crea la primera vez en la versión web.
export const SAMPLE_VAULT: Record<string, string> = {
  'Bienvenida.md': `---
tags: [inicio, guía]
aliases: [Inicio, Home]
creado: 2026-01-01
---
# Bienvenida a Nexo PKM

Nexo es un gestor de conocimiento personal **rápido**, *local-first* y compatible con las bóvedas de Obsidian: tus notas son archivos Markdown normales.

> [!tip] Primeros pasos
> - Pulsa **Ctrl/Cmd + O** para el selector rápido de notas.
> - Pulsa **Ctrl/Cmd + P** para la paleta de comandos.
> - Pulsa **Ctrl/Cmd + E** para alternar entre edición y lectura.
> - Pulsa **Ctrl/Cmd + G** para ver el grafo.

## Enlaces
Enlaza notas con dobles corchetes: [[Enlaces y retroenlaces]], [[Sintaxis Markdown|la guía de sintaxis]] o a una sección: [[Sintaxis Markdown#Matemáticas]].
Los enlaces a notas que no existen, como [[Idea pendiente]], se crean al hacer clic.

## Etiquetas
Usa #etiquetas y #etiquetas/anidadas. Aparecen en el panel de etiquetas.

## Tareas
- [x] Instalar Nexo
- [ ] Explorar el [[Grafo de conocimiento]]
- [ ] Crear mi primera nota diaria

![[Sintaxis Markdown#Callouts]]
`,
  'Enlaces y retroenlaces.md': `---
tags: [guía]
---
# Enlaces y retroenlaces

Cada vez que una nota enlaza a otra, la nota destino muestra un **retroenlace** en el panel derecho.
Las *menciones sin enlazar* detectan dónde aparece el título de la nota sin estar enlazado.

Esta nota vuelve a la [[Bienvenida]]. Al renombrar una nota, **todos los enlaces se actualizan automáticamente**.

Enlace a un bloque concreto: [[Sintaxis Markdown#^bloque-clave]]
`,
  'Sintaxis Markdown.md': `# Sintaxis Markdown

Texto en **negrita**, *cursiva*, ~~tachado~~, ==resaltado== y \`código\`.
%%Esto es un comentario: no se muestra en modo lectura.%%

Este párrafo tiene un identificador de bloque. ^bloque-clave

## Callouts
> [!note] Nota
> Los callouts se escriben como citas con \`[!tipo]\`.

> [!warning]- Plegable
> Este callout empieza plegado.

## Matemáticas
En línea: $e^{i\\pi} + 1 = 0$ y en bloque:

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

## Código
\`\`\`rust
fn main() {
    println!("Hola, Nexo");
}
\`\`\`

## Diagramas
\`\`\`mermaid
graph LR
  Idea --> Nota --> Conocimiento
\`\`\`

## Tablas
| Función | Atajo |
|---|---|
| Selector rápido | Ctrl+O |
| Buscar en la bóveda | Ctrl+Shift+F |

## Notas al pie
Una afirmación con nota al pie.[^1]

[^1]: Esta es la nota al pie.
`,
  'Grafo de conocimiento.md': `---
tags: [guía, grafo]
---
# Grafo de conocimiento

La vista de grafo muestra cómo se conectan tus notas. Puedes filtrar etiquetas, adjuntos, notas huérfanas y enlaces sin resolver.
El **grafo local** del panel derecho muestra solo el vecindario de la nota activa.

Relacionado: [[Enlaces y retroenlaces]], [[Bienvenida]], #grafo
`,
  'Plantillas/Nota diaria.md': `---
fecha: {{date}}
tags: [diario]
---
# {{title}}

## Tareas
- [ ] 

## Notas
`,
  'Plantillas/Reunión.md': `---
tipo: reunión
fecha: {{date}} {{time}}
---
# {{title}}

**Asistentes:** 
## Puntos
- 
## Acciones
- [ ] 
`,
  'Lienzo de ejemplo.canvas': JSON.stringify(
    {
      nodes: [
        { id: 'a', type: 'text', text: '# Lienzo\nOrganiza ideas visualmente.', x: 0, y: 0, width: 260, height: 120 },
        { id: 'b', type: 'file', file: 'Bienvenida.md', x: 340, y: -40, width: 300, height: 200 },
        { id: 'c', type: 'text', text: 'Arrastra tarjetas y conéctalas desde sus bordes.', x: 0, y: 200, width: 260, height: 90, color: '4' },
      ],
      edges: [{ id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }, { id: 'e2', fromNode: 'a', fromSide: 'bottom', toNode: 'c', toSide: 'top' }],
    },
    null,
    2,
  ),
};
