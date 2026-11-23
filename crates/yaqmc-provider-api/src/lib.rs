//! Host-neutral contracts shared by YAQMC music providers and Core.
//!
//! The public DTOs intentionally retain the frozen desktop wire representation.
//! Provider implementations own protocol-specific parsing and map into these values
//! at this boundary.

pub mod account;
pub mod catalog;
pub mod comments;
pub mod credentials;
pub mod device_playback;
pub mod media;
pub mod model;
pub mod playback;
pub mod profile;
pub mod provider;
pub mod registry;
pub mod scope;
pub mod storage;

pub use account::*;
pub use catalog::*;
pub use comments::*;
pub use credentials::*;
pub use device_playback::*;
pub use media::*;
pub use model::*;
pub use playback::*;
pub use profile::*;
pub use provider::*;
pub use registry::*;
pub use scope::*;
pub use storage::*;
