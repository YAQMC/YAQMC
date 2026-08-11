[CmdletBinding()]
param(
  [string]$Binary,
  [string]$Output,
  [string]$BuildKind
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Utf8NoBom {
  param([string]$Path, [string]$Value)
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-LowerSha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-LogicalBounds {
  param($Value)
  return [ordered]@{
    x = [double]$Value.x
    y = [double]$Value.y
    width = [double]$Value.width
    height = [double]$Value.height
    unit = 'logical-px'
  }
}

function ConvertTo-PhysicalBounds {
  param($Value)
  return [ordered]@{
    x = [double]$Value.x
    y = [double]$Value.y
    width = [double]$Value.width
    height = [double]$Value.height
    unit = 'physical-px'
  }
}

function Test-BoundsEqual {
  param($Left, $Right)
  foreach ($field in @('x', 'y', 'width', 'height', 'unit')) {
    if ($Left.$field -ne $Right.$field) { return $false }
  }
  return $true
}

function Get-FreeLoopbackPort {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Receive-CdpMessage {
  param($Connection, [int]$TimeoutMs = 10000)
  $buffer = New-Object byte[] 65536
  $stream = New-Object IO.MemoryStream
  try {
    do {
      $segment = [ArraySegment[byte]]::new($buffer)
      $task = $Connection.Socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
      if (-not $task.Wait($TimeoutMs)) { throw 'Timed out waiting for a CDP message.' }
      $result = $task.Result
      if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
        throw 'The WebView2 CDP socket closed unexpectedly.'
      }
      $stream.Write($buffer, 0, $result.Count)
    } while (-not $result.EndOfMessage)
    $json = [Text.Encoding]::UTF8.GetString($stream.ToArray())
    return $json | ConvertFrom-Json
  } finally {
    $stream.Dispose()
  }
}

function Connect-CdpSocket {
  param([string]$WebSocketUrl)
  $socket = New-Object Net.WebSockets.ClientWebSocket
  [void]$socket.ConnectAsync([Uri]$WebSocketUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return $socket
}

function Get-CdpTargets {
  param([int]$Port)
  $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2)
  return @($targets | Where-Object {
    $_.type -eq 'page' -and $_.webSocketDebuggerUrl -and [string]$_.url -notmatch '[?&]surface='
  })
}

function Send-CdpRaw {
  param($Connection, [string]$Method, $Params)
  $Connection.NextId = [int]$Connection.NextId + 1
  $id = $Connection.NextId
  $message = [ordered]@{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($message)
  $segment = [ArraySegment[byte]]::new($bytes)
  [void]$Connection.Socket.SendAsync(
    $segment,
    [Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()
  while ($true) {
    $response = Receive-CdpMessage $Connection 10000
    $responseProperties = @($response.PSObject.Properties.Name)
    if ($responseProperties -contains 'id' -and [int]$response.id -eq $id) {
      if ($responseProperties -contains 'error' -and $null -ne $response.error) {
        throw "CDP $Method failed: $($response.error.message)"
      }
      return $response.result
    }
    if ($responseProperties -contains 'method' -and $response.method) {
      $Connection.Events.Add($response) | Out-Null
    }
  }
}

function Get-CdpRuntimeResultValue {
  param($EvaluationResult)
  if (-not ($EvaluationResult.PSObject.Properties.Name -contains 'result')) {
    throw 'Runtime.evaluate returned no remote object.'
  }
  $remoteObject = $EvaluationResult.result
  if ($remoteObject.PSObject.Properties.Name -contains 'value') {
    return $remoteObject.value
  }
  if ([string]$remoteObject.type -eq 'undefined') {
    return $null
  }
  throw 'Runtime.evaluate returned no by-value result.'
}

function Get-CdpRuntimeValue {
  param($Connection, [string]$Expression)
  $result = Send-CdpRaw $Connection 'Runtime.evaluate' ([ordered]@{
    expression = $Expression
    awaitPromise = $true
    returnByValue = $true
  })
  if ($result.PSObject.Properties.Name -contains 'exceptionDetails') {
    throw "Runtime.evaluate failed: $($result.exceptionDetails.text)"
  }
  return Get-CdpRuntimeResultValue $result
}

function Send-ProductionPointer {
  param($Connection, $Rect)
  if ([int]$Rect.count -ne 1) { throw 'Expected exactly one visible pointer target.' }
  $x = [double]$Rect.x + ([double]$Rect.width / 2)
  $y = [double]$Rect.y + ([double]$Rect.height / 2)
  Send-CdpRaw $Connection 'Input.dispatchMouseEvent' ([ordered]@{
    type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1
  }) | Out-Null
  Send-CdpRaw $Connection 'Input.dispatchMouseEvent' ([ordered]@{
    type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1
  }) | Out-Null
}

function Send-ProductionKey {
  param($Connection, [string]$Key)
  $codes = @{
    Home = @{ code = 'Home'; value = 36 }
    ArrowDown = @{ code = 'ArrowDown'; value = 40 }
    Enter = @{ code = 'Enter'; value = 13 }
    Escape = @{ code = 'Escape'; value = 27 }
  }
  $keyCode = $codes[$Key]
  if (-not $keyCode) { throw "Unsupported production configuration key: $Key" }
  foreach ($type in @('keyDown', 'keyUp')) {
    Send-CdpRaw $Connection 'Input.dispatchKeyEvent' ([ordered]@{
      type = $type; key = $Key; code = $keyCode.code; windowsVirtualKeyCode = $keyCode.value
    }) | Out-Null
  }
}

function Get-ProductionRect {
  param($Connection, [string]$Marker, [string]$Selector, [int]$Index = 0)
  $selectorJson = $Selector | ConvertTo-Json -Compress
  $expression = @"
/*YAQMC:$Marker*/ (() => {
  const visible = [...document.querySelectorAll($selectorJson)].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  const element = visible[$Index];
  if (!element) return { count: 0 };
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = element.getBoundingClientRect();
  return { count: visible.length, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()
"@
  return Get-CdpRuntimeValue $Connection $expression
}

function Select-ProductionOption {
  param($Connection, [int]$ComboboxIndex, [int]$OptionIndex)
  $rect = Get-ProductionRect $Connection 'settings-combobox' '.settings-page [role="combobox"]' $ComboboxIndex
  if ([int]$rect.count -le $ComboboxIndex -and [int]$rect.count -ne 1) {
    throw "Settings combobox $ComboboxIndex is not visible."
  }
  Send-ProductionPointer $Connection ([pscustomobject]@{
    count = 1; x = $rect.x; y = $rect.y; width = $rect.width; height = $rect.height
  })
  Send-ProductionKey $Connection 'Home'
  for ($index = 0; $index -lt $OptionIndex; $index += 1) {
    Send-ProductionKey $Connection 'ArrowDown'
  }
  Send-ProductionKey $Connection 'Enter'
  Start-Sleep -Milliseconds 80
}

function Invoke-ProductionPointerAtSelector {
  param($Connection, [string]$Marker, [string]$Selector, [int]$Index = 0)
  $rect = Get-ProductionRect $Connection $Marker $Selector $Index
  if ([int]$rect.count -ne 1) { throw "Expected one visible $Marker control." }
  Send-ProductionPointer $Connection $rect
}

function Select-ProductionOptionBySelector {
  param($Connection, [string]$Marker, [string]$Selector, [int]$OptionIndex)
  Invoke-ProductionPointerAtSelector $Connection $Marker $Selector
  Send-ProductionKey $Connection 'Home'
  for ($index = 0; $index -lt $OptionIndex; $index += 1) {
    Send-ProductionKey $Connection 'ArrowDown'
  }
  Send-ProductionKey $Connection 'Enter'
  Start-Sleep -Milliseconds 80
}

function Get-ProductionInteractionState {
  param($Connection)
  return Get-CdpRuntimeValue $Connection @'
/*YAQMC:interaction-state*/ (() => {
  const stage = document.querySelector('.lyrics-stage');
  const play = document.querySelector('.player-controls__play');
  const transport = document.querySelector('.lyrics-fullscreen-transport');
  const activeLine = document.querySelector('.lyrics-line[aria-current="true"]');
  const position = document.querySelector('.player-progress input[type="range"]');
  const playerBar = document.querySelector('.player-bar');
  const visibleSecondaryCount = (selector) => [...document.querySelectorAll(selector)].filter((element) =>
    element.getClientRects().length > 0 && (element.textContent || '').trim().length > 0
  ).length;
  const rect = (element) => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  };
  const selectedVisibility = (label) => {
    const trigger = document.querySelector(`[role="combobox"][aria-label="${label}"]`);
    return /^show\b/i.test((trigger?.textContent || '').trim()) ? 'show' : 'other';
  };
  return {
    timestampUtc: new Date().toISOString(),
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    devicePixelRatio,
    semantic: {
      lyricsOpen: Boolean(stage),
      focus: Boolean(stage && stage.hasAttribute('data-focus')),
      nativeFullscreen: Boolean(stage && stage.hasAttribute('data-fullscreen')),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      songId: stage ? (stage.dataset.songId || null) : null,
      playerState: (() => {
        const label = play ? (play.getAttribute('aria-label') || '') : '';
        if (/pause/i.test(label) || label.includes('\u6682\u505c')) return 'playing';
        if (/play/i.test(label) || label.includes('\u64ad\u653e')) return 'paused';
        return 'unknown';
      })()
    },
    currentTitle: (document.querySelector('.player-bar__track-copy strong')?.textContent || '').trim(),
    activeLineIndex: activeLine ? Number(activeLine.getAttribute('data-line-index')) : -1,
    positionMs: position ? Number(position.value) : -1,
    followVisible: Boolean(document.querySelector('.lyrics-stage__follow')),
    playerBarRect: rect(playerBar),
    stageRect: rect(stage),
    transportDataVisible: Boolean(transport?.hasAttribute('data-visible')),
    transportFocused: Boolean(transport && transport.contains(document.activeElement)),
    transportPointerEvents: transport ? getComputedStyle(transport).pointerEvents : 'missing',
    translationCount: visibleSecondaryCount('.lyrics-line__translation'),
    romanizationCount: visibleSecondaryCount('.lyrics-line__romanization'),
    translationVisibility: selectedVisibility('Translation visibility'),
    romanizationVisibility: selectedVisibility('Romanization visibility')
  };
})()
'@
}

function Wait-ProductionInteractionState {
  param($Connection, [scriptblock]$Predicate, [string]$Failure, [int]$Attempts = 120)
  for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
    $state = Get-ProductionInteractionState $Connection
    if (& $Predicate $state) { return $state }
    Start-Sleep -Milliseconds 50
  }
  throw $Failure
}

function Add-ProductionInteractionAction {
  param($Actions, [string]$Action, $State, $Assertions)
  $Actions.Add([ordered]@{
    timestampUtc = [string]$State.timestampUtc
    action = $Action
    viewport = [ordered]@{
      width = [double]$State.viewportWidth
      height = [double]$State.viewportHeight
      devicePixelRatio = [double]$State.devicePixelRatio
    }
    semantic = $State.semantic
    assertions = $Assertions
  }) | Out-Null
}

function Invoke-ProductionInteractionSequence {
  param($Connection)
  $actions = New-Object 'Collections.Generic.List[object]'

  Invoke-ProductionPointerAtSelector $Connection 'interaction-open-lyrics' '.player-bar__tools > button:first-child'
  $state = Wait-ProductionInteractionState $Connection {
    param($value) $value.semantic.lyricsOpen -and $value.semantic.songId -eq 'quiet-light' -and $value.semantic.playerState -eq 'playing'
  } 'The S01 interaction sequence could not open quiet-light lyrics.'

  $scroll = Get-ProductionRect $Connection 'interaction-scroll' '.lyrics-stage__scroll'
  $scrollX = [double]$scroll.x + ([double]$scroll.width / 2)
  $scrollY = [double]$scroll.y + ([double]$scroll.height / 2)
  Send-CdpRaw $Connection 'Input.dispatchMouseEvent' ([ordered]@{
    type = 'mouseWheel'; x = $scrollX; y = $scrollY; deltaX = 0; deltaY = 360
  }) | Out-Null
  $state = Wait-ProductionInteractionState $Connection { param($value) $value.followVisible } 'Manual lyric scrolling did not expose Follow.'
  Add-ProductionInteractionAction $actions 'manual-scroll-unfollow' $state ([ordered]@{ followVisible = $true })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-follow' '.lyrics-stage__follow'
  $state = Wait-ProductionInteractionState $Connection { param($value) -not $value.followVisible } 'Follow did not restore automatic lyric tracking.'
  Add-ProductionInteractionAction $actions 'follow-restored' $state ([ordered]@{ followVisible = $false })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-line-seek' '.lyrics-line[data-line-index="4"]'
  $state = Wait-ProductionInteractionState $Connection {
    param($value) $value.activeLineIndex -eq 4 -and $value.positionMs -ge 74000 -and $value.positionMs -lt 89000
  } 'Clicking lyric line 4 did not seek into its timing interval.'
  Add-ProductionInteractionAction $actions 'click-seek' $state ([ordered]@{
    activeLineIndex = 4; positionMs = [double]$state.positionMs
  })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-playerbar-play' '.player-controls__play'
  $state = Wait-ProductionInteractionState $Connection { param($value) $value.semantic.playerState -eq 'paused' } 'PlayerBar pause did not converge.'
  Add-ProductionInteractionAction $actions 'pause' $state ([ordered]@{ viaControl = 'playerbar-play' })
  Invoke-ProductionPointerAtSelector $Connection 'interaction-playerbar-play' '.player-controls__play'
  $state = Wait-ProductionInteractionState $Connection { param($value) $value.semantic.playerState -eq 'playing' } 'PlayerBar resume did not converge.'
  Add-ProductionInteractionAction $actions 'resume' $state ([ordered]@{ viaControl = 'playerbar-play' })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-focus' '.lyrics-stage__presentation-controls > button:first-child'
  $state = Wait-ProductionInteractionState $Connection { param($value) $value.semantic.focus -and -not $value.semantic.nativeFullscreen } 'Focus presentation did not converge.'
  $horizontalCoverage =
    [Math]::Abs([double]$state.stageRect.x) -le 0.5 -and
    [Math]::Abs([double]$state.playerBarRect.x) -le 0.5 -and
    [Math]::Abs([double]$state.stageRect.width - [double]$state.viewportWidth) -le 0.5 -and
    [Math]::Abs([double]$state.playerBarRect.width - [double]$state.viewportWidth) -le 0.5
  if (-not $horizontalCoverage) { throw 'Focus mode did not expand both Lyrics and PlayerBar to the viewport width.' }
  Add-ProductionInteractionAction $actions 'focus-playerbar-sizing' $state ([ordered]@{
    horizontalCoverage = $true
    playerBarWidth = [double]$state.playerBarRect.width
    playerBarX = [double]$state.playerBarRect.x
    stageWidth = [double]$state.stageRect.width
    stageX = [double]$state.stageRect.x
    viewportWidth = [double]$state.viewportWidth
  })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-enter-fullscreen' '.lyrics-stage__presentation-controls > button:nth-child(2)'
  $state = Wait-ProductionInteractionState $Connection { param($value) $value.semantic.nativeFullscreen -and $value.semantic.focus } 'Fullscreen did not preserve Focus state.'
  Start-Sleep -Milliseconds 2700
  $state = Wait-ProductionInteractionState $Connection {
    param($value) -not $value.transportDataVisible -and $value.transportPointerEvents -eq 'none'
  } 'Fullscreen transport did not hide after its grace period.'
  Add-ProductionInteractionAction $actions 'transport-hidden' $state ([ordered]@{
    transportDataVisible = $false; transportPointerEvents = 'none'
  })

  $stage = Get-ProductionRect $Connection 'interaction-stage-move' '.lyrics-stage'
  Send-CdpRaw $Connection 'Input.dispatchMouseEvent' ([ordered]@{
    type = 'mouseMoved'
    x = [double]$stage.x + ([double]$stage.width / 2)
    y = [double]$stage.y + ([double]$stage.height / 2)
    button = 'none'
  }) | Out-Null
  $state = Wait-ProductionInteractionState $Connection {
    param($value) $value.transportDataVisible -and $value.transportPointerEvents -eq 'auto'
  } 'Pointer movement did not reveal the fullscreen transport.'
  Add-ProductionInteractionAction $actions 'transport-revealed' $state ([ordered]@{
    transportDataVisible = $true; transportPointerEvents = 'auto'
  })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-transport-play' '.lyrics-fullscreen-transport__play'
  Wait-ProductionInteractionState $Connection { param($value) $value.semantic.playerState -eq 'paused' -and $value.transportFocused } 'Transport pause/focus did not converge.' | Out-Null
  Invoke-ProductionPointerAtSelector $Connection 'interaction-transport-play' '.lyrics-fullscreen-transport__play'
  Wait-ProductionInteractionState $Connection { param($value) $value.semantic.playerState -eq 'playing' -and $value.transportFocused } 'Transport resume/focus did not converge.' | Out-Null
  Start-Sleep -Milliseconds 2600
  $state = Get-ProductionInteractionState $Connection
  if (-not $state.transportDataVisible -or -not $state.transportFocused) {
    throw 'Focused fullscreen transport did not remain pinned past its hide delay.'
  }
  Add-ProductionInteractionAction $actions 'transport-focus-pinned' $state ([ordered]@{
    remainedVisibleAfterMs = 2600; transportDataVisible = $true; transportFocused = $true
  })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-next-track' '.lyrics-fullscreen-transport__controls > button:last-child'
  $state = Wait-ProductionInteractionState $Connection {
    param($value) $value.semantic.songId -eq 'night-geometry' -and $value.semantic.playerState -eq 'playing'
  } 'Fullscreen Next did not converge to playing night-geometry.'
  Add-ProductionInteractionAction $actions 'fullscreen-track-change' $state ([ordered]@{
    previousSongId = 'quiet-light'; nextSongId = 'night-geometry'
  })
  Invoke-ProductionPointerAtSelector $Connection 'interaction-previous-track' '.lyrics-fullscreen-transport__controls > button:first-child'
  $state = Wait-ProductionInteractionState $Connection { param($value) $value.semantic.songId -eq 'quiet-light' } 'Fullscreen Previous did not restore quiet-light.'
  Add-ProductionInteractionAction $actions 'fullscreen-track-restored' $state ([ordered]@{
    previousSongId = 'night-geometry'; nextSongId = 'quiet-light'
  })

  Send-ProductionKey $Connection 'Escape'
  $state = Wait-ProductionInteractionState $Connection {
    param($value) $value.semantic.lyricsOpen -and $value.semantic.focus -and -not $value.semantic.nativeFullscreen
  } 'First Escape did not exit only native fullscreen.'
  Add-ProductionInteractionAction $actions 'escape-fullscreen' $state ([ordered]@{ retainedFocus = $true; retainedLyrics = $true })
  Send-ProductionKey $Connection 'Escape'
  $state = Wait-ProductionInteractionState $Connection {
    param($value) $value.semantic.lyricsOpen -and -not $value.semantic.focus -and -not $value.semantic.nativeFullscreen
  } 'Second Escape did not exit only Focus.'
  Add-ProductionInteractionAction $actions 'escape-focus' $state ([ordered]@{ retainedLyrics = $true })
  Send-ProductionKey $Connection 'Escape'
  $state = Wait-ProductionInteractionState $Connection { param($value) -not $value.semantic.lyricsOpen } 'Third Escape did not close Lyrics.'
  Add-ProductionInteractionAction $actions 'escape-close' $state ([ordered]@{ lyricsClosed = $true })

  Invoke-ProductionPointerAtSelector $Connection 'interaction-settings' '.sidebar__nav button:last-of-type'
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    if (Get-CdpRuntimeValue $Connection '/*YAQMC:interaction-settings-ready*/ Boolean(document.querySelector(".settings-page"))') { break }
    Start-Sleep -Milliseconds 50
  }
  if ($attempt -ge 80) { throw 'Settings did not open for secondary lyric configuration.' }
  Select-ProductionOptionBySelector $Connection 'interaction-translation-setting' '[role="combobox"][aria-label="Translation visibility"]' 1
  Select-ProductionOptionBySelector $Connection 'interaction-romanization-setting' '[role="combobox"][aria-label="Romanization visibility"]' 1
  $state = Wait-ProductionInteractionState $Connection {
    param($value) $value.translationVisibility -eq 'show' -and $value.romanizationVisibility -eq 'show'
  } 'Translation and romanization preferences did not converge to Show.'

  Invoke-ProductionPointerAtSelector $Connection 'interaction-search-navigation' '.sidebar__nav button:nth-of-type(2)'
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    if (Get-CdpRuntimeValue $Connection '/*YAQMC:interaction-search-ready*/ Boolean(document.querySelector(".search-page__field input"))') { break }
    Start-Sleep -Milliseconds 50
  }
  if ($attempt -ge 80) { throw 'Search did not open for the Paper Sun fixture.' }
  Invoke-ProductionPointerAtSelector $Connection 'interaction-search-input' '.search-page__field input'
  Send-CdpRaw $Connection 'Input.insertText' @{ text = 'Paper Sun' } | Out-Null
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    if (Get-CdpRuntimeValue $Connection '/*YAQMC:interaction-search-result*/ Boolean(document.querySelector(".search-results .track-row"))') { break }
    Start-Sleep -Milliseconds 50
  }
  if ($attempt -ge 120) { throw 'Paper Sun search result did not appear.' }
  Invoke-ProductionPointerAtSelector $Connection 'interaction-paper-sun' '.search-results .track-row'
  Wait-ProductionInteractionState $Connection { param($value) $value.currentTitle -eq 'Paper Sun' -and $value.semantic.playerState -eq 'playing' } 'Paper Sun did not begin playback.' | Out-Null
  Invoke-ProductionPointerAtSelector $Connection 'interaction-paper-sun-lyrics' '.player-bar__tools > button:first-child'
  $state = Wait-ProductionInteractionState $Connection {
    param($value)
    $value.semantic.lyricsOpen -and $value.semantic.songId -eq 'paper-sun' -and
      $value.translationCount -gt 0 -and $value.romanizationCount -gt 0
  } 'Paper Sun did not render both configured secondary lyric forms.'
  Add-ProductionInteractionAction $actions 'secondary-lyrics' $state ([ordered]@{
    romanizationCount = [int]$state.romanizationCount
    romanizationVisibility = 'show'
    translationCount = [int]$state.translationCount
    translationVisibility = 'show'
  })

  Send-ProductionKey $Connection 'Escape'
  Invoke-ProductionPointerAtSelector $Connection 'interaction-home-navigation' '.sidebar__nav button:first-of-type'
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    if (Get-CdpRuntimeValue $Connection '/*YAQMC:interaction-home-ready*/ Boolean(document.querySelector(".home-page"))') { break }
    Start-Sleep -Milliseconds 50
  }
  if ($attempt -ge 80) { throw 'Home did not reopen after the secondary lyric probe.' }
  Invoke-ProductionPointerAtSelector $Connection 'interaction-home-play' '.featured-release__actions .button--primary'
  Wait-ProductionInteractionState $Connection { param($value) $value.currentTitle -eq 'Quiet Light' -and $value.semantic.playerState -eq 'playing' } 'The interaction sequence did not restore Quiet Light.' | Out-Null

  return [pscustomobject]@{ actions = @($actions | ForEach-Object { $_ }) }
}

function Select-ProductionManagedImage {
  param($Connection, [string]$Path)
  if (-not ($Connection -is [Collections.IDictionary]) -or -not $Connection.Contains('ProcessId')) {
    throw 'The production CDP connection lacks its visual process identity.'
  }
  Initialize-NativeWindowApi
  $dialog = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    $dialogs = @([YaqmcLyricsAcceptance.NativeWindow]::VisibleFileDialogsForProcess([uint32]$Connection.ProcessId))
    if ($dialogs.Count -gt 1) { throw 'Multiple native file dialogs matched the visual process.' }
    if ($dialogs.Count -eq 1) { $dialog = [IntPtr]$dialogs[0]; break }
    Start-Sleep -Milliseconds 100
  }
  if ($dialog -eq [IntPtr]::Zero) { throw 'The managed-image file dialog did not appear.' }
  if (-not [YaqmcLyricsAcceptance.NativeWindow]::ForceForegroundWindow($dialog)) {
    throw 'The managed-image file dialog could not become foreground.'
  }
  if (-not [YaqmcLyricsAcceptance.NativeWindow]::SelectFileInDialog([IntPtr]$dialog, $Path)) {
    throw 'The managed-image file dialog rejected its deterministic path input.'
  }
  for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
    $ready = Get-CdpRuntimeValue $Connection @'
/*YAQMC:managed-image-converged*/ (() => {
  const replace = [...document.querySelectorAll('.settings-page button.button--secondary')]
    .some((button) => /replace image|更换图片/i.test(button.textContent || ''));
  const image = document.querySelector('.app-background__image');
  return replace && Boolean(image?.getAttribute('src')?.startsWith('data:image/'));
})()
'@
    if ($ready) { return }
    Start-Sleep -Milliseconds 100
  }
  throw 'The managed background image did not converge after native selection.'
}

