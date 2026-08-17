//! `{data}/core.pid` so the Electron supervisor can reap a leftover core.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const CORE_PID_FILE: &str = "core.pid";

pub struct CorePidFile {
    path: PathBuf,
}

impl CorePidFile {
    pub fn path_in(data_dir: &Path) -> PathBuf {
        data_dir.join(CORE_PID_FILE)
    }

    pub fn write(data_dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(data_dir)?;
        let path = Self::path_in(data_dir);
        fs::write(&path, format!("{}\n", std::process::id()))?;
        Ok(Self { path })
    }
}

impl Drop for CorePidFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_current_pid_and_removes_on_drop() {
        let root = tempfile::tempdir().expect("temp");
        let data = root.path().join("data");
        let path = CorePidFile::path_in(&data);
        {
            let _guard = CorePidFile::write(&data).expect("write pid");
            let contents = fs::read_to_string(&path).expect("read pid");
            assert_eq!(contents.trim(), std::process::id().to_string());
        }
        assert!(!path.exists());
    }
}
