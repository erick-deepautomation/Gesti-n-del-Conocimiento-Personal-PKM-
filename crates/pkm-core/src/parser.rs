//! Analizador Markdown de una sola pasada, sin asignaciones innecesarias.
//!
//! Extrae lo que un PKM necesita indexar (frontmatter, enlaces `[[wiki]]` y
//! `[md](links)`, incrustaciones, etiquetas, encabezados, IDs de bloque y
//! tareas), ignorando bloques de código, código en línea, math y comentarios.
//! Los desplazamientos son en bytes UTF-8 para poder reescribir enlaces de
//! forma exacta al renombrar.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Wiki,
    Markdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    /// Destino decodificado (sin subruta ni alias), p. ej. `Carpeta/Nota`.
    pub target: String,
    /// `Encabezado` o `^bloque` (sin el `#` inicial).
    pub subpath: Option<String>,
    pub display: Option<String>,
    pub embed: bool,
    pub kind: LinkKind,
    /// Línea (base 0).
    pub line: u32,
    /// Rango en bytes del token completo (incluye `!` si es incrustación).
    pub start: u32,
    pub end: u32,
    /// Rango en bytes del texto de destino en crudo (para reescritura).
    pub target_start: u32,
    pub target_end: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub line: u32,
    pub done: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    pub tag: String,
    /// `None` si la etiqueta proviene del frontmatter.
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedNote {
    pub frontmatter: Option<serde_json::Value>,
    /// Primera línea del cuerpo (tras el frontmatter).
    pub body_line: u32,
    pub aliases: Vec<String>,
    pub tags: Vec<TagRef>,
    pub links: Vec<LinkRef>,
    pub headings: Vec<Heading>,
    pub block_ids: Vec<String>,
    pub tasks: Vec<Task>,
    pub word_count: u32,
}

impl ParsedNote {
    /// Etiquetas únicas (en minúsculas se comparan, se conserva la primera grafía).
    pub fn unique_tags(&self) -> Vec<&str> {
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for t in &self.tags {
            let l = t.tag.to_lowercase();
            if !seen.contains(&l) {
                seen.push(l);
                out.push(t.tag.as_str());
            }
        }
        out
    }
}

/// Iterador de líneas que devuelve (desplazamiento, línea sin `\r\n`).
fn lines_with_offsets(s: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut off = 0usize;
    s.split('\n').map(move |l| {
        let o = off;
        off += l.len() + 1;
        (o, l.strip_suffix('\r').unwrap_or(l))
    })
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

pub fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(v) = h {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

pub fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            _ => out.push(c),
        }
    }
    out
}

fn is_external_url(u: &str) -> bool {
    let l = u.trim_start();
    if l.starts_with("mailto:") || l.starts_with("data:") || l.starts_with("tel:") {
        return true;
    }
    // esquema://
    if let Some(i) = l.find("://") {
        return l[..i].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
    }
    // obsidian:, file: etc.
    if let Some(i) = l.find(':') {
        let scheme = &l[..i];
        return scheme.len() > 1 && scheme.chars().all(|c| c.is_ascii_alphabetic());
    }
    false
}

fn yaml_str_list(v: Option<&serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::String(s)) => s
            .split(|c: char| c == ',' || c.is_whitespace())
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
            .map(String::from)
            .collect(),
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|x| match x {
                serde_json::Value::String(s) => Some(s.trim().to_string()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .filter(|x| !x.is_empty())
            .collect(),
        _ => vec![],
    }
}

fn aliases_list(v: Option<&serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::String(s)) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        other => yaml_str_list(other),
    }
}

/// Localiza el frontmatter. Devuelve (yaml, byte de inicio del cuerpo, línea del cuerpo).
pub fn split_frontmatter(content: &str) -> (Option<&str>, usize, u32) {
    let first_len = if content.starts_with("---\n") {
        4
    } else if content.starts_with("---\r\n") {
        5
    } else {
        return (None, 0, 0);
    };
    let mut pos = first_len;
    let mut line = 1u32;
    loop {
        let rest = &content[pos..];
        let (l, adv, has_nl) = match rest.find('\n') {
            Some(i) => (&rest[..i], i + 1, true),
            None => (rest, rest.len(), false),
        };
        let t = l.trim_end();
        if t == "---" || t == "..." {
            return (Some(&content[first_len..pos]), pos + adv, line + 1);
        }
        if !has_nl {
            return (None, 0, 0);
        }
        pos += adv;
        line += 1;
    }
}

