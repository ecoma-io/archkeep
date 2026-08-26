//! Shared helpers for the official generic rules.
//!
//! This library is NOT published: it exists only so `tests/` and `examples/`
//! in this crate link against the same code, and so future rules can reuse the
//! helpers PR2's two rules establish.

pub mod params;
pub mod topology;

/// Extracts the axis value from a colon-form tag if present.
///
/// Returns `Some(value)` if `tag` contains a colon and the part before it is
/// `axis`, otherwise `None`. A tag with no colon carries no axis value.
///
/// # Examples
///
/// ```
/// use archkeep_rules::axis_value;
///
/// assert_eq!(axis_value("layer:domain", "layer"), Some("domain"));
/// assert_eq!(axis_value("type:library", "type"), Some("library"));
/// assert_eq!(axis_value("layer-domain", "layer"), None);
/// assert_eq!(axis_value("layer", "layer"), None);
/// ```
pub fn axis_value<'a>(tag: &'a str, axis: &str) -> Option<&'a str> {
    tag.split_once(':')
        .filter(|(prefix, _)| *prefix == axis)
        .map(|(_, value)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axis_value_extracts_when_present() {
        assert_eq!(axis_value("layer:domain", "layer"), Some("domain"));
        assert_eq!(axis_value("type:library", "type"), Some("library"));
        assert_eq!(axis_value("scope:sdk", "scope"), Some("sdk"));
    }

    #[test]
    fn axis_value_returns_none_when_absent() {
        assert_eq!(axis_value("layer-domain", "layer"), None);
        assert_eq!(axis_value("layer", "layer"), None);
        assert_eq!(axis_value("layer:domain", "type"), None);
        assert_eq!(axis_value("", "layer"), None);
    }
}