function Invoke-ProductionConfigureCase {
  param($Connection, $Case)
  $settingsRect = Get-ProductionRect $Connection 'settings-navigation' '.sidebar__nav button:last-of-type'
  Send-ProductionPointer $Connection $settingsRect
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    $ready = Get-CdpRuntimeValue $Connection '/*YAQMC:settings-ready*/ Boolean(document.querySelector(".settings-page"))'
    if ($ready) { break }
    Start-Sleep -Milliseconds 50
  }
  if (-not $ready) { throw 'Settings page did not become ready.' }

  $localeIndex = if ($Case.locale -eq 'zh-CN') { 1 } else { 2 }
  Select-ProductionOption $Connection 0 $localeIndex
  $modeIndex = if ($Case.theme -eq 'light') { 1 } else { 2 }
  Select-ProductionOption $Connection 1 $modeIndex
  $backgroundIndexes = @{ default = 0; artwork = 1; color = 2; image = 3 }
  Select-ProductionOption $Connection 3 ([int]$backgroundIndexes[$Case.backgroundMode])

  if ($Case.backgroundMode -eq 'image') {
    $imageButton = Get-ProductionRect $Connection 'managed-image-picker' '.settings-page .settings-inline-control > button.button--secondary'
    Send-ProductionPointer $Connection $imageButton
    Select-ProductionManagedImage $Connection ([string]$Case.backgroundImagePath)
  }

  $homeRect = Get-ProductionRect $Connection 'home-navigation' '.sidebar__nav button:first-of-type'
  Send-ProductionPointer $Connection $homeRect
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    $homeReady = Get-CdpRuntimeValue $Connection '/*YAQMC:home-ready*/ Boolean(document.querySelector(".home-page"))'
    if ($homeReady) { break }
    Start-Sleep -Milliseconds 50
  }
  if (-not $homeReady) { throw 'Home page did not become ready after configuring appearance.' }
  return Get-CdpRuntimeValue $Connection @'
