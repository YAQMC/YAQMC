use std::{env, fs, io};

use yaqmc_core::plugin::{component::ProviderComponent, manifest::ProviderCapability};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args_os().nth(1).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: verify-provider-component <component.wasm>",
        )
    })?;
    let bytes = fs::read(path)?;
    let component = ProviderComponent::load(&bytes, [ProviderCapability::Catalog])?;
    let response = component
        .invoke(
            ProviderCapability::Catalog,
            "catalog.search",
            r#"{"query":"component","kind":"song","page":1,"limit":20}"#,
        )
        .await?;
    let response: serde_json::Value = serde_json::from_str(&response)?;
    let item_count = response
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    if item_count == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "component search returned no items",
        )
        .into());
    }
    println!("verified provider component: {item_count} catalog item(s)");
    Ok(())
}
