$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "ASSERT: $Message" }
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) {
    throw "ASSERT: $Message (expected '$Expected', actual '$Actual')"
  }
}

function Write-TestPng {
  param([string]$Path, [int]$Width, [int]$Height, [byte]$Tag)
  $bytes = New-Object byte[] 48
  $signature = [byte[]](0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  [Array]::Copy($signature, 0, $bytes, 0, $signature.Length)
  $bytes[8] = 0
  $bytes[9] = 0
  $bytes[10] = 0
  $bytes[11] = 13
  [Text.Encoding]::ASCII.GetBytes('IHDR').CopyTo($bytes, 12)
  for ($offset = 0; $offset -lt 4; $offset += 1) {
    $shift = (3 - $offset) * 8
    $bytes[16 + $offset] = [byte](($Width -shr $shift) -band 0xff)
    $bytes[20 + $offset] = [byte](($Height -shr $shift) -band 0xff)
  }
  $bytes[24] = 8
  $bytes[25] = 6
  $bytes[32] = $Tag
  [IO.File]::WriteAllBytes($Path, $bytes)
}

$collectorPath = Join-Path $PSScriptRoot 'capture-windows-lyrics-acceptance.ps1'
. $collectorPath

$testHadWebViewArguments = Test-Path Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$testPreviousWebViewArguments = if ($testHadWebViewArguments) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
} else {
  $null
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("yaqmc-lyrics-collector-{0}" -f [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$binaryPath = Join-Path $testRoot 'yaqmc-test.exe'
[IO.File]::WriteAllBytes($binaryPath, [Text.Encoding]::UTF8.GetBytes('YAQMC collector test binary'))

function Reset-MockState {
  param([string]$Mode)
  $script:Mode = $Mode
  $script:Calls = New-Object 'Collections.Generic.List[object]'
  $script:ProcessStopCount = 0
  $script:CdpDisconnectCount = 0
  $script:CaptureCount = 0
  $script:NextControl = ''
  $script:Provider = if ($Mode -eq 'provider-mismatch') { 'qqmusic' } else { 'fake' }
  $script:Query = if ($Mode -eq 'search-mismatch') { '?provider=qqmusic' } else { '?provider=fake' }
  $script:SongId = if ($Mode -eq 'song-mismatch') { 'paper-sun' } else { 'quiet-light' }
  $script:LyricsOpen = $false
  $script:Focus = $false
  $script:Fullscreen = $false
  $script:ReducedMotion = $false
  $script:PlayerState = 'idle'
  $script:Theme = 'dark'
  $script:Locale = 'en-US'
  $script:BackgroundMode = 'default'
  $script:CurrentWidth = 1280
  $script:CurrentHeight = 800
}

function Add-Call {
  param([string]$Kind, [string]$Name, $Data = $null)
  $script:Calls.Add([pscustomobject]@{ Kind = $Kind; Name = $Name; Data = $Data }) | Out-Null
}

function New-TestAdapters {
  $processAdapter = @{
    Start = {
      param([string]$Path)
      Add-Call 'Process' 'Start' $Path
      return [pscustomobject]@{ Id = 4242; Path = $Path }
    }
    Stop = {
      param($Handle)
      Add-Call 'Process' 'Stop' $Handle.Id
      $script:ProcessStopCount += 1
    }
  }
  $cdpAdapter = @{
    Connect = {
      param([int]$Port)
      Add-Call 'Cdp' 'Connect' $Port
      return [pscustomobject]@{ Port = $Port; TargetId = 'page-1' }
    }
    Send = {
      param($Connection, [string]$Method, $Params)
      Add-Call 'Cdp' $Method $Params
      if ($Method -eq 'Runtime.evaluate') {
        $expression = [string]$Params.expression
        if ($expression.Contains('YAQMC:origin')) { return 'http://tauri.localhost' }
        if ($expression.Contains('YAQMC:identity')) {
          return [pscustomobject]@{
            readyState = 'complete'
            search = $script:Query
            provider = $script:Provider
          }
        }
        if ($expression.Contains('YAQMC:home-play')) {
          $script:NextControl = 'home-play'
          return [pscustomobject]@{ count = 1; x = 120; y = 140; width = 80; height = 32; accessibleName = 'Play album' }
        }
        if ($expression.Contains('YAQMC:playerbar-lyrics')) {
          $script:NextControl = 'playerbar-lyrics'
          return [pscustomobject]@{ count = 1; x = 820; y = 720; width = 32; height = 32; accessibleName = 'Show lyrics' }
        }
        if ($expression.Contains('YAQMC:focus-toggle')) {
          $script:NextControl = 'focus-toggle'
          return [pscustomobject]@{ count = 1; x = 40; y = 32; width = 32; height = 32; accessibleName = 'Focus' }
        }
        if ($expression.Contains('YAQMC:header-fullscreen')) {
          $script:NextControl = 'header-fullscreen'
          return [pscustomobject]@{ count = 1; x = 78; y = 32; width = 32; height = 32; accessibleName = 'Fullscreen' }
        }
        if ($expression.Contains('YAQMC:lyrics-close')) {
          $script:NextControl = 'lyrics-close'
          return [pscustomobject]@{ count = 1; x = 960; y = 32; width = 32; height = 32; accessibleName = 'Close lyrics' }
        }
        if ($expression.Contains('YAQMC:playerbar-fullscreen')) {
          $script:NextControl = 'playerbar-fullscreen'
          return [pscustomobject]@{ count = 1; x = 950; y = 720; width = 32; height = 32; accessibleName = 'Fullscreen lyrics' }
        }
        if ($expression.Contains('YAQMC:semantic-state')) {
          if ($script:Mode -eq 'stale-cdp') {
            return [pscustomobject]@{
              lyricsOpen = $false; focus = $false; nativeFullscreen = $false
              reducedMotion = $script:ReducedMotion; songId = $script:SongId; playerState = 'idle'
            }
          }
          return [pscustomobject]@{
            lyricsOpen = $script:LyricsOpen
            focus = $script:Focus
            nativeFullscreen = $script:Fullscreen
            reducedMotion = $script:ReducedMotion
            songId = $script:SongId
            playerState = $script:PlayerState
            theme = $script:Theme
            locale = $script:Locale
            backgroundMode = $script:BackgroundMode
            backgroundImagePresent = $script:BackgroundMode -eq 'image' -or $script:BackgroundMode -eq 'artwork'
          }
        }
        if ($expression.Contains('YAQMC:motion-metrics')) {
          return [pscustomobject]@{
            maxTransitionDurationMs = 0
            maxAnimationDurationMs = 0
            activeWordRafProgressWrites = 0
          }
        }
        if ($expression -eq 'window.__TAURI_INTERNALS__.metadata.currentWindow.label') { return 'main' }
        if ($expression.Contains("invoke('plugin:window|set_fullscreen'")) { $script:Fullscreen = $false; return $null }
        if ($expression.Contains("invoke('plugin:window|is_fullscreen'")) { return [bool]$script:Fullscreen }
      }
      if ($Method -eq 'Input.dispatchMouseEvent' -and $Params.type -eq 'mouseReleased') {
        switch ($script:NextControl) {
          'home-play' { $script:PlayerState = 'playing' }
          'playerbar-lyrics' { $script:LyricsOpen = $true }
          'focus-toggle' { $script:Focus = -not $script:Focus }
          'header-fullscreen' { $script:Fullscreen = -not $script:Fullscreen }
          'lyrics-close' { $script:LyricsOpen = $false; $script:Focus = $false; $script:Fullscreen = $false }
          'playerbar-fullscreen' { $script:LyricsOpen = $true; $script:Fullscreen = $true }
        }
      }
      if ($Method -eq 'Input.dispatchKeyEvent' -and $Params.type -eq 'keyUp') {
        if ($Params.key -eq 'F11') {
          if ($script:LyricsOpen) { $script:Fullscreen = -not $script:Fullscreen }
        } elseif ($Params.key -eq 'Escape') {
          if ($script:Fullscreen) { $script:Fullscreen = $false }
          elseif ($script:Focus) { $script:Focus = $false }
          elseif ($script:LyricsOpen) { $script:LyricsOpen = $false }
        }
      }
      if ($Method -eq 'Emulation.setEmulatedMedia') {
        $feature = @($Params.features | Where-Object { $_.name -eq 'prefers-reduced-motion' })[0]
        $script:ReducedMotion = $feature.value -eq 'reduce'
      }
      if ($Method -eq 'YAQMC.configureCase') {
        $script:Theme = $Params.theme
        $script:Locale = $Params.locale
        $script:BackgroundMode = $Params.backgroundMode
        return [pscustomobject]@{ configured = $true; theme = $Params.theme; locale = $Params.locale; backgroundMode = $Params.backgroundMode }
      }
      return $null
    }
    Disconnect = {
      param($Connection)
      Add-Call 'Cdp' 'Disconnect' $Connection.TargetId
      $script:CdpDisconnectCount += 1
    }
  }
  $hwndAdapter = @{
    ResolveExactlyOne = {
      param($Handle)
      Add-Call 'Hwnd' 'ResolveExactlyOne' $Handle.Id
      if ($script:Mode -eq 'ambiguous-hwnd') { throw 'ambiguous HWND' }
      return [IntPtr]1234
    }
    GetClientBounds = {
      param($Window, $RequestedWidth, $RequestedHeight)
      if ($null -ne $RequestedWidth) { $script:CurrentWidth = [int]$RequestedWidth }
      if ($null -ne $RequestedHeight) { $script:CurrentHeight = [int]$RequestedHeight }
      Add-Call 'Hwnd' 'GetClientBounds' "$RequestedWidth`x$RequestedHeight"
      return [pscustomobject]@{
        LogicalBounds = [ordered]@{ x = 40; y = 24; width = $script:CurrentWidth; height = $script:CurrentHeight; unit = 'logical-px' }
        PhysicalBounds = [ordered]@{ x = 40; y = 24; width = $script:CurrentWidth; height = $script:CurrentHeight; unit = 'physical-px' }
        DevicePixelRatio = 1
        MonitorId = '\\.\DISPLAY1'
      }
    }
  }
  $captureAdapter = @{
    SaveClientPng = {
      param($Window, [string]$Path, $PhysicalBounds)
      Add-Call 'Capture' 'SaveClientPng' $Path
      $script:CaptureCount += 1
      if ($script:Mode -eq 'capture-throw') { throw 'capture failed' }
      Write-TestPng $Path ([int]$PhysicalBounds.width) ([int]$PhysicalBounds.height) ([byte]$script:CaptureCount)
      if ($script:Mode -eq 'crop-mismatch') {
        return [pscustomobject]@{ PhysicalBounds = [ordered]@{ x = 40; y = 24; width = $PhysicalBounds.width + 1; height = $PhysicalBounds.height; unit = 'physical-px' } }
      }
      return [pscustomobject]@{ PhysicalBounds = $PhysicalBounds }
    }
  }
  return [pscustomobject]@{ Process = $processAdapter; Cdp = $cdpAdapter; Hwnd = $hwndAdapter; Capture = $captureAdapter }
}

function Invoke-TestCapture {
  param([string]$Mode, [string]$Name)
  Reset-MockState $Mode
  $adapters = New-TestAdapters
  $output = Join-Path $testRoot $Name
  $result = Invoke-WindowsLyricsAcceptance `
    -Binary $binaryPath `
    -Output $output `
    -BuildKind 'tauri-no-bundle' `
    -Process $adapters.Process `
    -Cdp $adapters.Cdp `
    -Hwnd $adapters.Hwnd `
    -Capture $adapters.Capture `
    -TestMode
  return [pscustomobject]@{ Output = $output; Result = $result }
}

try {
  $success = Invoke-TestCapture 'success' 'success'
  $manifestPath = Join-Path $success.Output 'manifest.json'
  Assert-True (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'success must write manifest'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-Equal $manifest.provider 'fake' 'manifest provider identity'
  Assert-Equal $manifest.fixtureSongId 'quiet-light' 'manifest fixture identity'
  Assert-Equal @($manifest.cases).Count 10 'manifest case count'
  Assert-Equal $script:CaptureCount 10 'only ten required native crops are saved'
  Assert-Equal $script:CdpDisconnectCount 1 'success disconnect count'
  Assert-Equal $script:ProcessStopCount 1 'success process stop count'

  $navigate = @($script:Calls | Where-Object { $_.Kind -eq 'Cdp' -and $_.Name -eq 'Page.navigate' })[0]
  Assert-Equal $navigate.Data.url 'http://tauri.localhost/?provider=fake' 'same-origin fake-provider reload'
  $mouseCalls = @($script:Calls | Where-Object { $_.Kind -eq 'Cdp' -and $_.Name -eq 'Input.dispatchMouseEvent' })
  Assert-True ($mouseCalls.Count -ge 4) 'home Play and PlayerBar Lyrics must use pointer press/release'
  $keyCalls = @($script:Calls | Where-Object { $_.Kind -eq 'Cdp' -and $_.Name -eq 'Input.dispatchKeyEvent' })
  Assert-True ($keyCalls.Count -gt 0) 'keyboard acceptance paths must use CDP key input'
  $identityIndex = -1
  $firstMouseIndex = -1
  for ($index = 0; $index -lt $script:Calls.Count; $index += 1) {
    $call = $script:Calls[$index]
    if ($firstMouseIndex -lt 0 -and $call.Name -eq 'Input.dispatchMouseEvent') { $firstMouseIndex = $index }
    if ($call.Name -eq 'Runtime.evaluate' -and ([string]$call.Data.expression).Contains('YAQMC:semantic-state')) {
      $identityIndex = $index
      break
    }
  }
  Assert-True ($firstMouseIndex -ge 0 -and $identityIndex -gt $firstMouseIndex) 'real pointer inputs precede fixture identity proof'
  foreach ($id in @('W01','W02','W03','W04','W05','W06','W07','W08','W09','S01')) {
    $pngPath = Join-Path $success.Output ("screenshots\{0}.png" -f $id)
    Assert-True (Test-Path -LiteralPath $pngPath -PathType Leaf) "$id native crop exists"
    $bytes = [IO.File]::ReadAllBytes($pngPath)
    Assert-True ($bytes.Length -eq 48 -and $bytes[32] -gt 0) "$id crop bytes came from Capture adapter"
  }
  $verificationOutput = & node (Join-Path $PSScriptRoot 'verify-lyrics-acceptance.mjs') --platform windows --root $success.Output 2>&1
  Assert-Equal $LASTEXITCODE 0 ("generated evidence must pass the Node verifier: {0}" -f ($verificationOutput -join ' | '))

  foreach ($failure in @(
    @{ Mode = 'provider-mismatch'; Name = 'provider-failure' },
    @{ Mode = 'search-mismatch'; Name = 'search-failure' },
    @{ Mode = 'song-mismatch'; Name = 'song-failure' },
    @{ Mode = 'ambiguous-hwnd'; Name = 'hwnd-failure' },
    @{ Mode = 'stale-cdp'; Name = 'stale-failure' },
    @{ Mode = 'crop-mismatch'; Name = 'crop-failure' }
  )) {
    $failed = $false
    try { Invoke-TestCapture $failure.Mode $failure.Name | Out-Null } catch { $failed = $true }
    Assert-True $failed "$($failure.Mode) must throw"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $testRoot "$($failure.Name)\manifest.json"))) "$($failure.Mode) must not write pass manifest"
  }

  foreach ($environmentCase in @('present', 'absent')) {
    if ($environmentCase -eq 'present') {
      $original = '--existing=`"quoted value`" --flag'
      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $original
    } else {
      Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
      $original = $null
    }
    $failed = $false
    try { Invoke-TestCapture 'capture-throw' "cleanup-$environmentCase" | Out-Null } catch { $failed = $true }
    Assert-True $failed "capture throw ($environmentCase) must propagate"
    Assert-Equal $script:CdpDisconnectCount 1 "cleanup disconnect count ($environmentCase)"
    Assert-Equal $script:ProcessStopCount 1 "cleanup process stop count ($environmentCase)"
    if ($environmentCase -eq 'present') {
      Assert-Equal $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS $original 'existing WebView2 environment restored byte-for-byte'
    } else {
      Assert-True (-not (Test-Path Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)) 'originally absent WebView2 environment remains absent'
    }
  }

  Write-Output 'capture-windows-lyrics-acceptance tests passed'
} catch {
  Write-Output $_.ScriptStackTrace
  Write-Error $_
  exit 1
} finally {
  if ($testHadWebViewArguments) {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $testPreviousWebViewArguments
  } else {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolvedTestRoot).StartsWith('yaqmc-lyrics-collector-', [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