/*YAQMC:configured-case*/ ({
  configured: true,
  theme: document.documentElement.dataset.theme || '',
  locale: document.documentElement.lang || '',
  backgroundMode: document.documentElement.dataset.background || ''
})
'@
}

function New-ProductionProcessAdapter {
  return @{
    Start = {
      param([string]$Path)
      $existing = @(Get-Process | Where-Object {
        try { [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($Path) } catch { $false }
      })
      if ($existing.Count -ne 0) { throw 'The visual binary is already running.' }
      return Start-Process -FilePath $Path -PassThru
    }
    Stop = {
      param($Handle)
      if ($Handle -and -not $Handle.HasExited) {
        Stop-Process -Id $Handle.Id -Force -ErrorAction SilentlyContinue
        $Handle.WaitForExit(5000) | Out-Null
      }
    }
  }
}

function New-ProductionCdpAdapter {
  return @{
    Connect = {
      param([int]$Port)
      $targets = @()
      for ($attempt = 0; $attempt -lt 80 -and $targets.Count -ne 1; $attempt += 1) {
        try { $targets = @(Get-CdpTargets $Port) } catch { $targets = @() }
        if ($targets.Count -ne 1) { Start-Sleep -Milliseconds 100 }
      }
      if ($targets.Count -ne 1) { throw 'Expected exactly one WebView2 page target.' }
      $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
      return @{
        Port = $Port
        TargetId = [string]$targets[0].id
        TargetUrl = [string]$targets[0].url
        Socket = Connect-CdpSocket ([string]$targets[0].webSocketDebuggerUrl)
        NextId = 0
        Events = New-Object 'Collections.Generic.List[object]'
        BrowserVersion = ([string]$version.Browser -replace '^[^/]+/', '')
      }
    }
    Send = {
      param($Connection, [string]$Method, $Params)
      if ($Method -eq 'YAQMC.waitForLoadEvent') {
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline) {
          $queued = @($Connection.Events | Where-Object { $_.method -eq 'Page.loadEventFired' })
          if ($queued.Count -gt 0) { return $true }
          $message = Receive-CdpMessage $Connection 1000
          if ($message.PSObject.Properties.Name -contains 'method' -and $message.method) {
            $Connection.Events.Add($message) | Out-Null
          }
        }
        throw 'Page.loadEventFired was not observed.'
      }
      if ($Method -eq 'YAQMC.ensureTarget') {
        $targets = @(Get-CdpTargets $Connection.Port)
        if ($targets.Count -ne 1) { throw 'Expected one WebView2 target after reload.' }
        if ([string]$targets[0].id -ne [string]$Connection.TargetId) {
          try { $Connection.Socket.Dispose() } catch {}
          $Connection.Socket = Connect-CdpSocket ([string]$targets[0].webSocketDebuggerUrl)
          $Connection.TargetId = [string]$targets[0].id
          $Connection.TargetUrl = [string]$targets[0].url
          $Connection.NextId = 0
          $Connection.Events.Clear()
        }
        return $true
      }
      if ($Method -eq 'YAQMC.configureCase') {
        return Invoke-ProductionConfigureCase $Connection $Params
      }
      if ($Method -eq 'YAQMC.runInteractionSequence') {
        return Invoke-ProductionInteractionSequence $Connection
      }
      $result = Send-CdpRaw $Connection $Method $Params
      if ($Method -eq 'Runtime.evaluate') {
        if ($result.PSObject.Properties.Name -contains 'exceptionDetails') {
          throw "Runtime.evaluate failed: $($result.exceptionDetails.text)"
        }
        return Get-CdpRuntimeResultValue $result
      }
      return $result
    }
    Disconnect = {
      param($Connection)
      if ($Connection -and $Connection.Socket) {
        try { $Connection.Socket.Dispose() } catch {}
      }
    }
  }
}

