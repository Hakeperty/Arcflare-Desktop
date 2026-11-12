//! Repeat guard: a port of the thinking watcher in ArcFlare-Code's loopguard.js.
//! Stops a small model paying for the same thought twice.
use std::collections::{HashMap, HashSet};

/// Does the text end in the same passage `reps` times in a row (whole repeats only)?
/// A run of a few distinct characters ("......") is padding, not a loop.
pub fn periodic_tail(text: &str, min_period: usize, max_period: usize, reps: usize) -> bool {
    let s: Vec<char> = text.chars().collect();
    let n = s.len();
    if reps < 2 {
        return false;
    }
    let top = max_period.min(n / reps);
    for p in min_period.max(1)..=top {
        let unit = &s[n - p..];
        let same = (2..=reps).all(|k| &s[n - k * p..n - (k - 1) * p] == unit);
        if same && unit.iter().collect::<HashSet<_>>().len() > 4 {
            return true;
        }
    }
    false
}

fn norm(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Split like JS `split(/[.!?]+\s+|\n+/)`; the last piece (unfinished sentence) is returned separately.
fn split_sentences(text: &str) -> (Vec<String>, String) {
    let c: Vec<char> = text.chars().collect();
    let mut parts = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < c.len() {
        if c[i] == '\n' {
            parts.push(c[start..i].iter().collect());
            while i < c.len() && c[i] == '\n' {
                i += 1;
            }
            start = i;
        } else if matches!(c[i], '.' | '!' | '?') {
            let mut j = i;
            while j < c.len() && matches!(c[j], '.' | '!' | '?') {
                j += 1;
            }
            if j < c.len() && c[j].is_whitespace() {
                parts.push(c[start..i].iter().collect());
                while j < c.len() && c[j].is_whitespace() {
                    j += 1;
                }
                start = j;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    (parts, c[start..].iter().collect())
}

fn strip_bullet(s: &str) -> &str {
    let t = if let Some(r) = s.strip_prefix(['-', '*', '•']) {
        r
    } else {
        let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
        match s[digits..].strip_prefix(['.', ')']) {
            Some(r) if digits > 0 => r,
            _ => return s,
        }
    };
    t.trim_start()
}

const LONG: usize = 24;
const LONG_TIMES: u32 = 4;
const SHORT: usize = 8;
const SHORT_TIMES: u32 = 6;

pub struct RepeatWatch {
    sentences: bool,
    min_period: usize,
    max_period: usize,
    reps: usize,
    tail: String,
    pending: String,
    seen: HashMap<String, u32>,
    since_check: usize,
    tripped: bool,
}

impl RepeatWatch {
    fn new(sentences: bool, min_period: usize, reps: usize) -> RepeatWatch {
        RepeatWatch {
            sentences,
            min_period,
            max_period: 400,
            reps,
            tail: String::new(),
            pending: String::new(),
            seen: HashMap::new(),
            since_check: 0,
            tripped: false,
        }
    }

    /// For reasoning: repeated sentences, plus a periodic tail (24..400 x3).
    pub fn thinking() -> RepeatWatch {
        RepeatWatch::new(true, 24, 3)
    }

    /// For answers: periodic tail only (30..400 x4); an answer may list similar lines.
    pub fn answer() -> RepeatWatch {
        RepeatWatch::new(false, 30, 4)
    }

    /// True once the text is looping (and stays true).
    pub fn feed(&mut self, text: &str) -> bool {
        if self.tripped || text.is_empty() {
            return self.tripped;
        }
        if self.sentences {
            self.pending.push_str(text);
            let (parts, rest) = split_sentences(&self.pending);
            self.pending = rest;
            for raw in parts {
                let n = norm(&raw);
                let s = strip_bullet(&n);
                let len = s.chars().count();
                if len < SHORT {
                    continue;
                }
                let c = self.seen.entry(s.to_string()).or_insert(0);
                *c += 1;
                if *c >= if len >= LONG { LONG_TIMES } else { SHORT_TIMES } {
                    self.tripped = true;
                    return true;
                }
            }
        }
        let lower = text.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
        // Keep the original's per-chunk whitespace behaviour: leading/trailing space of a chunk is collapsed to one.
        let lead = text.starts_with(char::is_whitespace);
        let trail = text.ends_with(char::is_whitespace);
        if lead {
            self.tail.push(' ');
        }
        self.tail.push_str(&lower);
        if trail && !lower.is_empty() {
            self.tail.push(' ');
        }
        let count = self.tail.chars().count();
        if count > 1400 {
            let cut = self.tail.char_indices().nth(count - 1400).map(|(i, _)| i).unwrap_or(0);
            self.tail.drain(..cut);
        }
        self.since_check += text.chars().count();
        if self.since_check >= 200 {
            self.since_check = 0;
            if periodic_tail(&self.tail, self.min_period, self.max_period, self.reps) {
                self.tripped = true;
            }
        }
        self.tripped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(w: &mut RepeatWatch, text: &str, size: usize) -> Option<usize> {
        let c: Vec<char> = text.chars().collect();
        let mut fed = 0;
        for ch in c.chunks(size) {
            fed += ch.len();
            if w.feed(&ch.iter().collect::<String>()) {
                return Some(fed);
            }
        }
        None
    }

    #[test]
    fn same_sentence_round_and_round() {
        let mut w = RepeatWatch::thinking();
        let t = format!(
            "First I add the numbers. {}",
            "Wait, let me check that 2 + 2 = 4 again. Yes it is 4. ".repeat(8)
        );
        let hit = stream(&mut w, &t, 7).expect("loop");
        assert!(hit < 400, "cut early, after {hit}");
    }

    #[test]
    fn passage_repeated_without_full_stops() {
        let mut w = RepeatWatch::thinking();
        let t = "so the config is loaded from the home folder and then merged with defaults and ".repeat(6);
        assert!(stream(&mut w, &t, 7).is_some());
    }

    #[test]
    fn short_true_thing_may_recur() {
        let mut w = RepeatWatch::thinking();
        let t = "2 + 2 = 4. So the sum is right. Now the product. 2 + 2 = 4. And the product is 6. 2 + 2 = 4. Done. ";
        assert!(stream(&mut w, t, 7).is_none());
    }

    #[test]
    fn ordinary_reasoning_left_alone() {
        let mut w = RepeatWatch::thinking();
        let t = "The test fails in parse.js on line 40. The error says the token is undefined. \
            I should read the tokenizer first. The tokenizer returns null at end of input. \
            So the parser needs to handle null. I will add a check before the loop. \
            Then I will run the test again. If it passes I will run the whole suite. ";
        assert!(stream(&mut w, t, 7).is_none());
    }

    #[test]
    fn list_of_similar_lines_is_not_a_loop() {
        let mut w = RepeatWatch::thinking();
        let lines: Vec<String> =
            (0..30).map(|i| format!("- file src/module{i}.js exports a handler and has no tests")).collect();
        assert!(stream(&mut w, &(lines.join("\n") + "\n"), 7).is_none());
    }

    #[test]
    fn padding_is_not_a_loop() {
        assert!(!periodic_tail(&format!("thinking{}", ".".repeat(300)), 24, 400, 3));
        assert!(!periodic_tail(&format!("a b c {}", "- - - - ".repeat(40)), 24, 400, 3));
    }

    #[test]
    fn stays_tripped_and_answer_is_periodic_only() {
        let mut w = RepeatWatch::answer();
        let line = "this is a fairly long repeated answer line. ";
        assert!(stream(&mut w, &line.repeat(3), 9).is_none());
        let mut w = RepeatWatch::answer();
        assert!(stream(&mut w, &line.repeat(10), 9).is_some());
        assert!(w.feed("anything else"));
        assert!(periodic_tail("héllo wörld ünï ".repeat(4).as_str(), 5, 400, 3));
    }
}
