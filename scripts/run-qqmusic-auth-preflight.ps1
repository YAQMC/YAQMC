[CmdletBinding()]
param(
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$fixedHarness = Join-Path $PSScriptRoot 'invoke-qqmusic-auth-preflight-command.ps1'
$outputDirectory = Join-Path $repositoryRoot 'output/qqmusic-auth-account/preflight'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

function Get-UtcTimestamp {
  return [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

if ($SelfTest) {
  $probeLog = Join-Path $outputDirectory 'self-test-argv.log'
  [IO.File]::WriteAllText($probeLog, [string]::Empty, [Text.UTF8Encoding]::new($false))
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixedHarness -ArgvProbe -First alpha -Second 'two words' 2>&1 |
    Tee-Object -FilePath $probeLog
  $probeExit = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  if ($probeExit -ne 0) {
    throw "fixed argv probe returned $probeExit"
  }
  if (-not (Select-String -LiteralPath $probeLog -SimpleMatch 'fixed argv probe passed' -Quiet)) {
    throw 'fixed argv probe output did not reach its ignored log'
  }

  $failureLog = Join-Path $outputDirectory 'self-test-failure.log'
  [IO.File]::WriteAllText($failureLog, [string]::Empty, [Text.UTF8Encoding]::new($false))
  $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixedHarness -CommandId self-test-fail 2>&1 |
    Tee-Object -FilePath $failureLog
  $failureExit = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  if ($failureExit -ne 23) {
    throw "fixed failure probe returned $failureExit instead of 23"
  }

  $silentLog = Join-Path $outputDirectory 'self-test-silent.log'
  [IO.File]::WriteAllText($silentLog, [string]::Empty, [Text.UTF8Encoding]::new($false))
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixedHarness -CommandId self-test-silent 2>&1 |
    Tee-Object -FilePath $silentLog
  $silentExit = $LASTEXITCODE
  if ($silentExit -ne 0 -or -not (Test-Path -LiteralPath $silentLog)) {
    throw 'fixed silent-success probe did not preserve an empty log'
  }
  $silentHash = (Get-FileHash -LiteralPath $silentLog -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($silentHash -cne 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') {
    throw 'fixed silent-success probe did not retain a hashable empty log'
  }
  [Console]::WriteLine('preflight harness self-test passed')
  exit 0
}

$commands = @(
  @{ Id = 'secret-scan'; Display = 'powershell -File scripts/check-secrets.ps1' },
  @{ Id = 'format'; Display = 'npm run format:check' },
  @{ Id = 'lint'; Display = 'npm run lint' },
  @{ Id = 'typecheck'; Display = 'npm run typecheck' },
  @{ Id = 'frontend-tests'; Display = 'npm test' },
  @{ Id = 'vite-build'; Display = 'npm run build' },
  @{ Id = 'rustfmt'; Display = 'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check' },
  @{ Id = 'clippy'; Display = 'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings' },
  @{ Id = 'rust-tests'; Display = 'cargo test --manifest-path src-tauri/Cargo.toml --all-targets' },
  @{ Id = 'local-release-binary'; Display = 'npm run tauri -- build --no-bundle' }
)

# This fail-closed check documents and enforces that deterministic preflight never
# reaches the live/ignored authentication surface.
$forbiddenLivePattern = '--ignored|qqmusic_auth_start|ptqrshow|ptqrlogin'
foreach ($command in $commands) {
  if ($command.Id -match $forbiddenLivePattern -or $command.Display -match $forbiddenLivePattern) {
    throw "live authentication command is forbidden in deterministic preflight: $($command.Id)"
  }
}

$runId = [Guid]::NewGuid().ToString('N')
$startedAtUtc = Get-UtcTimestamp
$resultPath = Join-Path $outputDirectory "$runId.json"
$records = [Collections.Generic.List[object]]::new()
$status = 'passed'

function Write-PreflightResult {
  param(
    [Parameter(Mandatory = $true)][string]$OverallStatus,
    [Parameter(Mandatory = $true)][string]$EndedAtUtc
  )

  $document = [ordered]@{
    schemaVersion = 1
    runId = $runId
    startedAtUtc = $startedAtUtc
    endedAtUtc = $EndedAtUtc
    status = $OverallStatus
    commands = @($records)
  }
  $json = $document | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($resultPath, $json, [Text.UTF8Encoding]::new($false))
}

for ($index = 0; $index -lt $commands.Count; $index += 1) {
  $command = $commands[$index]
  $commandStart = Get-UtcTimestamp
  $logPath = Join-Path $outputDirectory ('{0}-{1}-{2}.log' -f $runId, ($index + 1).ToString('D2'), $command.Id)
  [IO.File]::WriteAllText($logPath, [string]::Empty, [Text.UTF8Encoding]::new($false))
  [Console]::WriteLine(('preflight [{0}/{1}] {2}' -f ($index + 1), $commands.Count, $command.Display))
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixedHarness -CommandId $command.Id 2>&1 |
    Tee-Object -FilePath $logPath
  $commandExit = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  $commandEnd = Get-UtcTimestamp
  $logHash = (Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $records.Add([ordered]@{
      id = $command.Id
      display = $command.Display
      exitCode = $commandExit
      startedAtUtc = $commandStart
      endedAtUtc = $commandEnd
      logSha256 = $logHash
    })

  if ($commandExit -ne 0) {
    $status = 'failed'
    Write-PreflightResult -OverallStatus $status -EndedAtUtc $commandEnd
    [Console]::Error.WriteLine("preflight failed at $($command.Id); result: $resultPath")
    exit $commandExit
  }
}

$endedAtUtc = Get-UtcTimestamp
Write-PreflightResult -OverallStatus $status -EndedAtUtc $endedAtUtc
[Console]::WriteLine("preflight passed; result: $resultPath")
exit 0