pub fn parse(content: &str) -> ParsedNote {
    let mut out = ParsedNote::default();

    let (yaml, body_start, body_line) = split_frontmatter(content);
    if let Some(y) = yaml {
        if y.trim().is_empty() {
            out.frontmatter = Some(serde_json::Value::Object(Default::default()));
        } else if let Ok(v) = serde_yaml::from_str::<serde_json::Value>(y) {
            if v.is_object() {
                let tags = yaml_str_list(v.get("tags").or_else(|| v.get("tag")));
                for t in tags {
                    let t = t.trim_start_matches('#').to_string();
                    if !t.is_empty() {
                        out.tags.push(TagRef { tag: t, line: None });
                    }
                }
                out.aliases = aliases_list(v.get("aliases").or_else(|| v.get("alias")));
                out.frontmatter = Some(v);
            }
        }
        out.body_line = body_line;
    }

    let mut fence: Option<(u8, usize)> = None; // (carácter, longitud)
    let mut in_math = false;
    let mut in_comment = false;
    let mut words = 0u32;

    for (line_idx, (off, line)) in lines_with_offsets(content).enumerate() {
        if off < body_start {
            continue;
        }
        let ln = line_idx as u32;
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();

        // Bloques de código delimitados.
        if indent <= 3 {
            let tb = trimmed.as_bytes();
            if let Some(&c) = tb.first() {
                if c == b'`' || c == b'~' {
                    let run = tb.iter().take_while(|&&x| x == c).count();
                    if run >= 3 {
                        match fence {
                            None => {
                                fence = Some((c, run));
                                continue;
                            }
                            Some((fc, fl)) if fc == c && run >= fl && trimmed[run..].trim().is_empty() => {
                                fence = None;
                                continue;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        if fence.is_some() {
            words += line.split_whitespace().count() as u32;
            continue;
        }
        if trimmed.trim_end() == "$$" {
            in_math = !in_math;
            continue;
        }
        if in_math {
            continue;
        }
        if trimmed.trim_end() == "%%" {
            in_comment = !in_comment;
            continue;
        }
        if in_comment {
            continue;
        }

        words += line.split_whitespace().count() as u32;

        // Encabezados ATX.
        let mut scan_from = 0usize;
        if indent <= 3 && trimmed.starts_with('#') {
            let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
            if hashes <= 6 && (trimmed.len() == hashes || trimmed.as_bytes()[hashes] == b' ' || trimmed.as_bytes()[hashes] == b'\t') {
                let text = trimmed[hashes..].trim().trim_end_matches('#').trim_end();
                out.headings.push(Heading { level: hashes as u8, text: text.to_string(), line: ln });
                scan_from = indent + hashes;
            }
        }

        // Tareas.
        {
            let t = trimmed;
            let after_marker = if t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") {
                Some(&t[2..])
            } else {
                let d = t.bytes().take_while(|b| b.is_ascii_digit()).count();
                if d > 0 && (t[d..].starts_with(". ") || t[d..].starts_with(") ")) {
                    Some(&t[d + 2..])
                } else {
                    None
                }
            };
            if let Some(a) = after_marker {
                let ab = a.as_bytes();
                if ab.len() >= 3 && ab[0] == b'[' && ab[2] == b']' && (ab.len() == 3 || ab[3] == b' ') {
                    let st = ab[1];
                    if st.is_ascii() {
                        out.tasks.push(Task { line: ln, done: st != b' ', text: a[3..].trim().to_string() });
                    }
                }
            }
        }

        // ID de bloque al final de línea: " ^id".
        if let Some(pos) = line.trim_end().rfind(" ^") {
            let id = &line.trim_end()[pos + 2..];
            if !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                out.block_ids.push(id.to_string());
            }
        }

        scan_inline(line, off, ln, scan_from, &mut out);
    }

    out.word_count = words;
    out
}

fn scan_inline(line: &str, off: usize, ln: u32, from: usize, out: &mut ParsedNote) {
    let b = line.as_bytes();
    let mut i = from;
    while i < b.len() {
        match b[i] {
            b'`' => {
                let run = b[i..].iter().take_while(|&&x| x == b'`').count();
                let pat = &line[i..i + run];
                if let Some(close) = line[i + run..].find(pat) {
                    i = i + run + close + run;
                } else {
                    i += run;
                }
            }
            b'%' if b.get(i + 1) == Some(&b'%') => {
                if let Some(close) = line[i + 2..].find("%%") {
                    i = i + 2 + close + 2;
                } else {
                    return; // comentario hasta fin de línea
                }
            }
            b'$' if b.get(i + 1) != Some(&b' ') => {
                // Math en línea $...$ (no precedido por dígito para evitar precios).
                if let Some(close) = line[i + 1..].find('$') {
                    let inner = &line[i + 1..i + 1 + close];
                    if !inner.is_empty() && !inner.ends_with(' ') && !(close + i + 2 < b.len() && b[i + 2 + close].is_ascii_digit()) {
                        i = i + 1 + close + 1;
                        continue;
                    }
                }
                i += 1;
            }
            b'[' if b.get(i + 1) == Some(&b'[') => {
                let embed = i > 0 && b[i - 1] == b'!';
                let inner_start = i + 2;
                if let Some(rel) = line[inner_start..].find("]]") {
                    let inner = &line[inner_start..inner_start + rel];
                    if !inner.is_empty() && !inner.contains("[[") {
                        let (left, display) = match inner.find('|') {
                            Some(p) => (&inner[..p], Some(inner[p + 1..].trim().to_string())),
                            None => (inner, None),
                        };
                        let left = left.strip_suffix('\\').unwrap_or(left);
                        let (tgt, sub) = match left.find('#') {
                            Some(p) => (&left[..p], Some(left[p + 1..].trim().to_string())),
                            None => (left, None),
                        };
                        let lead_ws = tgt.len() - tgt.trim_start().len();
                        let tgt_trim = tgt.trim();
                        let ts = inner_start + lead_ws;
                        out.links.push(LinkRef {
                            target: tgt_trim.to_string(),
                            subpath: sub.filter(|s| !s.is_empty()),
                            display: display.filter(|s| !s.is_empty()),
                            embed,
                            kind: LinkKind::Wiki,
                            line: ln,
                            start: (off + if embed { i - 1 } else { i }) as u32,
                            end: (off + inner_start + rel + 2) as u32,
                            target_start: (off + ts) as u32,
                            target_end: (off + ts + tgt_trim.len()) as u32,
                        });
                        i = inner_start + rel + 2;
                        continue;
                    }
                }
                i += 2;
            }
            b'[' => {
                // Enlace markdown [texto](destino)
                if let Some((text_end, url_s, url_e, end)) = match_md_link(b, i) {
                    let embed = i > 0 && b[i - 1] == b'!';
                    let raw = &line[url_s..url_e];
                    let (path_raw, sub) = match raw.find('#') {
                        Some(p) => (&raw[..p], Some(percent_decode(&raw[p + 1..]))),
                        None => (raw, None),
                    };
                    if !path_raw.is_empty() && !is_external_url(raw) {
                        let text = &line[i + 1..text_end];
                        out.links.push(LinkRef {
                            target: percent_decode(path_raw),
                            subpath: sub.filter(|s| !s.is_empty()),
                            display: if text.is_empty() { None } else { Some(text.to_string()) },
                            embed,
                            kind: LinkKind::Markdown,
                            line: ln,
                            start: (off + if embed { i - 1 } else { i }) as u32,
                            end: (off + end) as u32,
                            target_start: (off + url_s) as u32,
                            target_end: (off + url_s + path_raw.len()) as u32,
                        });
                    }
                    // Las etiquetas dentro del texto del enlace siguen contando.
                    scan_inline_tags_only(&line[..text_end], i + 1, ln, out);
                    i = end;
                    continue;
                }
                i += 1;
            }
            b'#' => {
                let prev_ok = i == 0 || {
                    let pc = line[..i].chars().next_back().unwrap();
                    pc.is_whitespace() || pc == '(' || pc == ',' || pc == '[' || pc == '*' || pc == '_'
                };
                if prev_ok {
                    let rest = &line[i + 1..];
                    let len: usize = rest.chars().take_while(|&c| is_tag_char(c)).map(char::len_utf8).sum();
                    if len > 0 {
                        let tag = rest[..len].trim_end_matches('/');
                        if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) {
                            out.tags.push(TagRef { tag: tag.to_string(), line: Some(ln) });
                        }
                        i += 1 + len;
                        continue;
                    }
                }
                i += 1;
            }
            _ => {
                // avanzar un carácter UTF-8 completo
                i += utf8_len(b[i]);
            }
        }
    }
}

fn scan_inline_tags_only(line: &str, from: usize, ln: u32, out: &mut ParsedNote) {
    let mut tmp = ParsedNote::default();
    scan_inline(line, 0, ln, from, &mut tmp);
    out.tags.extend(tmp.tags);
}

#[inline]
fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

/// Reconoce `[texto](url "título")` empezando en `i` (que apunta a `[`).
/// Devuelve (fin del texto, inicio url, fin url, fin del token).
fn match_md_link(b: &[u8], i: usize) -> Option<(usize, usize, usize, usize)> {
    let mut depth = 0i32;
    let mut j = i;
    let text_end;
    loop {
        if j >= b.len() {
            return None;
        }
        match b[j] {
            b'\\' => j += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    text_end = j;
                    break;
                }
            }
            _ => {}
        }
        j += 1;
    }
    if b.get(text_end + 1) != Some(&b'(') {
        return None;
    }
    let mut k = text_end + 2;
    while k < b.len() && b[k] == b' ' {
        k += 1;
    }
    if b.get(k) == Some(&b'<') {
        let us = k + 1;
        let ue = us + b[us..].iter().position(|&c| c == b'>')?;
        let close = ue + b[ue..].iter().position(|&c| c == b')')?;
        return Some((text_end, us, ue, close + 1));
    }
    let us = k;
    let mut p = k;
    let mut paren = 0i32;
    while p < b.len() {
        match b[p] {
            b'(' => paren += 1,
            b')' => {
                if paren == 0 {
                    break;
                }
                paren -= 1;
            }
            b' ' => break,
            _ => {}
        }
        p += 1;
    }
    let ue = p;
    let close = p + b[p..].iter().position(|&c| c == b')')?;
    Some((text_end, us, ue, close + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_tags_aliases() {
        let n = parse("---\ntags: [proyecto, idea/nueva]\naliases: Alias Uno, Dos\n---\n# Título\ntexto #inline");
        assert_eq!(n.aliases, vec!["Alias Uno", "Dos"]);
        let tags: Vec<_> = n.tags.iter().map(|t| t.tag.as_str()).collect();
        assert_eq!(tags, vec!["proyecto", "idea/nueva", "inline"]);
        assert_eq!(n.headings[0].text, "Título");
        assert_eq!(n.headings[0].line, 4);
        assert_eq!(n.body_line, 4);
    }

    #[test]
    fn wikilinks_and_embeds() {
        let s = "Ver [[Nota A]] y [[Carpeta/B#Sección|alias]] e ![[img.png]] y [[#local]]";
        let n = parse(s);
        assert_eq!(n.links.len(), 4);
        assert_eq!(n.links[0].target, "Nota A");
        assert_eq!(&s[n.links[0].target_start as usize..n.links[0].target_end as usize], "Nota A");
        assert_eq!(n.links[1].target, "Carpeta/B");
        assert_eq!(n.links[1].subpath.as_deref(), Some("Sección"));
        assert_eq!(n.links[1].display.as_deref(), Some("alias"));
        assert!(n.links[2].embed);
        assert_eq!(&s[n.links[2].start as usize..n.links[2].end as usize], "![[img.png]]");
        assert_eq!(n.links[3].target, "");
    }

    #[test]
    fn markdown_links() {
        let s = "[texto](Mi%20Nota.md#h) [ext](https://x.com) ![](a/b.png)";
        let n = parse(s);
        assert_eq!(n.links.len(), 2);
        assert_eq!(n.links[0].target, "Mi Nota.md");
        assert_eq!(&s[n.links[0].target_start as usize..n.links[0].target_end as usize], "Mi%20Nota.md");
        assert!(n.links[1].embed);
    }

    #[test]
    fn ignores_code() {
        let n = parse("```\n[[no]] #no\n```\n`[[no]]` #si ~~~\n%%\n[[no]]\n%%\n$x #no$");
        assert!(n.links.is_empty());
        let tags: Vec<_> = n.tags.iter().map(|t| t.tag.as_str()).collect();
        assert_eq!(tags, vec!["si"]);
    }

    #[test]
    fn tags_rules() {
        let n = parse("#123 #a1 url.com/#x (#paren) #ñandú/sub-tag");
        let tags: Vec<_> = n.tags.iter().map(|t| t.tag.as_str()).collect();
        assert_eq!(tags, vec!["a1", "paren", "ñandú/sub-tag"]);
    }

    #[test]
    fn tasks_blocks() {
        let n = parse("- [ ] uno\n- [x] dos ^blk-1\n1. [ ] tres\n- [link](x)");
        assert_eq!(n.tasks.len(), 3);
        assert!(n.tasks[1].done);
        assert_eq!(n.block_ids, vec!["blk-1"]);
    }

    #[test]
    fn crlf() {
        let n = parse("---\r\ntags: a\r\n---\r\n# H\r\n[[x]]\r\n");
        assert_eq!(n.headings[0].text, "H");
        assert_eq!(n.links[0].target, "x");
        assert_eq!(n.tags[0].tag, "a");
    }
}