function Initialize-NativeWindowApi {
  if (-not ('YaqmcLyricsAcceptance.NativeWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace YaqmcLyricsAcceptance {
  public static class NativeWindow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct MONITORINFOEX {
      public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice;
    }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern bool AdjustWindowRectExForDpi(ref RECT rect, int style, bool menu, int exStyle, uint dpi);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool enabled);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
    public static bool ForceForegroundWindow(IntPtr target) {
      var foreground = GetForegroundWindow();
      uint unused;
      var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out unused);
      var targetThread = GetWindowThreadProcessId(target, out unused);
      var currentThread = GetCurrentThreadId();
      var foregroundAttached = false;
      var targetAttached = false;
      try {
        if (foregroundThread != 0 && currentThread != foregroundThread) {
          foregroundAttached = AttachThreadInput(currentThread, foregroundThread, true);
        }
        if (targetThread != 0 && currentThread != targetThread) {
          targetAttached = AttachThreadInput(currentThread, targetThread, true);
        }
        ShowWindowAsync(target, 9);
        var broughtToTop = BringWindowToTop(target);
        var foregroundSet = SetForegroundWindow(target);
        SetFocus(target);
        return broughtToTop && foregroundSet && GetForegroundWindow() == target;
      } finally {
        if (targetAttached) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundAttached) AttachThreadInput(currentThread, foregroundThread, false);
      }
    }
    public static IntPtr[] VisibleFileDialogsForProcess(uint processId) {
      var dialogs = new List<IntPtr>();
      EnumWindows((window, parameter) => {
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        var className = new StringBuilder(64);
        GetClassName(window, className, className.Capacity);
        if (owner == processId && IsWindowVisible(window) && className.ToString() == "#32770") {
          dialogs.Add(window);
        }
        return true;
      }, IntPtr.Zero);
      return dialogs.ToArray();
    }
    public static bool SelectFileInDialog(IntPtr dialog, string path) {
      if (dialog == IntPtr.Zero || String.IsNullOrWhiteSpace(path)) return false;
      var fileNameEdit = IntPtr.Zero;
      EnumChildWindows(dialog, (window, parameter) => {
        var className = new StringBuilder(64);
        GetClassName(window, className, className.Capacity);
        if (GetDlgCtrlID(window) == 1148 && className.ToString() == "Edit") fileNameEdit = window;
        return true;
      }, IntPtr.Zero);
      if (fileNameEdit == IntPtr.Zero) return false;
      SendMessage(fileNameEdit, 0x00B1, IntPtr.Zero, new IntPtr(-1));
      foreach (var character in path) {
        SendMessage(fileNameEdit, 0x0102, new IntPtr(character), new IntPtr(1));
      }
      var openButton = GetDlgItem(dialog, 1);
      if (openButton == IntPtr.Zero) return false;
      SendMessage(openButton, 0x00F5, IntPtr.Zero, IntPtr.Zero);
      return true;
    }
    public static IntPtr[] VisibleWindowsForProcess(uint processId) {
      var windows = new List<IntPtr>();
      EnumWindows((window, parameter) => {
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner == processId && IsWindowVisible(window) && GetWindowTextLength(window) > 0) windows.Add(window);
        return true;
      }, IntPtr.Zero);
      return windows.ToArray();
    }
  }
}
'@
  }
  $previousContext = [YaqmcLyricsAcceptance.NativeWindow]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
  if ($previousContext -eq [IntPtr]::Zero) {
    throw 'Failed to enable per-monitor-v2 DPI coordinates for native acceptance.'
  }
}

function Get-NativeClientBounds {
  param([IntPtr]$Window, $RequestedWidth, $RequestedHeight)
  Initialize-NativeWindowApi
  if (-not (Get-Variable -Name YaqmcAcceptanceRequestedSizes -Scope Script -ErrorAction SilentlyContinue)) {
    $script:YaqmcAcceptanceRequestedSizes = @{}
  }
  $windowKey = $Window.ToInt64().ToString()
  $dpi = [YaqmcLyricsAcceptance.NativeWindow]::GetDpiForWindow($Window)
  if ($dpi -eq 0) { $dpi = 96 }
  $dpr = [double]$dpi / 96.0
  if ($null -ne $RequestedWidth -and $null -ne $RequestedHeight) {
    $windowRect = New-Object YaqmcLyricsAcceptance.NativeWindow+RECT
    if (-not [YaqmcLyricsAcceptance.NativeWindow]::GetWindowRect($Window, [ref]$windowRect)) {
      throw 'GetWindowRect failed.'
    }
    $desired = New-Object YaqmcLyricsAcceptance.NativeWindow+RECT
    $desired.Left = 0; $desired.Top = 0
    $desired.Right = [int][Math]::Round([double]$RequestedWidth * $dpr)
    $desired.Bottom = [int][Math]::Round([double]$RequestedHeight * $dpr)
    $style = [YaqmcLyricsAcceptance.NativeWindow]::GetWindowLong($Window, -16)
    $exStyle = [YaqmcLyricsAcceptance.NativeWindow]::GetWindowLong($Window, -20)
    if (-not [YaqmcLyricsAcceptance.NativeWindow]::AdjustWindowRectExForDpi([ref]$desired, $style, $false, $exStyle, $dpi)) {
      throw 'AdjustWindowRectExForDpi failed.'
    }
    $outerWidth = $desired.Right - $desired.Left
    $outerHeight = $desired.Bottom - $desired.Top
    if (-not [YaqmcLyricsAcceptance.NativeWindow]::SetWindowPos(
      $Window, [IntPtr]::Zero, $windowRect.Left, $windowRect.Top, $outerWidth, $outerHeight, 0x0014
    )) { throw 'SetWindowPos failed.' }
    $script:YaqmcAcceptanceRequestedSizes[$windowKey] = [pscustomobject]@{
      Width = [double]$RequestedWidth
      Height = [double]$RequestedHeight
    }
    Start-Sleep -Milliseconds 180
  }
  $client = New-Object YaqmcLyricsAcceptance.NativeWindow+RECT
  if (-not [YaqmcLyricsAcceptance.NativeWindow]::GetClientRect($Window, [ref]$client)) {
    throw 'GetClientRect failed.'
  }
  $origin = New-Object YaqmcLyricsAcceptance.NativeWindow+POINT
  if (-not [YaqmcLyricsAcceptance.NativeWindow]::ClientToScreen($Window, [ref]$origin)) {
    throw 'ClientToScreen failed.'
  }
  $physical = [ordered]@{
    x = $origin.X; y = $origin.Y
    width = $client.Right - $client.Left; height = $client.Bottom - $client.Top
    unit = 'physical-px'
  }
  $logicalWidth = ($client.Right - $client.Left) / $dpr
  $logicalHeight = ($client.Bottom - $client.Top) / $dpr
  $requested = $script:YaqmcAcceptanceRequestedSizes[$windowKey]
  if ($requested -and
      [Math]::Abs(($client.Right - $client.Left) - [Math]::Round($requested.Width * $dpr)) -le 1 -and
      [Math]::Abs(($client.Bottom - $client.Top) - [Math]::Round($requested.Height * $dpr)) -le 1) {
    $logicalWidth = $requested.Width
    $logicalHeight = $requested.Height
  }
  $logical = [ordered]@{
    x = $origin.X / $dpr; y = $origin.Y / $dpr
    width = $logicalWidth
    height = $logicalHeight
    unit = 'logical-px'
  }
  $monitor = [YaqmcLyricsAcceptance.NativeWindow]::MonitorFromWindow($Window, 2)
  $info = New-Object YaqmcLyricsAcceptance.NativeWindow+MONITORINFOEX
  $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $monitorId = 'unknown-monitor'
  if ([YaqmcLyricsAcceptance.NativeWindow]::GetMonitorInfo($monitor, [ref]$info)) { $monitorId = $info.szDevice }
  return [pscustomobject]@{
    LogicalBounds = $logical; PhysicalBounds = $physical
    DevicePixelRatio = $dpr; MonitorId = $monitorId
  }
}

