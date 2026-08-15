use serde_json::{Map, Value};
use std::collections::BTreeMap;

const MAX_FIELDS: usize = 24;
const MAX_ID: usize = 40;
const MAX_TEXT: usize = 240;
const MAX_SECRET: usize = 512;
const MAX_OPTIONS: usize = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsField {
    pub id: String,
    pub field_type: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub secret: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ValidatedSettings {
    pub values: BTreeMap<String, Value>,
    pub secrets: BTreeMap<String, String>,
}

pub fn parse_settings_fields(schema: &Value) -> Result<Vec<SettingsField>, String> {
    let fields = schema
        .get("fields")
        .and_then(Value::as_array)
        .ok_or_else(|| "settingsSchema.fields must be an array".to_owned())?;
    if fields.len() > MAX_FIELDS {
        return Err("settingsSchema has too many fields".into());
    }
    let mut parsed = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for field in fields {
        let id = field
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "settings field id is required".to_owned())?;
        if id.len() > MAX_ID
            || !id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return Err("settings field id is invalid".into());
        }
        if !seen.insert(id.to_owned()) {
            return Err("settings field ids must be unique".into());
        }
        let field_type = field.get("type").and_then(Value::as_str).unwrap_or("text");
        match field_type {
            "boolean" | "number" | "text" | "password" | "select" | "multiselect" | "color"
            | "slider" | "keybind" => {}
            _ => return Err(format!("unsupported settings field type {field_type}")),
        }
        parsed.push(SettingsField {
            id: id.to_owned(),
            field_type: field_type.to_owned(),
            label: field
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .chars()
                .take(80)
                .collect(),
            description: field
                .get("description")
                .and_then(Value::as_str)
                .map(|value| value.chars().take(160).collect()),
            required: field
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            secret: field_type == "password"
                || field
                    .get("secret")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
        });
    }
    Ok(parsed)
}

pub fn defaults_from_schema(schema: &Value) -> ValidatedSettings {
    let Ok(fields) = parse_settings_fields(schema) else {
        return ValidatedSettings::default();
    };
    let Some(raw_fields) = schema.get("fields").and_then(Value::as_array) else {
        return ValidatedSettings::default();
    };
    let mut validated = ValidatedSettings::default();
    for (field, raw) in fields.iter().zip(raw_fields.iter()) {
        if let Some(default) = raw.get("default") {
            if let Ok(value) = coerce_field(field, raw, default) {
                if field.secret {
                    if let Some(secret) = value.as_str() {
                        validated
                            .secrets
                            .insert(field.id.clone(), secret.to_owned());
                    }
                } else {
                    validated.values.insert(field.id.clone(), value);
                }
            }
        }
    }
    validated
}

pub fn validate_settings_write(
    schema: &Value,
    patch: &Map<String, Value>,
    current: &ValidatedSettings,
) -> Result<ValidatedSettings, String> {
    let fields = parse_settings_fields(schema)?;
    let raw_fields = schema
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next = current.clone();
    for field in &fields {
        if let Some(incoming) = patch.get(&field.id) {
            let spec = raw_fields
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(field.id.as_str()))
                .ok_or_else(|| "settings field is missing from schema".to_owned())?;
            let value = coerce_field(field, spec, incoming)?;
            if field.secret {
                let secret = value
                    .as_str()
                    .ok_or_else(|| "password settings must be strings".to_owned())?;
                next.secrets.insert(field.id.clone(), secret.to_owned());
                next.values.remove(&field.id);
            } else {
                next.values.insert(field.id.clone(), value);
                next.secrets.remove(&field.id);
            }
        } else if field.required
            && !next.values.contains_key(&field.id)
            && !next.secrets.contains_key(&field.id)
        {
            return Err(format!("settings field {} is required", field.id));
        }
    }
    for key in patch.keys() {
        if !fields.iter().any(|field| field.id == *key) {
            return Err(format!("unknown settings field {key}"));
        }
    }
    Ok(next)
}

