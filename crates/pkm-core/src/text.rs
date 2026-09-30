//! Utilidades de texto: plegado (minúsculas + sin diacríticos), tokenización
//! y coincidencia difusa para el selector rápido.

use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// Minúsculas y sin acentos: "Canción" → "cancion". Ruta rápida ASCII.
pub fn fold(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    s.nfd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase).collect()
}

/// Tokens de búsqueda (ya plegados).
pub fn tokenize(folded: &str) -> impl Iterator<Item = &str> {
    folded.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty())
}

/// ¿Contiene `needle` en `hay` con límites de palabra?
pub fn contains_word(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut start = 0;
    while let Some(p) = hay[start..].find(needle) {
        let s = start + p;
        let e = s + needle.len();
        let before_ok = hay[..s].chars().next_back().map_or(true, |c| !c.is_alphanumeric());
        let after_ok = hay[e..].chars().next().map_or(true, |c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        start = s + hay[s..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Puntuación difusa por subsecuencia. `q` debe venir plegado. `None` = sin coincidencia.
pub fn fuzzy_score(q: &[char], target: &str) -> Option<f32> {
    if q.is_empty() {
        return Some(0.0);
    }
    let t: Vec<char> = fold(target).chars().collect();
    let mut qi = 0;
    let mut score = 0f32;
    let mut last: Option<usize> = None;
    let mut first: Option<usize> = None;
    for (ti, &c) in t.iter().enumerate() {
        if qi < q.len() && c == q[qi] {
            let mut s = 1.0;
            let at_word_start = ti == 0 || matches!(t[ti - 1], '/' | ' ' | '-' | '_' | '.' | '(');
            if at_word_start {
                s += 6.0;
            }
            if let Some(l) = last {
                if l + 1 == ti {
                    s += 5.0;
                } else {
                    s -= ((ti - l) as f32).min(10.0) * 0.2;
                }
            }
            if first.is_none() {
                first = Some(ti);
            }
            score += s;
            last = Some(ti);
            qi += 1;
        }
    }
    if qi < q.len() {
        return None;
    }
    // Penaliza objetivos largos y coincidencias tardías.
    score -= (t.len() as f32) * 0.02 + first.unwrap_or(0) as f32 * 0.1;
    Some(score)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding() {
        assert_eq!(fold("Canción ÑANDÚ"), "cancion nandu");
        assert_eq!(tokenize("hola, mundo-feliz").collect::<Vec<_>>(), vec!["hola", "mundo", "feliz"]);
    }

    #[test]
    fn word_boundaries() {
        assert!(contains_word("una nota aqui", "nota"));
        assert!(!contains_word("notable", "nota"));
    }

    #[test]
    fn fuzzy() {
        let q: Vec<char> = "pkm".chars().collect();
        let a = fuzzy_score(&q, "Personal Knowledge Management").unwrap();
        let b = fuzzy_score(&q, "xpxxkxxxxm").unwrap();
        assert!(a > b);
        assert!(fuzzy_score(&q, "abc").is_none());
    }
}