function New-ProductionHwndAdapter {
  return @{
    ResolveExactlyOne = {
      param($Handle)
      Initialize-NativeWindowApi
      for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        $matches = @([YaqmcLyricsAcceptance.NativeWindow]::VisibleWindowsForProcess([uint32]$Handle.Id))
        if ($matches.Count -eq 1) { return [IntPtr]$matches[0] }
        if ($matches.Count -gt 1) { throw 'Multiple visible native HWNDs matched the visual process.' }
        Start-Sleep -Milliseconds 100
      }
      throw 'No visible native HWND was resolved for the visual process.'
    }
    GetClientBounds = {
      param($Window, $RequestedWidth, $RequestedHeight)
      return Get-NativeClientBounds $Window $RequestedWidth $RequestedHeight
    }
  }
}

function New-ProductionCaptureAdapter {
  return @{
    SaveClientPng = {
      param($Window, [string]$Path, $PhysicalBounds)
      Add-Type -AssemblyName System.Drawing
      Initialize-NativeWindowApi
      $topmost = [IntPtr]::new(-1)
      $notTopmost = [IntPtr]::new(-2)
      $raiseFlags = 0x0013
      if (-not [YaqmcLyricsAcceptance.NativeWindow]::SetWindowPos(
        [IntPtr]$Window, $topmost, 0, 0, 0, 0, $raiseFlags
      )) { throw 'Failed to raise the visual window for a native screen crop.' }
      try {
        if (-not [YaqmcLyricsAcceptance.NativeWindow]::ForceForegroundWindow([IntPtr]$Window)) {
          throw 'Failed to make the visual window foreground before a native screen crop.'
        }
        Start-Sleep -Milliseconds 80
        $bitmap = New-Object Drawing.Bitmap([int]$PhysicalBounds.width, [int]$PhysicalBounds.height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.CopyFromScreen(
            [int]$PhysicalBounds.x, [int]$PhysicalBounds.y, 0, 0,
            $bitmap.Size, [Drawing.CopyPixelOperation]::SourceCopy
          )
          $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
        } finally {
          $graphics.Dispose()
          $bitmap.Dispose()
        }
      } finally {
        if (-not [YaqmcLyricsAcceptance.NativeWindow]::SetWindowPos(
          [IntPtr]$Window, $notTopmost, 0, 0, 0, 0, $raiseFlags
        )) { throw 'Failed to restore the visual window after a native screen crop.' }
      }
      return [pscustomobject]@{ PhysicalBounds = $PhysicalBounds }
    }
  }
}

function Invoke-Cdp {
  param($Adapter, $Connection, [string]$Method, $Params)
  return & $Adapter.Send $Connection $Method $Params
}

function Invoke-CdpEvaluate {
  param($Adapter, $Connection, [string]$Expression)
  return Invoke-Cdp $Adapter $Connection 'Runtime.evaluate' ([ordered]@{
    expression = $Expression; awaitPromise = $true; returnByValue = $true
  })
}

function Invoke-CdpPointer {
  param($Adapter, $Connection, $Rect)
  if ([int]$Rect.count -ne 1) { throw 'Expected exactly one visible acceptance control.' }
  if (-not ($Rect.PSObject.Properties.Name -contains 'accessibleName') -or
      [string]::IsNullOrWhiteSpace([string]$Rect.accessibleName)) {
    throw 'The visible acceptance control has no accessible name.'
  }
  $x = [double]$Rect.x + ([double]$Rect.width / 2)
  $y = [double]$Rect.y + ([double]$Rect.height / 2)
  foreach ($type in @('mousePressed', 'mouseReleased')) {
    Invoke-Cdp $Adapter $Connection 'Input.dispatchMouseEvent' ([ordered]@{
      type = $type; x = $x; y = $y; button = 'left'; clickCount = 1
    }) | Out-Null
  }
}

function Invoke-CdpKey {
  param($Adapter, $Connection, [string]$Key)
  $codes = @{
    Escape = @{ code = 'Escape'; value = 27 }
    F11 = @{ code = 'F11'; value = 122 }
  }
  $keyCode = $codes[$Key]
  foreach ($type in @('keyDown', 'keyUp')) {
    Invoke-Cdp $Adapter $Connection 'Input.dispatchKeyEvent' ([ordered]@{
      type = $type; key = $Key; code = $keyCode.code; windowsVirtualKeyCode = $keyCode.value
    }) | Out-Null
  }
}

function Get-ControlRect {
  param($Adapter, $Connection, [string]$Control)
  $selectors = @{
    'home-play' = '.featured-release__actions .button--primary'
    'playerbar-lyrics' = '.player-bar__tools > button:first-child'
    'focus-toggle' = '.lyrics-stage__presentation-controls > button:first-child'
    'header-fullscreen' = '.lyrics-stage__presentation-controls > button:nth-child(2)'
    'lyrics-close' = '.lyrics-stage__header > button:last-child'
    'playerbar-fullscreen' = '.player-bar__tools > button:last-child'
  }
  $selectorJson = $selectors[$Control] | ConvertTo-Json -Compress
  $expression = @"
/*YAQMC:$Control*/ (() => {
  const elements = [...document.querySelectorAll($selectorJson)].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
  const element = elements[0];
  if (!element) return { count: 0 };
  const rect = element.getBoundingClientRect();
  return {
    count: elements.length,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    accessibleName: element.getAttribute('aria-label') || (element.textContent || '').trim()
  };
})()
"@
  return Invoke-CdpEvaluate $Adapter $Connection $expression
}

function Get-SemanticState {
  param($Adapter, $Connection)
  return Invoke-CdpEvaluate $Adapter $Connection @'
/*YAQMC:semantic-state*/ (() => {
  const stage = document.querySelector('.lyrics-stage');
  const play = document.querySelector('.player-controls__play');
  return {
    lyricsOpen: Boolean(stage),
    focus: Boolean(stage && stage.hasAttribute('data-focus')),
    nativeFullscreen: Boolean(stage && stage.hasAttribute('data-fullscreen')),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    songId: stage ? (stage.dataset.songId || null) : null,
    playerState: (() => {
      const label = play ? (play.getAttribute('aria-label') || '') : '';
      if (/pause/i.test(label) || label.includes('\u6682\u505c')) return 'playing';
      if (/play/i.test(label) || label.includes('\u64ad\u653e')) return 'paused';
      return 'unknown';
    })(),
    theme: document.documentElement.dataset.theme || '',
    locale: document.documentElement.lang || '',
    backgroundMode: stage ? (stage.dataset.backgroundMode || '') : (document.documentElement.dataset.background || ''),
    backgroundImagePresent: Boolean(stage && stage.querySelector('.lyrics-stage__backdrop'))
  };
})()
'@
}

function Wait-SemanticState {
  param($Adapter, $Connection, [scriptblock]$Predicate, [string]$Failure)
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    $state = Get-SemanticState $Adapter $Connection
    if (& $Predicate $state) { return $state }
    Start-Sleep -Milliseconds 50
  }
  throw $Failure
}

function Invoke-LyricsEntry {
  param($Adapter, $Connection, [string]$EntryPath)
  if ($EntryPath -eq 'playerbar-fullscreen') {
    Invoke-CdpPointer $Adapter $Connection (Get-ControlRect $Adapter $Connection 'playerbar-fullscreen')
    return
  }
  Invoke-CdpPointer $Adapter $Connection (Get-ControlRect $Adapter $Connection 'playerbar-lyrics')
  if ($EntryPath -eq 'playerbar-lyrics') { return }
  if ($EntryPath -eq 'focus-toggle') {
    Invoke-CdpPointer $Adapter $Connection (Get-ControlRect $Adapter $Connection 'focus-toggle')
  } elseif ($EntryPath -eq 'header-fullscreen') {
    Invoke-CdpPointer $Adapter $Connection (Get-ControlRect $Adapter $Connection 'header-fullscreen')
  } elseif ($EntryPath -eq 'f11') {
    Invoke-CdpKey $Adapter $Connection 'F11'
  }
}

