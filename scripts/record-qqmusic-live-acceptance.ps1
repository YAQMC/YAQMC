[CmdletBinding(DefaultParameterSetName = 'SelfTest')]
param(
  [Parameter(ParameterSetName = 'Start', Mandatory = $true)]
  [switch]$Start,

  [Parameter(ParameterSetName = 'Record', Mandatory = $true)]
  [switch]$Record,

  [Parameter(ParameterSetName = 'Finish', Mandatory = $true)]
  [switch]$Finish,

  [Parameter(ParameterSetName = 'SelfTest', Mandatory = $true)]
  [switch]$SelfTest,

  [Parameter(ParameterSetName = 'Record', Mandatory = $true)]
  [ValidateSet(
    'qr-created',
    'authenticated',
    'restart-restore',
    'favorites-read',
    'favorite-write',
    'playlists-read',
    'playlist-write',
    'recent-history-read',
    'temporary-playlist-cleanup',
    'entitlement-playback',
    'lyrics-regression',
    'logout',
    'guest-fallback'
  )]
  [string]$Check,

  [Parameter(ParameterSetName = 'Record', Mandatory = $true)]
  [ValidateSet('pass', 'fail', 'blocked', 'not-supported')]
  [string]$Result,

  [Parameter(ParameterSetName = 'Record', Mandatory = $true)]
  [ValidateSet(
    'none',
    'owner-unavailable',
    'upstream-unavailable',
    'authentication-rejected',
    'entitlement-required',
    'endpoint-changed',
    'capability-not-advertised',
    'cleanup-failed',
    'unknown'
  )]
  [string]$Classification,

  [Parameter(ParameterSetName = 'Record')]
  [ValidateSet('true', 'false')]
  [string]$CapabilityAdvertised
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $repositoryRoot 'output/qqmusic-auth-account/live-acceptance'
$currentPath = Join-Path $outputDirectory 'current.json'
$scannerPath = Join-Path $PSScriptRoot 'check-secrets.ps1'
$requiredChecks = @(
  'qr-created',
  'authenticated',
  'restart-restore',
  'favorites-read',
  'favorite-write',
  'playlists-read',
  'playlist-write',
  'recent-history-read',
  'temporary-playlist-cleanup',
  'entitlement-playback',
  'lyrics-regression',
  'logout',
  'guest-fallback'
)
$allowedResults = @('pass', 'fail', 'blocked', 'not-supported')
$allowedClassifications = @(
  'none',
  'owner-unavailable',
  'upstream-unavailable',
  'authentication-rejected',
  'entitlement-required',
  'endpoint-changed',
  'capability-not-advertised',
  'cleanup-failed',
  'unknown'
)

function Get-UtcTimestamp {
  return [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function Assert-RecordSemantics {
  param(
    [Parameter(Mandatory = $true)][string]$CheckName,
    [Parameter(Mandatory = $true)][string]$CheckResult,
    [Parameter(Mandatory = $true)][string]$FailureClassification,
    [AllowNull()][string]$Advertised
  )

  if ($CheckResult -eq 'pass' -and $FailureClassification -ne 'none') {
    throw 'a passing check must use classification none'
  }
  if (($CheckResult -eq 'fail' -or $CheckResult -eq 'blocked') -and $FailureClassification -eq 'none') {
    throw 'a failed or blocked check must use a non-none classification'
  }

  if ($CheckName -eq 'recent-history-read') {
    if ([string]::IsNullOrWhiteSpace($Advertised)) {
      throw 'recent-history-read requires CapabilityAdvertised true or false'
    }
    if ($CheckResult -eq 'not-supported') {
      if ($Advertised -ine 'false' -or $FailureClassification -ne 'capability-not-advertised') {
        throw 'not-supported recent history requires an unadvertised capability classification'
      }
      return
    }
    if ($Advertised -ine 'true' -or ($CheckResult -ne 'pass' -and $CheckResult -ne 'fail')) {
      throw 'advertised recent history must record pass or fail'
    }
    return
  }

  if (-not [string]::IsNullOrWhiteSpace($Advertised)) {
    throw 'CapabilityAdvertised is valid only for recent-history-read'
  }
  if ($CheckResult -eq 'not-supported') {
    throw 'not-supported is valid only for recent-history-read'
  }
}

function Assert-ExactProperties {
  param(
    [Parameter(Mandatory = $true)][object]$Value,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Expected.Count) {
    throw "$Context has an unexpected field count"
  }
  foreach ($name in $Expected) {
    if ($actual -cnotcontains $name) {
      throw "$Context is missing or renaming a required field"
    }
  }
}

function Assert-UtcTimestamp {
  param(
    [Parameter(Mandatory = $true)][object]$Value,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($Value -isnot [string]) {
    throw "$Context must be a UTC timestamp string"
  }
  $parsed = [DateTimeOffset]::MinValue
  $valid = [DateTimeOffset]::TryParseExact(
    $Value,
    'o',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$parsed
  )
  if (-not $valid -or $parsed.Offset -ne [TimeSpan]::Zero) {
    throw "$Context must be an exact UTC round-trip timestamp"
  }
}

function ConvertTo-SafeCurrentRun {
  param([Parameter(Mandatory = $true)][object]$Document)

  Assert-ExactProperties -Value $Document -Expected @(
    'schemaVersion',
    'runId',
    'startedAtUtc',
    'status',
    'checks'
  ) -Context 'current live acceptance document'
  if (($Document.schemaVersion -isnot [int] -and $Document.schemaVersion -isnot [long]) -or
      $Document.schemaVersion -ne 1) {
    throw 'current live acceptance schema version is invalid'
  }
  if ($Document.runId -isnot [string] -or $Document.runId -cnotmatch '^[a-f0-9]{32}$') {
    throw 'current live acceptance run ID is invalid'
  }
  Assert-UtcTimestamp -Value $Document.startedAtUtc -Context 'run start'
  if ($Document.status -isnot [string] -or $Document.status -cne 'in-progress') {
    throw 'current live acceptance status is invalid'
  }

  $safeRows = [Collections.Generic.List[object]]::new()
  $seenChecks = @{}
  foreach ($row in @($Document.checks)) {
    if ($null -eq $row) {
      throw 'current live acceptance check row is null'
    }
    if ($row.check -eq 'recent-history-read') {
      Assert-ExactProperties -Value $row -Expected @(
        'check',
        'result',
        'classification',
        'capabilityAdvertised',
        'recordedAtUtc'
      ) -Context 'recent-history-read row'
    } else {
      Assert-ExactProperties -Value $row -Expected @(
        'check',
        'result',
        'classification',
        'recordedAtUtc'
      ) -Context 'live acceptance check row'
    }
    if ($row.check -isnot [string] -or $requiredChecks -cnotcontains $row.check) {
      throw 'current live acceptance check name is invalid'
    }
    if ($seenChecks.ContainsKey($row.check)) {
      throw "current live acceptance check is duplicated: $($row.check)"
    }
    $seenChecks[$row.check] = $true
    if ($row.result -isnot [string] -or $allowedResults -cnotcontains $row.result) {
      throw 'current live acceptance result is invalid'
    }
    if ($row.classification -isnot [string] -or
        $allowedClassifications -cnotcontains $row.classification) {
      throw 'current live acceptance classification is invalid'
    }
    Assert-UtcTimestamp -Value $row.recordedAtUtc -Context 'check record time'

    $advertised = $null
    if ($row.check -eq 'recent-history-read') {
      if ($row.capabilityAdvertised -isnot [bool]) {
        throw 'recent-history-read capability flag must be boolean'
      }
      $advertised = if ($row.capabilityAdvertised) { 'true' } else { 'false' }
    }
    Assert-RecordSemantics -CheckName $row.check -CheckResult $row.result -FailureClassification $row.classification -Advertised $advertised

    $safeRow = [ordered]@{
      check = $row.check
      result = $row.result
      classification = $row.classification
    }
    if ($row.check -eq 'recent-history-read') {
      $safeRow.capabilityAdvertised = $row.capabilityAdvertised
    }
    $safeRow.recordedAtUtc = $row.recordedAtUtc
    $safeRows.Add([pscustomobject]$safeRow)
  }

  return [pscustomobject][ordered]@{
    schemaVersion = 1
    runId = $Document.runId
    startedAtUtc = $Document.startedAtUtc
    status = 'in-progress'
    checks = @($safeRows)
  }
}

function Get-Aggregate {
  param([Parameter(Mandatory = $true)][object[]]$Checks)

  $byName = @{}
  foreach ($row in $Checks) {
    $byName[$row.check] = $row
  }
  $missing = @($requiredChecks | Where-Object { -not $byName.ContainsKey($_) })
  if ($missing.Count -gt 0) {
    throw "cannot finish; missing checks: $($missing -join ', ')"
  }

  $recent = $byName['recent-history-read']
  $recentAllowed = $recent.result -eq 'pass' -or
    ($recent.result -eq 'not-supported' -and
      $recent.capabilityAdvertised -eq $false -and
      $recent.classification -eq 'capability-not-advertised')
  if (-not $recentAllowed) {
    if ($recent.result -eq 'blocked') {
      return @{ Status = 'blocked'; RecentVerified = $false }
    }
    return @{ Status = 'failed'; RecentVerified = $false }
  }

  $nonRecent = @($Checks | Where-Object { $_.check -ne 'recent-history-read' })
  if (@($nonRecent | Where-Object { $_.result -eq 'fail' }).Count -gt 0) {
    return @{ Status = 'failed'; RecentVerified = ($recent.result -eq 'pass') }
  }
  if (@($nonRecent | Where-Object { $_.result -ne 'pass' }).Count -gt 0) {
    return @{ Status = 'blocked'; RecentVerified = ($recent.result -eq 'pass') }
  }
  return @{ Status = 'passed'; RecentVerified = ($recent.result -eq 'pass') }
}

function Write-ValidatedJsonAtomically {
  param(
    [Parameter(Mandatory = $true)][object]$Document,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $directory = Split-Path -Parent $Destination
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporaryPath = Join-Path $directory ('.acceptance-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $json = $Document | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scannerPath -Path $temporaryPath | Out-Null
    $scannerExit = $LASTEXITCODE
    if ($scannerExit -ne 0) {
      throw "secret scanner rejected live acceptance evidence with exit $scannerExit"
    }
    if (Test-Path -LiteralPath $Destination) {
      [IO.File]::Replace($temporaryPath, $Destination, $null)
    } else {
      [IO.File]::Move($temporaryPath, $Destination)
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

function Read-CurrentRun {
  if (-not (Test-Path -LiteralPath $currentPath)) {
    throw 'no live acceptance run is active; use -Start first'
  }
  $document = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
  return (ConvertTo-SafeCurrentRun -Document $document)
}

function Invoke-SelfTest {
  Assert-RecordSemantics -CheckName 'qr-created' -CheckResult 'pass' -FailureClassification 'none' -Advertised $null
  Assert-RecordSemantics -CheckName 'recent-history-read' -CheckResult 'not-supported' -FailureClassification 'capability-not-advertised' -Advertised 'false'
  foreach ($invalid in @(
      { Assert-RecordSemantics -CheckName 'favorites-read' -CheckResult 'not-supported' -FailureClassification 'capability-not-advertised' -Advertised $null },
      { Assert-RecordSemantics -CheckName 'recent-history-read' -CheckResult 'not-supported' -FailureClassification 'capability-not-advertised' -Advertised 'true' },
      { Assert-RecordSemantics -CheckName 'logout' -CheckResult 'pass' -FailureClassification 'unknown' -Advertised $null }
    )) {
    $rejected = $false
    try {
      & $invalid
    } catch {
      $rejected = $true
    }
    if (-not $rejected) {
      throw 'live acceptance self-test accepted an invalid row'
    }
  }

  $rows = foreach ($checkName in $requiredChecks) {
    if ($checkName -eq 'recent-history-read') {
      [pscustomobject]@{
        check = $checkName
        result = 'not-supported'
        classification = 'capability-not-advertised'
        capabilityAdvertised = $false
        recordedAtUtc = Get-UtcTimestamp
      }
    } else {
      [pscustomobject]@{
        check = $checkName
        result = 'pass'
        classification = 'none'
        recordedAtUtc = Get-UtcTimestamp
      }
    }
  }
  $aggregate = Get-Aggregate -Checks @($rows)
  if ($aggregate.Status -ne 'passed' -or $aggregate.RecentVerified -ne $false) {
    throw 'live acceptance self-test produced an incorrect aggregate'
  }

  $safeCurrent = [pscustomobject][ordered]@{
    schemaVersion = 1
    runId = 'a' * 32
    startedAtUtc = Get-UtcTimestamp
    status = 'in-progress'
    checks = @()
  }
  $normalized = ConvertTo-SafeCurrentRun -Document $safeCurrent
  if ($normalized.runId -cne ('a' * 32)) {
    throw 'live acceptance self-test did not normalize a valid current run'
  }
  $safeCurrent | Add-Member -NotePropertyName note -NotePropertyValue 'forbidden'
  $rejectedExtraField = $false
  try {
    $null = ConvertTo-SafeCurrentRun -Document $safeCurrent
  } catch {
    $rejectedExtraField = $true
  }
  if (-not $rejectedExtraField) {
    throw 'live acceptance self-test accepted an arbitrary evidence field'
  }

  $selfTestDirectory = Join-Path ([IO.Path]::GetTempPath()) ('yaqmc-live-recorder-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($selfTestDirectory) | Out-Null
  try {
    $testPath = Join-Path $selfTestDirectory 'result.json'
    $document = [ordered]@{
      schemaVersion = 1
      runId = [Guid]::NewGuid().ToString('N')
      startedAtUtc = Get-UtcTimestamp
      endedAtUtc = Get-UtcTimestamp
      status = $aggregate.Status
      recentHistoryVerified = $aggregate.RecentVerified
      checks = @($rows)
    }
    Write-ValidatedJsonAtomically -Document $document -Destination $testPath
    if (-not (Test-Path -LiteralPath $testPath)) {
      throw 'live acceptance self-test did not atomically write evidence'
    }
  } finally {
    if (Test-Path -LiteralPath $selfTestDirectory) {
      Remove-Item -LiteralPath $selfTestDirectory -Recurse -Force
    }
  }
  [Console]::WriteLine('live acceptance recorder self-test passed')
}

if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}

if ($Start) {
  [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
  if (Test-Path -LiteralPath $currentPath) {
    throw 'an unfinished live acceptance run already exists'
  }
  $document = [ordered]@{
    schemaVersion = 1
    runId = [Guid]::NewGuid().ToString('N')
    startedAtUtc = Get-UtcTimestamp
    status = 'in-progress'
    checks = @()
  }
  Write-ValidatedJsonAtomically -Document $document -Destination $currentPath
  [Console]::WriteLine("live acceptance run started: $($document.runId)")
  exit 0
}

if ($Record) {
  Assert-RecordSemantics -CheckName $Check -CheckResult $Result -FailureClassification $Classification -Advertised $CapabilityAdvertised
  $document = Read-CurrentRun
  if ($document.status -ne 'in-progress') {
    throw 'the current live acceptance run is not in progress'
  }
  if (@($document.checks | Where-Object { $_.check -eq $Check }).Count -gt 0) {
    throw "check already recorded: $Check"
  }

  $row = [ordered]@{
    check = $Check
    result = $Result
    classification = $Classification
  }
  if ($Check -eq 'recent-history-read') {
    $row.capabilityAdvertised = [Convert]::ToBoolean($CapabilityAdvertised)
  }
  $row.recordedAtUtc = Get-UtcTimestamp
  $document.checks = @($document.checks) + @([pscustomobject]$row)
  Write-ValidatedJsonAtomically -Document $document -Destination $currentPath
  [Console]::WriteLine("recorded live acceptance check: $Check")
  exit 0
}

if ($Finish) {
  $document = Read-CurrentRun
  if ($document.status -ne 'in-progress') {
    throw 'the current live acceptance run is not in progress'
  }
  $aggregate = Get-Aggregate -Checks @($document.checks)
  $document.status = $aggregate.Status
  $document.recentHistoryVerified = $aggregate.RecentVerified
  $document | Add-Member -NotePropertyName endedAtUtc -NotePropertyValue (Get-UtcTimestamp)
  $finalPath = Join-Path $outputDirectory ($document.runId + '.json')
  Write-ValidatedJsonAtomically -Document $document -Destination $finalPath
  Remove-Item -LiteralPath $currentPath -Force
  [Console]::WriteLine("live acceptance run $($document.status): $finalPath")
  if ($document.status -eq 'passed') {
    exit 0
  }
  exit 1
}

throw 'one operation parameter set is required'
