//! Host-neutral contracts shared by YAQMC music providers and Core.
//!
//! The public DTOs intentionally retain the frozen desktop wire representation.
//! Provider implementations own protocol-specific parsing and map into these values
//! at this boundary.

pub mod account;
pub mod catalog;
pub mod credentials;
pub mod media;
pub mod model;
pub mod playback;
pub mod provider;
pub mod registry;
pub mod storage;

pub use account::*;
pub use catalog::*;
pub use credentials::*;
pub use media::*;
pub use model::*;
pub use playback::*;
pub use provider::*;
pub use registry::*;
pub use storage::*;