function Invoke-LyricsExit {
  param($Adapter, $Connection, [string]$ExitPath)
  if ($ExitPath -eq 'lyrics-close') {
    Invoke-CdpPointer $Adapter $Connection (Get-ControlRect $Adapter $Connection 'lyrics-close')
  } elseif ($ExitPath -eq 'focus-toggle') {
    Invoke-CdpPointer $Adapter $Connection (Get-ControlRect $Adapter $Connection 'focus-toggle')
  } elseif ($ExitPath -eq 'header-fullscreen') {
    Invoke-CdpPointer $Adapter $Connection (Get-ControlRect $Adapter $Connection 'header-fullscreen')
  } elseif ($ExitPath -eq 'f11') {
    Invoke-CdpKey $Adapter $Connection 'F11'
  } else {
    Invoke-CdpKey $Adapter $Connection 'Escape'
  }
}

function Get-MotionMetrics {
  param($Adapter, $Connection)
  return Invoke-CdpEvaluate $Adapter $Connection @'
/*YAQMC:motion-metrics*/ (() => {
  const parse = (value) => value.split(',').reduce((maximum, part) => {
    const trimmed = part.trim();
    const parsed = parseFloat(trimmed) * (trimmed.endsWith('ms') ? 1 : 1000);
    return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
  }, 0);
  const stage = document.querySelector('.lyrics-stage');
  const elements = stage ? [stage, ...stage.querySelectorAll('*')] : [];
  return {
    maxTransitionDurationMs: elements.reduce((maximum, element) => Math.max(maximum, parse(getComputedStyle(element).transitionDuration)), 0),
    maxAnimationDurationMs: elements.reduce((maximum, element) => Math.max(maximum, parse(getComputedStyle(element).animationDuration)), 0),
    activeWordRafProgressWrites: window.__yaqmcLyricsAcceptance ? window.__yaqmcLyricsAcceptance.activeWordRafProgressWrites : -1
  };
})()
'@
}

function New-StateRow {
  param(
    [int]$Seq, [string]$CaseId, [string]$Action, [string]$Source,
    $Bounds, $Semantic, [string]$CaptureMethod, $Assertions
  )
  return [ordered]@{
    seq = $Seq
    timestampUtc = [DateTime]::UtcNow.ToString('o')
    caseId = $CaseId
    action = $Action
    source = $Source
    logicalBounds = ConvertTo-LogicalBounds $Bounds.LogicalBounds
    physicalBounds = ConvertTo-PhysicalBounds $Bounds.PhysicalBounds
    devicePixelRatio = [double]$Bounds.DevicePixelRatio
    nativeFullscreen = [bool]$Semantic.nativeFullscreen
    lyricsOpen = [bool]$Semantic.lyricsOpen
    focus = [bool]$Semantic.focus
    reducedMotion = [bool]$Semantic.reducedMotion
    songId = 'quiet-light'
    playerState = [string]$Semantic.playerState
    captureMethod = $CaptureMethod
    assertions = $Assertions
  }
}

function New-InteractionStateRow {
  param([int]$Seq, $Action)
  $viewport = $Action.viewport
  $semantic = $Action.semantic
  $dpr = [double]$viewport.devicePixelRatio
  $logical = [ordered]@{
    x = 0.0
    y = 0.0
    width = [double]$viewport.width
    height = [double]$viewport.height
    unit = 'logical-px'
  }
  $physical = [ordered]@{
    x = 0.0
    y = 0.0
    width = [double][Math]::Round([double]$viewport.width * $dpr)
    height = [double][Math]::Round([double]$viewport.height * $dpr)
    unit = 'physical-px'
  }
  return [ordered]@{
    seq = $Seq
    timestampUtc = [string]$Action.timestampUtc
    caseId = 'S01-interactions'
    action = [string]$Action.action
    source = 'cdp-ui-input-and-viewport'
    logicalBounds = $logical
    physicalBounds = $physical
    devicePixelRatio = $dpr
    nativeFullscreen = [bool]$semantic.nativeFullscreen
    lyricsOpen = [bool]$semantic.lyricsOpen
    focus = [bool]$semantic.focus
    reducedMotion = [bool]$semantic.reducedMotion
    songId = $semantic.songId
    playerState = [string]$semantic.playerState
    captureMethod = 'semantic-cdp'
    assertions = $Action.assertions
  }
}

function Get-WindowsCaseMatrix {
  return @(
    [ordered]@{ id='W01'; width=1280; height=800; presentation='normal'; theme='light'; locale='en-US'; backgroundMode='default'; entryPath='playerbar-lyrics'; exitPath='lyrics-close'; reducedMotion=$false },
    [ordered]@{ id='W02'; width=1280; height=800; presentation='focus'; theme='dark'; locale='zh-CN'; backgroundMode='artwork'; entryPath='focus-toggle'; exitPath='focus-toggle'; reducedMotion=$false },
    [ordered]@{ id='W03'; width=1280; height=800; presentation='native-fullscreen'; theme='dark'; locale='en-US'; backgroundMode='image'; entryPath='header-fullscreen'; exitPath='header-fullscreen'; reducedMotion=$false },
    [ordered]@{ id='W04'; width=1000; height=700; presentation='normal'; theme='light'; locale='zh-CN'; backgroundMode='color'; entryPath='playerbar-lyrics'; exitPath='escape'; reducedMotion=$true },
    [ordered]@{ id='W05'; width=1000; height=700; presentation='focus'; theme='dark'; locale='en-US'; backgroundMode='image'; entryPath='focus-toggle'; exitPath='escape'; reducedMotion=$false },
    [ordered]@{ id='W06'; width=1000; height=700; presentation='native-fullscreen'; theme='dark'; locale='zh-CN'; backgroundMode='artwork'; entryPath='playerbar-fullscreen'; exitPath='escape'; reducedMotion=$true },
    [ordered]@{ id='W07'; width=1000; height=1000; presentation='normal'; theme='dark'; locale='en-US'; backgroundMode='artwork'; entryPath='playerbar-lyrics'; exitPath='lyrics-close'; reducedMotion=$false },
    [ordered]@{ id='W08'; width=1000; height=1000; presentation='focus'; theme='light'; locale='zh-CN'; backgroundMode='default'; entryPath='focus-toggle'; exitPath='focus-toggle'; reducedMotion=$true },
    [ordered]@{ id='W09'; width=1000; height=1000; presentation='native-fullscreen'; theme='light'; locale='en-US'; backgroundMode='color'; entryPath='f11'; exitPath='f11'; reducedMotion=$false },
    [ordered]@{ id='S01'; width=1000; height=680; presentation='normal'; theme='dark'; locale='en-US'; backgroundMode='default'; entryPath='playerbar-lyrics'; exitPath='escape'; reducedMotion=$false }
  )
}

function Invoke-WindowsLyricsAcceptance {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$BuildKind,
    [hashtable]$Process,
    [hashtable]$Cdp,
    [hashtable]$Hwnd,
    [hashtable]$Capture,
    [switch]$TestMode
  )
  $binaryPath = [IO.Path]::GetFullPath($Binary)
  $outputPath = [IO.Path]::GetFullPath($Output)
  if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw 'Visual binary does not exist.' }
  if ($BuildKind -ne 'tauri-no-bundle') { throw 'Task 9 accepts only tauri-no-bundle visual evidence.' }
  if (Test-Path -LiteralPath $outputPath) {
    if (@(Get-ChildItem -LiteralPath $outputPath -Force).Count -ne 0) { throw 'Evidence output must be absent or empty.' }
  } else {
    [IO.Directory]::CreateDirectory($outputPath) | Out-Null
  }
  $screenshotsPath = Join-Path $outputPath 'screenshots'
  [IO.Directory]::CreateDirectory($screenshotsPath) | Out-Null

  $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  if (-not $TestMode) {
    $dirty = & git -C $repoRoot status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) { throw 'git status failed.' }
    if ($dirty) { throw 'Tracked worktree must be clean before visual capture.' }
  }
  $gitCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse HEAD failed.' }
  $gitTree = (& git -C $repoRoot rev-parse 'HEAD^{tree}').Trim()
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse HEAD^{tree} failed.' }
  $appVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version

  if (-not $Process) { $Process = New-ProductionProcessAdapter }
  if (-not $Cdp) { $Cdp = New-ProductionCdpAdapter }
  if (-not $Hwnd) { $Hwnd = New-ProductionHwndAdapter }
  if (-not $Capture) { $Capture = New-ProductionCaptureAdapter }
  foreach ($required in @('Start','Stop')) { if (-not $Process.ContainsKey($required)) { throw "Process adapter lacks $required." } }
  foreach ($required in @('Connect','Send','Disconnect')) { if (-not $Cdp.ContainsKey($required)) { throw "Cdp adapter lacks $required." } }
  foreach ($required in @('ResolveExactlyOne','GetClientBounds')) { if (-not $Hwnd.ContainsKey($required)) { throw "Hwnd adapter lacks $required." } }
  if (-not $Capture.ContainsKey('SaveClientPng')) { throw 'Capture adapter lacks SaveClientPng.' }

  $hadWebViewArguments = Test-Path Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  $previousWebViewArguments = if ($hadWebViewArguments) { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS } else { $null }
  $port = Get-FreeLoopbackPort
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
  $processHandle = $null
  $connection = $null
  $commands = New-Object 'Collections.Generic.List[string]'
  $stateRows = New-Object 'Collections.Generic.List[object]'
  $caseEvidence = New-Object 'Collections.Generic.List[object]'
  $manifestWritten = $false
  try {
    $commands.Add("git rev-parse HEAD => $gitCommit") | Out-Null
    $commands.Add("git rev-parse HEAD^{tree} => $gitTree") | Out-Null
    $commands.Add("launch $binaryPath with loopback CDP port $port") | Out-Null
    $processHandle = & $Process.Start $binaryPath
    $connection = & $Cdp.Connect $port
    Invoke-Cdp $Cdp $connection 'Page.enable' @{} | Out-Null
    Invoke-Cdp $Cdp $connection 'Runtime.enable' @{} | Out-Null
    $preload = @'
(() => {
  if (window.__yaqmcLyricsAcceptance) return;
  const state = window.__yaqmcLyricsAcceptance = { inAnimationFrame: false, activeWordRafProgressWrites: 0 };
  const originalRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => originalRaf((timestamp) => {
    state.inAnimationFrame = true;
    try { callback(timestamp); } finally { state.inAnimationFrame = false; }
  });
  const originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) {
    if (name === '--word-progress' && state.inAnimationFrame) state.activeWordRafProgressWrites += 1;
    return originalSetProperty.call(this, name, value, priority);
  };
})();
'@
    Invoke-Cdp $Cdp $connection 'Page.addScriptToEvaluateOnNewDocument' @{ source = $preload } | Out-Null
    $origin = [string](Invoke-CdpEvaluate $Cdp $connection '/*YAQMC:origin*/ location.origin')
    $originUri = [Uri]$origin
    $tauriOrigin = $originUri.Scheme -eq 'tauri' -or $originUri.Host.EndsWith('.localhost')
    if (-not $tauriOrigin) { throw 'CDP target origin is not a Tauri application origin.' }
    $navigationUrl = $origin.TrimEnd('/') + '/?provider=fake'
    $commands.Add("Page.navigate $navigationUrl") | Out-Null
    Invoke-Cdp $Cdp $connection 'Page.navigate' @{ url = $navigationUrl } | Out-Null
    Invoke-Cdp $Cdp $connection 'YAQMC.waitForLoadEvent' @{} | Out-Null
    Invoke-Cdp $Cdp $connection 'YAQMC.ensureTarget' @{} | Out-Null
    Invoke-CdpEvaluate $Cdp $connection $preload | Out-Null
    $identity = $null
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
      $identity = Invoke-CdpEvaluate $Cdp $connection @'
