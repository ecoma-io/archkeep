//! Strict parameter validation for generic rules.
//!
//! A rule that silently judges with defaults on a typo'd parameter is the
//! quiet direction — nobody files an issue, and the rule enforces something
/// nobody declared. This module forces every parameter key to be known.
use archkeep_rule_sdk::serde_json::Value;

/// Validates that `params` contains only the keys in `allowed`.
///
/// Returns `Err(())` naming the first unknown key; otherwise `Ok(())`.
///
/// # Examples
///
/// ```
/// use archkeep_rules::params::validate_keys;
/// use archkeep_rule_sdk::serde_json::json;
///
/// assert!(validate_keys(&json!({"axis": "type"}), &["axis"]).is_ok());
/// assert!(validate_keys(&json!({"axis": "type", "min": 1}), &["axis"]).is_err());
/// ```
pub fn validate_keys(params: &Value, allowed: &[&str]) -> Result<(), String> {
    let Some(obj) = params.as_object() else {
        return Err("params is not an object".to_string());
    };
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("unknown key: {key}"));
        }
    }
    Ok(())
}

/// Validates that a string field is present and non-empty.
///
/// Returns `Ok(value)` if the field exists and is non-empty, otherwise `Err`.
pub fn require_non_empty_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("params.{key} is not a non-empty string"))
}

/// Validates a required numeric field ≥ 0.
///
/// Returns `Ok(value)` if present and valid, `Err` if malformed, negative,
/// or missing.
pub fn require_non_negative_number(params: &Value, key: &str) -> Result<u64, String> {
    match params.get(key) {
        None => Err(format!("params.{key} is required")),
        Some(Value::Null) => Err(format!("params.{key} is required")),
        Some(Value::Number(n)) => {
            if n.is_u64() || (n.is_i64() && n.as_i64() >= Some(0)) {
                n.as_u64()
                    .ok_or_else(|| format!("params.{key} is a number that does not fit in u64"))
            } else {
                Err(format!("params.{key} is not a non-negative integer"))
            }
        }
        Some(_) => Err(format!("params.{key} is not a number")),
    }
}

/// Validates an optional numeric field ≥ 0.
///
/// Returns `Ok(Some(value))` if present and valid, `Ok(None)` if absent/null,
/// `Err` if malformed or negative.
pub fn optional_non_negative_number(params: &Value, key: &str) -> Result<Option<u64>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            if n.is_u64() || (n.is_i64() && n.as_i64() >= Some(0)) {
                n.as_u64()
                    .map(Some)
                    .ok_or_else(|| format!("params.{key} is a number that does not fit in u64"))
            } else {
                Err(format!("params.{key} is not a non-negative integer"))
            }
        }
        Some(_) => Err(format!("params.{key} is not a number")),
    }
}

/// Validates an optional array of unique non-empty strings.
///
/// Returns `Ok(values)` if present and valid, `Ok(None)` if absent/null,
/// `Err` if malformed or contains duplicates/empty entries. An EMPTY array is
/// malformed rather than "matches nothing": absent already means "no
/// restriction", so a caller writing `[]` meant something the rule refuses to
/// guess — and the loud reading is the one a reviewer can act on.
pub fn optional_unique_strings(params: &Value, key: &str) -> Result<Option<Vec<String>>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(arr)) => {
            if arr.is_empty() {
                return Err(format!(
                    "params.{key} is an empty array — leave it absent to mean \"no restriction\""
                ));
            }
            let mut values = Vec::with_capacity(arr.len());
            let mut seen = std::collections::HashSet::new();
            for value in arr {
                let s = value
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| format!("params.{key} contains an empty or non-string entry"))?;
                if !seen.insert(s) {
                    return Err(format!("params.{key} contains duplicate entry: {s}"));
                }
                values.push(s.to_string());
            }
            Ok(Some(values))
        }
        Some(_) => Err(format!("params.{key} is not an array")),
    }
}

