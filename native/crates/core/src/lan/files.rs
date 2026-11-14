//! Safe file naming for received files.

use std::path::{Path, PathBuf};

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Turns a peer-supplied name into a single, harmless path component.
/// Never trust the sender: strip directories, separators and reserved names.
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).trim_start_matches('.');
    let mut cleaned: String = cleaned.chars().take(200).collect();
    if cleaned.is_empty() {
        cleaned = "file".to_owned();
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        cleaned.insert(0, '_');
    }
    cleaned
}

/// Picks `dir/name`, or `dir/name (1).ext`, `dir/name (2).ext`, ... if taken.
pub fn unique_path(dir: &Path, name: &str, also_taken: &[PathBuf]) -> PathBuf {
    let candidate = dir.join(name);
    let free = |p: &Path| !p.exists() && !also_taken.iter().any(|t| t == p);
    if free(&candidate) {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| free(p))
        .expect("unbounded search always finds a free name")
}

/// Best-effort display name for a picked path or Android `content://` URI.
pub fn display_name_from_path(path: &str) -> String {
    let last = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let decoded = percent_decode(last);
    // Android document ids look like "primary:Download/report.pdf".
    let decoded = decoded.rsplit(['/', ':']).next().unwrap_or(&decoded).to_owned();
    if decoded.is_empty() { "file".to_owned() } else { decoded }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_paths_and_bad_characters() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_file_name("a<b>c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_file_name(".."), "file");
        assert_eq!(sanitize_file_name(".hidden"), "hidden");
        assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_name("report.pdf"), "report.pdf");
    }

    #[test]
    fn finds_unique_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"x").unwrap();
        assert_eq!(unique_path(dir.path(), "a.txt", &[]), dir.path().join("a (1).txt"));
        let taken = vec![dir.path().join("a (1).txt")];
        assert_eq!(unique_path(dir.path(), "a.txt", &taken), dir.path().join("a (2).txt"));
        assert_eq!(unique_path(dir.path(), "b", &[]), dir.path().join("b"));
    }

    #[test]
    fn names_from_paths_and_content_uris() {
        assert_eq!(display_name_from_path("C:\\Users\\me\\photo.jpg"), "photo.jpg");
        assert_eq!(
            display_name_from_path(
                "content://com.android.providers.downloads.documents/document/primary%3ADownload%2Freport.pdf"
            ),
            "report.pdf"
        );
    }
}