/*YAQMC:identity*/ ({
  readyState: document.readyState,
  search: location.search,
  provider: document.querySelector('.app-shell')?.dataset.providerId || null
})
'@
      if ($identity.readyState -eq 'complete') { break }
      Start-Sleep -Milliseconds 50
    }
    if ($identity.search -ne '?provider=fake') { throw 'The CDP target query is not exactly ?provider=fake.' }
    if ($identity.provider -ne 'fake') { throw 'The application provider marker is not fake.' }

    $windowHandle = & $Hwnd.ResolveExactlyOne $processHandle
    if ($connection -is [Collections.IDictionary]) {
      $connection['ProcessId'] = [uint32]$processHandle.Id
    }
    Invoke-CdpPointer $Cdp $connection (Get-ControlRect $Cdp $connection 'home-play')
    Invoke-CdpPointer $Cdp $connection (Get-ControlRect $Cdp $connection 'playerbar-lyrics')
    $initialState = Wait-SemanticState $Cdp $connection {
      param($state) $state.lyricsOpen -and $state.songId -eq 'quiet-light' -and $state.playerState -eq 'playing'
    } 'Home Play -> PlayerBar Lyrics did not produce quiet-light playback.'
    if ($initialState.songId -ne 'quiet-light') { throw 'The fixture song identity is not quiet-light.' }
    Invoke-CdpKey $Cdp $connection 'Escape'

    $sequence = 1
    $monitorId = $null
    $backgroundImagePath = Join-Path $repoRoot 'public\yaqmc-logo.png'
    foreach ($case in Get-WindowsCaseMatrix) {
      $commands.Add("case $($case.id): $($case.entryPath) -> $($case.exitPath)") | Out-Null
      $motionValue = if ($case.reducedMotion) { 'reduce' } else { 'no-preference' }
      Invoke-Cdp $Cdp $connection 'Emulation.setEmulatedMedia' @{
        media = ''
        features = @(@{ name = 'prefers-reduced-motion'; value = $motionValue })
      } | Out-Null
      $configuration = Invoke-Cdp $Cdp $connection 'YAQMC.configureCase' ([ordered]@{
        theme = $case.theme; locale = $case.locale; backgroundMode = $case.backgroundMode
        backgroundImagePath = $backgroundImagePath
      })
      if (-not $configuration.configured -or $configuration.theme -ne $case.theme -or
          $configuration.locale -ne $case.locale -or $configuration.backgroundMode -ne $case.backgroundMode) {
        throw "Case $($case.id) appearance configuration did not converge."
      }
      $sourceBounds = & $Hwnd.GetClientBounds $windowHandle $case.width $case.height
      if (-not $monitorId) { $monitorId = [string]$sourceBounds.MonitorId }

      $sourceSemantic = Wait-SemanticState $Cdp $connection {
        param($state)
        -not $state.focus -and -not $state.nativeFullscreen -and
          $state.playerState -eq 'playing' -and $state.theme -eq $case.theme -and
          $state.locale -eq $case.locale -and $state.backgroundMode -eq $case.backgroundMode
      } "Case $($case.id) source state is stale or mismatched."
      $stateStart = $sequence
      $stateRows.Add((New-StateRow $sequence $case.id 'source' 'native-hwnd-client' $sourceBounds $sourceSemantic 'native-hwnd-client' ([ordered]@{
        provider = 'fake'; search = '?provider=fake'; entryPath = $case.entryPath
      }))) | Out-Null
      $sequence += 1

      Invoke-LyricsEntry $Cdp $connection $case.entryPath
      $expectedFocus = $case.presentation -eq 'focus'
      $expectedFullscreen = $case.presentation -eq 'native-fullscreen'
      $captureState = Wait-SemanticState $Cdp $connection {
        param($state)
        $state.lyricsOpen -and $state.songId -eq 'quiet-light' -and
          [bool]$state.focus -eq $expectedFocus -and
          [bool]$state.nativeFullscreen -eq $expectedFullscreen -and
          [bool]$state.reducedMotion -eq [bool]$case.reducedMotion -and
          $state.theme -eq $case.theme -and $state.locale -eq $case.locale -and
          $state.backgroundMode -eq $case.backgroundMode
      } "Case $($case.id) semantic state is stale or mismatched."
      if (($case.backgroundMode -eq 'image' -or $case.backgroundMode -eq 'artwork') -and
          -not $captureState.backgroundImagePresent) {
        throw "Case $($case.id) did not render its required safe background image."
      }
      if ($case.reducedMotion) {
        Invoke-CdpEvaluate $Cdp $connection 'window.__yaqmcLyricsAcceptance.activeWordRafProgressWrites = 0' | Out-Null
        Start-Sleep -Milliseconds 120
      }
      $motion = Get-MotionMetrics $Cdp $connection
      if ($case.reducedMotion -and
          ($motion.maxTransitionDurationMs -ne 0 -or $motion.maxAnimationDurationMs -ne 0 -or
           $motion.activeWordRafProgressWrites -ne 0)) {
        throw "Case $($case.id) violates reduced-motion invariants."
      }
      $captureBounds = & $Hwnd.GetClientBounds $windowHandle $null $null
      $screenshotRelative = "screenshots/$($case.id).png"
      $screenshotPath = Join-Path $outputPath ($screenshotRelative -replace '/', '\')
      $captureResult = & $Capture.SaveClientPng $windowHandle $screenshotPath $captureBounds.PhysicalBounds
      $postCaptureBounds = & $Hwnd.GetClientBounds $windowHandle $null $null
      if (-not (Test-BoundsEqual $captureResult.PhysicalBounds $captureBounds.PhysicalBounds) -or
          -not (Test-BoundsEqual $postCaptureBounds.PhysicalBounds $captureBounds.PhysicalBounds)) {
        throw "Case $($case.id) native crop bounds changed or mismatched."
      }
      $stateRows.Add((New-StateRow $sequence $case.id 'capture' 'native-hwnd-client' $captureBounds $captureState 'native-hwnd-client' ([ordered]@{
        activeWordRafProgressWrites = if ($case.reducedMotion) { [double]$motion.activeWordRafProgressWrites } else { $null }
        clientCropMatchesBounds = $true
        exitPath = $case.exitPath
        fixtureSongId = 'quiet-light'
        maxAnimationDurationMs = if ($case.reducedMotion) { [double]$motion.maxAnimationDurationMs } else { $null }
        maxTransitionDurationMs = if ($case.reducedMotion) { [double]$motion.maxTransitionDurationMs } else { $null }
        provider = 'fake'
      }))) | Out-Null
      $sequence += 1

      Invoke-LyricsExit $Cdp $connection $case.exitPath
      $restoredSemantic = Wait-SemanticState $Cdp $connection {
        param($state) -not $state.focus -and -not $state.nativeFullscreen
      } "Case $($case.id) exit did not restore normal presentation."
      $restoredBounds = & $Hwnd.GetClientBounds $windowHandle $null $null
      if (-not (Test-BoundsEqual $restoredBounds.LogicalBounds $sourceBounds.LogicalBounds) -or
          -not (Test-BoundsEqual $restoredBounds.PhysicalBounds $sourceBounds.PhysicalBounds)) {
        throw "Case $($case.id) did not restore exact source geometry."
      }
      $stateRows.Add((New-StateRow $sequence $case.id 'restored' 'native-hwnd-client' $restoredBounds $restoredSemantic 'native-hwnd-client' ([ordered]@{
        exactRestoration = $true; exitPath = $case.exitPath; fixtureSongId = 'quiet-light'; provider = 'fake'
      }))) | Out-Null
      $stateEnd = $sequence
      $sequence += 1
      $caseEvidence.Add([ordered]@{
        id = $case.id; theme = $case.theme; locale = $case.locale; backgroundMode = $case.backgroundMode
        presentation = $case.presentation; entryPath = $case.entryPath; exitPath = $case.exitPath
        reducedMotion = [bool]$case.reducedMotion; devicePixelRatio = [double]$sourceBounds.DevicePixelRatio
        sourceLogicalBounds = ConvertTo-LogicalBounds $sourceBounds.LogicalBounds
        sourcePhysicalBounds = ConvertTo-PhysicalBounds $sourceBounds.PhysicalBounds
        captureLogicalBounds = ConvertTo-LogicalBounds $captureBounds.LogicalBounds
        capturePhysicalBounds = ConvertTo-PhysicalBounds $captureBounds.PhysicalBounds
        restoredLogicalBounds = ConvertTo-LogicalBounds $restoredBounds.LogicalBounds
        restoredPhysicalBounds = ConvertTo-PhysicalBounds $restoredBounds.PhysicalBounds
        screenshot = $screenshotRelative; screenshotSha256 = Get-LowerSha256 $screenshotPath
        stateSeqStart = $stateStart; stateSeqEnd = $stateEnd
      }) | Out-Null
      for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
        $cleanupState = Get-SemanticState $Cdp $connection
        if (-not $cleanupState.lyricsOpen) { break }
        Invoke-CdpKey $Cdp $connection 'Escape'
      }
    }

    $interaction = Invoke-Cdp $Cdp $connection 'YAQMC.runInteractionSequence' @{}
    $interactionActions = @($interaction.actions)
    $requiredInteractionActions = @(
      'manual-scroll-unfollow',
      'follow-restored',
      'click-seek',
      'pause',
      'resume',
      'focus-playerbar-sizing',
      'transport-hidden',
      'transport-revealed',
      'transport-focus-pinned',
      'fullscreen-track-change',
      'fullscreen-track-restored',
      'escape-fullscreen',
      'escape-focus',
      'escape-close',
      'secondary-lyrics'
    )
    if ($interactionActions.Count -ne $requiredInteractionActions.Count) {
      throw 'The S01 interaction sequence returned an incomplete action ledger.'
    }
    $interactionStateSeqStart = $sequence
    for ($index = 0; $index -lt $requiredInteractionActions.Count; $index += 1) {
      $action = $interactionActions[$index]
      if ([string]$action.action -ne $requiredInteractionActions[$index]) {
        throw "The S01 interaction sequence is out of order at $($requiredInteractionActions[$index])."
      }
      $stateRows.Add((New-InteractionStateRow $sequence $action)) | Out-Null
      $commands.Add("interaction $($action.action): passed") | Out-Null
      $sequence += 1
    }
    $interactionStateSeqEnd = $sequence - 1

    Invoke-CdpPointer $Cdp $connection (Get-ControlRect $Cdp $connection 'playerbar-lyrics')
    $externalSource = & $Hwnd.GetClientBounds $windowHandle $null $null
    Invoke-CdpPointer $Cdp $connection (Get-ControlRect $Cdp $connection 'header-fullscreen')
    $label = Invoke-CdpEvaluate $Cdp $connection "window.__TAURI_INTERNALS__.metadata.currentWindow.label"
    $nativeBefore = Invoke-CdpEvaluate $Cdp $connection "window.__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen',{label:'main'})"
    Invoke-CdpEvaluate $Cdp $connection "window.__TAURI_INTERNALS__.invoke('plugin:window|set_fullscreen',{label:'main',value:false})" | Out-Null
    $nativeAfter = Invoke-CdpEvaluate $Cdp $connection "window.__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen',{label:'main'})"
    if ($label -ne 'main' -or $nativeBefore -ne $true -or $nativeAfter -ne $false) {
      throw 'External native fullscreen API probe failed.'
    }
    $externalSemantic = Wait-SemanticState $Cdp $connection { param($state) -not $state.nativeFullscreen } 'External fullscreen reconciliation failed.'
    $externalRestored = & $Hwnd.GetClientBounds $windowHandle $null $null
    if (-not (Test-BoundsEqual $externalRestored.LogicalBounds $externalSource.LogicalBounds) -or
        -not (Test-BoundsEqual $externalRestored.PhysicalBounds $externalSource.PhysicalBounds)) {
      throw 'External fullscreen API probe did not restore geometry.'
    }
    $stateRows.Add((New-StateRow $sequence 'external-native-api' 'external-native-api' 'cdp-native-api' $externalRestored $externalSemantic 'semantic-cdp' ([ordered]@{
      exactRestoration = $true
      nativeFullscreenAfter = $false
      nativeFullscreenBefore = $true
      reconciledFullscreen = $false
      setFullscreenFulfilled = $true
      windowLabel = 'main'
    }))) | Out-Null
    $sequence += 1
    $commands.Add('external-native-api: label main, true -> fulfilled set(false) -> false, reconciled') | Out-Null

    $visualBinarySha = Get-LowerSha256 $binaryPath
    $hasBrowserVersion =
      ($connection -is [Collections.IDictionary] -and $connection.Contains('BrowserVersion')) -or
      ($connection.PSObject.Properties.Name -contains 'BrowserVersion')
    $webViewVersion = if ($hasBrowserVersion) { [string]$connection.BrowserVersion } else { 'test-webview2' }
    $osVersion = if ($TestMode) { 'Windows 11 test' } else { [Environment]::OSVersion.VersionString }
    $manifest = [ordered]@{
      schemaVersion = 1
      capturedAtUtc = [DateTime]::UtcNow.ToString('o')
      gitCommit = $gitCommit
      gitTree = $gitTree
      platform = 'windows'
      osVersion = $osVersion
      appVersion = [string]$appVersion
      webview2Version = $webViewVersion
      monitorId = $monitorId
      visualBinaryPath = $binaryPath
      visualBinarySha256 = $visualBinarySha
      visualBuildKind = $BuildKind
      provider = 'fake'
      fixtureSongId = 'quiet-light'
      interactionSequence = [ordered]@{
        id = 'S01-interactions'
        actions = $requiredInteractionActions
        stateSeqStart = $interactionStateSeqStart
        stateSeqEnd = $interactionStateSeqEnd
      }
      releaseArtifact = $null
      cases = @($caseEvidence | ForEach-Object { $_ })
    }
    $checklist = @(
      '# YAQMC Windows lyrics acceptance',
      '- checkpoint: local-visual-only',
      '- releasePass: false',
      "- gitCommit: $gitCommit",
      "- gitTree: $gitTree",
      '- provider: fake',
      '- fixtureSongId: quiet-light'
    ) + @($caseEvidence | ForEach-Object { "- [x] $($_.id)" }) + @('- [x] S01-interactions', '')
    Write-Utf8NoBom (Join-Path $outputPath 'checklist.md') ($checklist -join "`n")
    Write-Utf8NoBom (Join-Path $outputPath 'commands.log') (($commands -join "`n") + "`n")
    Write-Utf8NoBom (Join-Path $outputPath 'state.jsonl') ((@($stateRows | ForEach-Object { $_ | ConvertTo-Json -Depth 20 -Compress }) -join "`n") + "`n")
    Write-Utf8NoBom (Join-Path $outputPath 'manifest.json') (($manifest | ConvertTo-Json -Depth 30) + "`n")
    $hashNames = @('checklist.md','manifest.json','commands.log','state.jsonl') +
      @($caseEvidence | ForEach-Object { [string]$_.screenshot })
    $hashLines = @($hashNames | ForEach-Object {
      $file = Join-Path $outputPath ($_ -replace '/', '\')
      "$(Get-LowerSha256 $file)  $_"
    }) + @("$visualBinarySha  @visual-binary")
    Write-Utf8NoBom (Join-Path $outputPath 'sha256.txt') (($hashLines -join "`n") + "`n")
    $manifestWritten = $true
    return [pscustomobject]@{ Root = $outputPath; Manifest = $manifest }
  } finally {
    $cleanupFailure = $null
    if ($connection) {
      try { & $Cdp.Disconnect $connection } catch { $cleanupFailure = $_ }
    }
    if ($processHandle) {
      try { & $Process.Stop $processHandle } catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }
    }
    if ($hadWebViewArguments) {
      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebViewArguments
    } else {
      Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    }
    if ($cleanupFailure -and $manifestWritten) {
      Remove-Item -LiteralPath (Join-Path $outputPath 'manifest.json') -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath (Join-Path $outputPath 'sha256.txt') -Force -ErrorAction SilentlyContinue
      throw $cleanupFailure
    }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  if (-not $Binary -or -not $Output -or -not $BuildKind) {
    throw 'Usage: capture-windows-lyrics-acceptance.ps1 -Binary <path> -Output <path> -BuildKind tauri-no-bundle'
  }
  Invoke-WindowsLyricsAcceptance -Binary $Binary -Output $Output -BuildKind $BuildKind | Out-Null
}
