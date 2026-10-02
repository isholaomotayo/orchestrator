//! A small WHATWG server-sent-events parser. Chunks may split anywhere —
//! mid-line, mid-CRLF, mid-UTF-8 is handled by the caller decoding bytes.

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SseFrame {
    pub id: Option<String>,
    pub event: String,
    pub data: String,
    pub retry: Option<u64>,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buf: String,
    pending_cr: bool,
    event: Option<String>,
    data: Vec<String>,
    id: Option<String>,
    retry: Option<u64>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed text; returns every frame completed by it.
    pub fn push(&mut self, chunk: &str) -> Vec<SseFrame> {
        let mut out = Vec::new();
        for ch in chunk.chars() {
            if self.pending_cr {
                self.pending_cr = false;
                if ch == '\n' {
                    continue;
                } // CRLF counted once
            }
            match ch {
                '\r' => {
                    self.pending_cr = true;
                    self.line(&mut out);
                }
                '\n' => self.line(&mut out),
                c => self.buf.push(c),
            }
        }
        out
    }

    fn line(&mut self, out: &mut Vec<SseFrame>) {
        let line = std::mem::take(&mut self.buf);
        if line.is_empty() {
            // Blank line: dispatch, if anything was collected.
            if !self.data.is_empty() || self.event.is_some() {
                out.push(SseFrame {
                    id: self.id.clone(),
                    event: self.event.take().unwrap_or_else(|| "message".into()),
                    data: self.data.join("\n"),
                    retry: self.retry.take(),
                });
            }
            self.data.clear();
            return;
        }
        if line.starts_with(':') {
            return;
        } // comment / heartbeat
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line.as_str(), ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            "id" if !value.contains('\0') => self.id = Some(value.to_string()),
            "retry" => self.retry = value.parse().ok(),
            _ => {}
        }
    }

    /// The id to send back as Last-Event-ID on reconnect.
    pub fn last_event_id(&self) -> Option<&str> {
        self.id.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAM: &str = "retry: 2000\n\nevent: hello\ndata: {\"a\":1}\n\n: ping\n\nid: i.1\nevent: run.upserted\ndata: line1\ndata: line2\n\n";

    #[test]
    fn parses_frames_comments_and_multiline_data() {
        let frames = SseParser::new().push(STREAM);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].event, "hello");
        assert_eq!(frames[1].id.as_deref(), Some("i.1"));
        assert_eq!(frames[1].data, "line1\nline2");
    }

    #[test]
    fn any_chunk_split_gives_the_same_frames() {
        let whole = SseParser::new().push(STREAM);
        let crlf = STREAM.replace('\n', "\r\n");
        for text in [STREAM.to_string(), crlf] {
            for split in 1..text.len() {
                if !text.is_char_boundary(split) {
                    continue;
                }
                let mut p = SseParser::new();
                let mut got = p.push(&text[..split]);
                got.extend(p.push(&text[split..]));
                assert_eq!(got, whole, "split at {split}");
            }
        }
    }

    #[test]
    fn remembers_the_last_id_for_reconnects() {
        let mut p = SseParser::new();
        p.push("id: abc.7\nevent: x\ndata: {}\n\n");
        assert_eq!(p.last_event_id(), Some("abc.7"));
    }
}
