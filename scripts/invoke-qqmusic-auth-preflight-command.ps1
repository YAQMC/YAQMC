[CmdletBinding(DefaultParameterSetName = 'Command')]
param(
  [Parameter(ParameterSetName = 'Command', Mandatory = $true)]
  [ValidateSet(
    'secret-scan',
    'format',
    'lint',
    'typecheck',
    'frontend-tests',
    'vite-build',
    'rustfmt',
    'clippy',
    'rust-tests',
    'local-release-binary',
    'self-test-silent',
    'self-test-fail'
  )]
  [string]$CommandId,

  [Parameter(ParameterSetName = 'Probe', Mandatory = $true)]
  [switch]$ArgvProbe,

  [Parameter(ParameterSetName = 'Probe', Mandatory = $true)]
  [string]$First,

  [Parameter(ParameterSetName = 'Probe', Mandatory = $true)]
  [string]$Second
)

$ErrorActionPreference = 'Stop'

if ($PSCmdlet.ParameterSetName -eq 'Probe') {
  if ($First -cne 'alpha' -or $Second -cne 'two words') {
    [Console]::Error.WriteLine('fixed argv probe rejected its arguments')
    exit 17
  }
  [Console]::WriteLine('fixed argv probe passed')
  exit 0
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

switch ($CommandId) {
  'secret-scan' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/check-secrets.ps1
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'format' {
    & npm.cmd run format:check
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'lint' {
    & npm.cmd run lint
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'typecheck' {
    & npm.cmd run typecheck
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'frontend-tests' {
    & npm.cmd test
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'vite-build' {
    & npm.cmd run build
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'rustfmt' {
    & cargo.exe fmt --manifest-path src-tauri/Cargo.toml --all -- --check
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'clippy' {
    & cargo.exe clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'rust-tests' {
    & cargo.exe test --manifest-path src-tauri/Cargo.toml --all-targets
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'local-release-binary' {
    & npm.cmd run tauri -- build --no-bundle
    $commandExit = $LASTEXITCODE
    exit $commandExit
  }
  'self-test-fail' {
    [Console]::WriteLine('fixed failure probe')
    exit 23
  }
  'self-test-silent' {
    exit 0
  }
  default {
    [Console]::Error.WriteLine('unreachable preflight command ID')
    exit 64
  }
}