pub fn public_settings(fields: &[SettingsField], settings: &ValidatedSettings) -> Value {
    let mut map = Map::new();
    for field in fields {
        if field.secret {
            map.insert(
                field.id.clone(),
                Value::Bool(
                    settings
                        .secrets
                        .get(&field.id)
                        .is_some_and(|value| !value.is_empty()),
                ),
            );
        } else if let Some(value) = settings.values.get(&field.id) {
            map.insert(field.id.clone(), value.clone());
        }
    }
    Value::Object(map)
}

fn coerce_field(field: &SettingsField, spec: &Value, value: &Value) -> Result<Value, String> {
    match field.field_type.as_str() {
        "boolean" => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| format!("{} must be a boolean", field.id)),
        "number" | "slider" => {
            let number = value
                .as_f64()
                .ok_or_else(|| format!("{} must be a number", field.id))?;
            if !number.is_finite() {
                return Err(format!("{} must be finite", field.id));
            }
            let min = spec.get("min").and_then(Value::as_f64).unwrap_or(f64::MIN);
            let max = spec.get("max").and_then(Value::as_f64).unwrap_or(f64::MAX);
            if number < min || number > max {
                return Err(format!("{} is out of range", field.id));
            }
            Ok(Value::from(number))
        }
        "text" | "keybind" => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} must be text", field.id))?;
            if text.len() > MAX_TEXT {
                return Err(format!("{} is too long", field.id));
            }
            Ok(Value::String(text.to_owned()))
        }
        "password" => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} must be text", field.id))?;
            if text.len() > MAX_SECRET {
                return Err(format!("{} is too long", field.id));
            }
            Ok(Value::String(text.to_owned()))
        }
        "color" => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} must be a color", field.id))?;
            if !is_hex_color(text) {
                return Err(format!("{} must be a #RRGGBB color", field.id));
            }
            Ok(Value::String(text.to_ascii_uppercase()))
        }
        "select" => {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{} must be a string", field.id))?;
            let options = spec
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if options.len() > MAX_OPTIONS {
                return Err("select has too many options".into());
            }
            if !options.iter().any(|option| option.as_str() == Some(text)) {
                return Err(format!("{} is not an allowed option", field.id));
            }
            Ok(Value::String(text.to_owned()))
        }
        "multiselect" => {
            let items = value
                .as_array()
                .ok_or_else(|| format!("{} must be an array", field.id))?;
            let options = spec
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if items.len() > options.len() || items.len() > MAX_OPTIONS {
                return Err(format!("{} has too many values", field.id));
            }
            let mut selected = Vec::new();
            for item in items {
                let text = item
                    .as_str()
                    .ok_or_else(|| format!("{} values must be strings", field.id))?;
                if !options.iter().any(|option| option.as_str() == Some(text)) {
                    return Err(format!("{} contains an unknown option", field.id));
                }
                if !selected.iter().any(|existing| existing == text) {
                    selected.push(text.to_owned());
                }
            }
            Ok(Value::from(selected))
        }
        _ => Err(format!(
            "unsupported settings field type {}",
            field.field_type
        )),
    }
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_defaults_and_rejects_unknown_fields() {
        let schema = json!({
            "fields": [
                { "id": "resume", "type": "boolean", "default": true },
                { "id": "token", "type": "password", "default": "secret" },
                { "id": "accent", "type": "color", "default": "#aabbcc" }
            ]
        });
        let defaults = defaults_from_schema(&schema);
        assert_eq!(defaults.values.get("resume"), Some(&Value::Bool(true)));
        assert_eq!(
            defaults.secrets.get("token").map(String::as_str),
            Some("secret")
        );
        let mut patch = Map::new();
        patch.insert("resume".into(), json!(false));
        patch.insert("unknown".into(), json!(1));
        assert!(validate_settings_write(&schema, &patch, &defaults).is_err());
        let mut patch = Map::new();
        patch.insert("resume".into(), json!(false));
        let next = validate_settings_write(&schema, &patch, &defaults).expect("ok");
        assert_eq!(next.values.get("resume"), Some(&Value::Bool(false)));
        let public = public_settings(&parse_settings_fields(&schema).unwrap(), &next);
        assert_eq!(public.get("token"), Some(&Value::Bool(true)));
        assert_ne!(public.get("token"), Some(&json!("secret")));
    }
}
