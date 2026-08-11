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
  $socket.ConnectAsync([Uri]$WebSocketUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
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
  $Connection.Socket.SendAsync(
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
  return $result.result.value
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
    $hasImage = Get-CdpRuntimeValue $Connection @'
/*YAQMC:managed-image-ready*/ (() => {
  const buttons = [...document.querySelectorAll('.settings-page button.button--secondary')];
  return buttons.some((button) => /replace/i.test(button.textContent || ''));
})()
'@
    if (-not $hasImage) {
      $imageButton = Get-ProductionRect $Connection 'managed-image-picker' '.settings-page button.button--secondary'
      Send-ProductionPointer $Connection $imageButton
      Add-Type -AssemblyName System.Windows.Forms
      Start-Sleep -Milliseconds 350
      [Windows.Forms.SendKeys]::SendWait([string]$Case.backgroundImagePath)
      [Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Start-Sleep -Milliseconds 500
    }
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
      $result = Send-CdpRaw $Connection $Method $Params
      if ($Method -eq 'Runtime.evaluate') {
        if ($result.PSObject.Properties.Name -contains 'exceptionDetails') {
          throw "Runtime.evaluate failed: $($result.exceptionDetails.text)"
        }
        return $result.result.value
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
  if ('YaqmcLyricsAcceptance.NativeWindow' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
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
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
    public static IntPtr[] VisibleWindowsForProcess(uint processId) {
      var windows = new List<IntPtr>();
      EnumWindows((window, parameter) => {
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner == processId && IsWindowVisible(window)) windows.Add(window);
        return true;
      }, IntPtr.Zero);
      return windows.ToArray();
    }
  }
}
'@
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
      [YaqmcLyricsAcceptance.NativeWindow]::SetForegroundWindow([IntPtr]$Window) | Out-Null
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
    ) + @($caseEvidence | ForEach-Object { "- [x] $($_.id)" }) + @('')
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