/// Validates a required array of unique non-empty strings with length ≥ 1.
///
/// Returns `Ok(values)` if present and valid, `Err` otherwise.
pub fn require_unique_strings(params: &Value, key: &str) -> Result<Vec<String>, String> {
    let Some(arr) = params.get(key).and_then(|v| v.as_array()) else {
        return Err(format!("params.{key} is not an array"));
    };
    if arr.is_empty() {
        return Err(format!("params.{key} is empty"));
    }
    let mut values = Vec::with_capacity(arr.len());
    let mut seen = std::collections::HashSet::new();
    for value in arr {
        let s = value
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("params.{key} contains an empty or non-string entry"))?;
        if !seen.insert(s) {
            return Err(format!("params.{key} contains duplicate entry: {s}"));
        }
        values.push(s.to_string());
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use archkeep_rule_sdk::serde_json::json;

    #[test]
    fn validate_keys_accepts_known_keys() {
        assert!(validate_keys(&json!({"axis": "type"}), &["axis"]).is_ok());
        assert!(validate_keys(&json!({"axis": "type", "min": 1}), &["axis", "min"]).is_ok());
    }

    #[test]
    fn validate_keys_rejects_unknown_keys() {
        assert!(validate_keys(&json!({"axis": "type", "maxx": 1}), &["axis", "max"]).is_err());
        assert!(validate_keys(&json!({"typo": "value"}), &["axis"]).is_err());
    }

    #[test]
    fn require_non_empty_str_works() {
        assert_eq!(
            require_non_empty_str(&json!({"axis": "type"}), "axis").unwrap(),
            "type"
        );
        assert!(require_non_empty_str(&json!({"axis": ""}), "axis").is_err());
        assert!(require_non_empty_str(&json!({}), "axis").is_err());
    }

    #[test]
    fn require_non_negative_number_works() {
        assert_eq!(
            require_non_negative_number(&json!({"max": 5}), "max").unwrap(),
            5
        );
        assert_eq!(
            require_non_negative_number(&json!({"max": 0}), "max").unwrap(),
            0
        );
        assert!(require_non_negative_number(&json!({}), "max").is_err());
        assert!(require_non_negative_number(&json!({"max": null}), "max").is_err());
        assert!(require_non_negative_number(&json!({"max": -1}), "max").is_err());
        assert!(require_non_negative_number(&json!({"max": 1.5}), "max").is_err());
        assert!(require_non_negative_number(&json!({"max": "1"}), "max").is_err());
    }

    #[test]
    fn optional_non_negative_number_works() {
        assert_eq!(
            optional_non_negative_number(&json!({"min": 1}), "min").unwrap(),
            Some(1)
        );
        assert_eq!(
            optional_non_negative_number(&json!({"min": 0}), "min").unwrap(),
            Some(0)
        );
        assert_eq!(
            optional_non_negative_number(&json!({}), "min").unwrap(),
            None
        );
        assert_eq!(
            optional_non_negative_number(&json!({"min": null}), "min").unwrap(),
            None
        );
        assert!(optional_non_negative_number(&json!({"min": -1}), "min").is_err());
        assert!(optional_non_negative_number(&json!({"min": 1.5}), "min").is_err());
        assert!(optional_non_negative_number(&json!({"min": "1"}), "min").is_err());
    }

    #[test]
    fn optional_unique_strings_works() {
        assert_eq!(
            optional_unique_strings(&json!({"match": ["a", "b"]}), "match").unwrap(),
            Some(vec!["a".to_string(), "b".to_string()])
        );
        assert_eq!(optional_unique_strings(&json!({}), "match").unwrap(), None);
        assert_eq!(
            optional_unique_strings(&json!({"match": null}), "match").unwrap(),
            None
        );
        assert!(optional_unique_strings(&json!({"match": []}), "match").is_err());
        assert!(optional_unique_strings(&json!({"match": ["a", "a"]}), "match").is_err());
        assert!(optional_unique_strings(&json!({"match": ["", "b"]}), "match").is_err());
    }

    #[test]
    fn require_unique_strings_works() {
        assert_eq!(
            require_unique_strings(&json!({"tags": ["a", "b"]}), "tags").unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(require_unique_strings(&json!({}), "tags").is_err());
        assert!(require_unique_strings(&json!({"tags": []}), "tags").is_err());
        assert!(require_unique_strings(&json!({"tags": ["a", "a"]}), "tags").is_err());
    }
}
