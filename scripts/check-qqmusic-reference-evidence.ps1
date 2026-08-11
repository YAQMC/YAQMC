[CmdletBinding(DefaultParameterSetName = 'SelfTest')]
param(
  [Parameter(ParameterSetName = 'SelfTest')][switch]$SelfTest,
  [Parameter(Mandatory, ParameterSetName = 'Mutation')]
  [ValidateSet(
    'fabricated-operation-tag',
    'empty-evidence-class',
    'response-set-cookie',
    'noisy-result-token',
    'missing-playlist-rename-anchor',
    'missing-recent-history-anchor',
    'disconnected-rename-delegate',
    'missing-rename-preservation-field'
  )]
  [string]$SelfTestMutation,
  [Parameter(Mandatory, ParameterSetName = 'Emit')][switch]$EmitSanitizedJson,
  [Parameter(Mandatory, ParameterSetName = 'Ledger')][string]$VerifyLedger
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

class ReferenceTarget {
  [string]$Repository
  [string]$Commit
  [string]$Path

  ReferenceTarget([string]$repository, [string]$commit, [string]$path) {
    $this.Repository = $repository
    $this.Commit = $commit
    $this.Path = $path
  }
}

class SymbolSelector {
  [string]$Language
  [string]$Path
  [string]$AnchorKind
  [string]$Anchor
  [string]$EvidenceClass
  [string[]]$ExpectedSymbols

  SymbolSelector(
    [string]$language,
    [string]$path,
    [string]$anchorKind,
    [string]$anchor,
    [string]$evidenceClass,
    [string[]]$expectedSymbols
  ) {
    $this.Language = $language
    $this.Path = $path
    $this.AnchorKind = $anchorKind
    $this.Anchor = $anchor
    $this.EvidenceClass = $evidenceClass
    $this.ExpectedSymbols = $expectedSymbols
  }
}

class DeclarationEdge {
  [string]$FromPath
  [string]$FromAnchor
  [string]$EdgeKind
  [string]$ToPath
  [string]$ToAnchor

  DeclarationEdge(
    [string]$fromPath,
    [string]$fromAnchor,
    [string]$edgeKind,
    [string]$toPath,
    [string]$toAnchor
  ) {
    $this.FromPath = $fromPath
    $this.FromAnchor = $fromAnchor
    $this.EdgeKind = $edgeKind
    $this.ToPath = $toPath
    $this.ToAnchor = $toAnchor
  }
}

class OperationEvidenceSpec {
  [string]$Operation
  [SymbolSelector[]]$Selectors
  [string[]]$RequiredResponseKeys
  [DeclarationEdge[]]$RequiredDeclarationEdges
  [string]$SecretHeaderPolicy
  [string]$PaginationPolicy
  [int]$MinimumCorroboratingSources

  OperationEvidenceSpec(
    [string]$operation,
    [SymbolSelector[]]$selectors,
    [string[]]$requiredResponseKeys,
    [DeclarationEdge[]]$requiredDeclarationEdges,
    [string]$secretHeaderPolicy,
    [string]$paginationPolicy,
    [int]$minimumCorroboratingSources
  ) {
    $this.Operation = $operation
    $this.Selectors = $selectors
    $this.RequiredResponseKeys = $requiredResponseKeys
    $this.RequiredDeclarationEdges = $requiredDeclarationEdges
    $this.SecretHeaderPolicy = $secretHeaderPolicy
    $this.PaginationPolicy = $paginationPolicy
    $this.MinimumCorroboratingSources = $minimumCorroboratingSources
  }
}

function New-Selector {
  param([string]$Language, [string]$Path, [string]$AnchorKind, [string]$Anchor)
  return [SymbolSelector]::new(
    $Language,
    $Path,
    $AnchorKind,
    $Anchor,
    'anchored-declaration',
    @($Anchor)
  )
}

function Assert-SelectorMetadata {
  param([SymbolSelector]$Selector)
  if ($Selector.Language -notin @('python','typescript','javascript','java')) {
    throw "Unknown selector language: $($Selector.Language)"
  }
  if ($Selector.AnchorKind -notin @('py:def','ts:export','ts:default-export','ts:method','js:module-exports','js:class','js:method','js:const','java:method')) {
    throw "Unknown selector anchor kind: $($Selector.AnchorKind)"
  }
  if ($Selector.EvidenceClass -ne 'anchored-declaration') {
    throw "Unknown or empty evidence class: $($Selector.EvidenceClass)"
  }
  if ([string]::IsNullOrWhiteSpace($Selector.Path) -or
      [string]::IsNullOrWhiteSpace($Selector.Anchor) -or
      @($Selector.ExpectedSymbols).Count -eq 0) {
    throw 'Selector path, anchor, and expected symbols are required.'
  }
}

function Get-ReferenceTargets {
  $l1124 = '108617ffe80abefec6358717b9f4d3677550db10'
  $wxuyu = '44c3b26c8741521266c63002844564392a1fa38c'
  $rethink = 'a828f1f2d2dc8416bd1a549ee4c14efbb8ba4974'
  $multi = '0fd583b384f5d6477067ff3d29ccedd97fc3a317'
  $qqm = '4a434ccf7468af29731a9792917cb6fc5a126bab'
  return [ReferenceTarget[]]@(
    [ReferenceTarget]::new('L-1124/QQMusicApi', $l1124, 'qqmusic_api/modules/login.py'),
    [ReferenceTarget]::new('L-1124/QQMusicApi', $l1124, 'qqmusic_api/models/login.py'),
    [ReferenceTarget]::new('L-1124/QQMusicApi', $l1124, 'qqmusic_api/core/request.py'),
    [ReferenceTarget]::new('L-1124/QQMusicApi', $l1124, 'qqmusic_api/core/versioning.py'),
    [ReferenceTarget]::new('L-1124/QQMusicApi', $l1124, 'qqmusic_api/modules/user.py'),
    [ReferenceTarget]::new('L-1124/QQMusicApi', $l1124, 'qqmusic_api/modules/songlist.py'),
    [ReferenceTarget]::new('L-1124/QQMusicApi', $l1124, 'qqmusic_api/modules/song.py'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/services/apis/user/getQQLoginQr.ts'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/services/apis/user/checkQQLoginQr.ts'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/services/apis/user/getUserDetail.ts'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/services/apis/user/getUserLikedSongs.ts'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/services/apis/user/getUserPlaylists.ts'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/services/apis/user/getUserCollections.ts'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/services/apis/songLists/songListDetail.ts'),
    [ReferenceTarget]::new('wxuyu/QQMusicApi', $wxuyu, 'src/util/request.ts'),
    [ReferenceTarget]::new(
      'RethinkQAQ/allmusic-qqmusicapi',
      $rethink,
      'src/main/java/qqmusicapi/QQMusicLoginHelper.java'
    ),
    [ReferenceTarget]::new(
      'tlyanyu/multiPlatformMusicApi',
      $multi,
      'platforms/qqmusic/module/playlist_update.js'
    ),
    [ReferenceTarget]::new(
      'tlyanyu/multiPlatformMusicApi',
      $multi,
      'platforms/qqmusic/module/user_playlist_created.js'
    ),
    [ReferenceTarget]::new(
      'tlyanyu/multiPlatformMusicApi',
      $multi,
      'platforms/base/BasePlatform.js'
    ),
    [ReferenceTarget]::new(
      'tlyanyu/multiPlatformMusicApi',
      $multi,
      'platforms/qqmusic/QQMusicPlatform.js'
    ),
    [ReferenceTarget]::new(
      'tlyanyu/multiPlatformMusicApi',
      $multi,
      'platforms/qqmusic/util/request.js'
    ),
    [ReferenceTarget]::new('wangwalk/qqm', $qqm, 'src/api/user.ts'),
    [ReferenceTarget]::new('wangwalk/qqm', $qqm, 'src/api/client.ts')
  )
}

function Get-TargetByPath {
  param([ReferenceTarget[]]$Targets, [string]$Path)
  $matches = @($Targets | Where-Object Path -eq $Path)
  if ($matches.Count -ne 1) { throw "Reference path ownership is not unique: $Path" }
  return $matches[0]
}

function Get-Sha256Bytes {
  param([byte[]]$Bytes)
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
}

function Remove-CodeComments {
  param([string]$Text, [string]$Language)
  $builder = New-Object Text.StringBuilder
  $mode = 'normal'
  $escape = $false
  for ($index = 0; $index -lt $Text.Length; $index += 1) {
    $char = $Text[$index]
    $next = if ($index + 1 -lt $Text.Length) { $Text[$index + 1] } else { [char]0 }
    if ($mode -eq 'line-comment') {
      if ($char -eq "`n") { [void]$builder.Append($char); $mode = 'normal' }
      continue
    }
    if ($mode -eq 'block-comment') {
      if ($char -eq '*' -and $next -eq '/') { $index += 1; $mode = 'normal' }
      elseif ($char -eq "`n") { [void]$builder.Append($char) }
      continue
    }
    if ($mode -ne 'normal') {
      [void]$builder.Append($char)
      if ($escape) { $escape = $false; continue }
      if ($char -eq '\') { $escape = $true; continue }
      if (($mode -eq 'single' -and $char -eq "'") -or
          ($mode -eq 'double' -and $char -eq '"') -or
          ($mode -eq 'template' -and $char -eq '`')) {
        $mode = 'normal'
      }
      continue
    }
    if ($char -eq "'") { [void]$builder.Append($char); $mode = 'single'; continue }
    if ($char -eq '"') { [void]$builder.Append($char); $mode = 'double'; continue }
    if ($char -eq '`' -and $Language -ne 'python') {
      [void]$builder.Append($char); $mode = 'template'; continue
    }
    if ($Language -eq 'python' -and $char -eq '#') { $mode = 'line-comment'; continue }
    if ($Language -ne 'python' -and $char -eq '/' -and $next -eq '/') {
      $index += 1; $mode = 'line-comment'; continue
    }
    if ($Language -ne 'python' -and $char -eq '/' -and $next -eq '*') {
      $index += 1; $mode = 'block-comment'; continue
    }
    [void]$builder.Append($char)
  }
  return $builder.ToString()
}

function Get-BalancedBraceBlock {
  param([string]$Text, [int]$AnchorIndex, [int]$BodySearchIndex = -1)
  if ($BodySearchIndex -lt 0) { $BodySearchIndex = $AnchorIndex }
  $start = $Text.IndexOf('{', $BodySearchIndex)
  if ($start -lt 0) { throw 'Anchored declaration has no body block.' }
  $depth = 0
  $quote = [char]0
  $escape = $false
  for ($index = $start; $index -lt $Text.Length; $index += 1) {
    $char = $Text[$index]
    if ($quote -ne [char]0) {
      if ($escape) { $escape = $false; continue }
      if ($char -eq '\') { $escape = $true; continue }
      if ($char -eq $quote) { $quote = [char]0 }
      continue
    }
    if ($char -eq "'" -or $char -eq '"' -or $char -eq '`') { $quote = $char; continue }
    if ($char -eq '{') { $depth += 1; continue }
    if ($char -eq '}') {
      $depth -= 1
      if ($depth -eq 0) { return $Text.Substring($AnchorIndex, $index - $AnchorIndex + 1) }
    }
  }
  throw 'Anchored declaration body is unbalanced.'
}

function Get-PythonDeclarationBlock {
  param([string]$Text, [string]$Name)
  $lines = @($Text -split "`r?`n")
  $pattern = '^([ \t]*)(?:async\s+)?def\s+' + [regex]::Escape($Name) + '\s*\('
  $start = -1
  $indent = 0
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    $match = [regex]::Match($lines[$index], $pattern)
    if ($match.Success) { $start = $index; $indent = $match.Groups[1].Value.Length; break }
  }
  if ($start -lt 0) { throw "Missing Python declaration: $Name" }
  $end = $lines.Count
  for ($index = $start + 1; $index -lt $lines.Count; $index += 1) {
    $line = $lines[$index]
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $leading = ([regex]::Match($line, '^[ \t]*')).Value.Length
    if ($leading -le $indent -and $line -match '^\s*(?:async\s+)?(?:def|class)\s+') {
      $end = $index
      break
    }
  }
  return ($lines[$start..($end - 1)] -join "`n")
}

function Get-PythonClassBlock {
  param([string]$Text, [string]$Name)
  $lines = @($Text -split "`r?`n")
  $pattern = '^([ \t]*)class\s+' + [regex]::Escape($Name) + '\b'
  $start = -1
  $indent = 0
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    $match = [regex]::Match($lines[$index], $pattern)
    if ($match.Success) { $start = $index; $indent = $match.Groups[1].Value.Length; break }
  }
  if ($start -lt 0) { throw "Missing Python class declaration: $Name" }
  $end = $lines.Count
  for ($index = $start + 1; $index -lt $lines.Count; $index += 1) {
    $line = $lines[$index]
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $leading = ([regex]::Match($line, '^[ \t]*')).Value.Length
    if ($leading -le $indent -and $line -match '^\s*(?:async\s+)?(?:def|class)\s+') {
      $end = $index
      break
    }
  }
  return ($lines[$start..($end - 1)] -join "`n")
}

function Get-CommonResultDecoderBlock {
  param([string]$Operation, [hashtable]$Bodies)
  if ($Operation -eq 'QR status') {
    $block = Get-PythonClassBlock $Bodies['qqmusic_api/models/login.py'] 'QRCodeLoginEvents'
    $derived = @()
    foreach ($member in @('SCAN','CONF','TIMEOUT','REFUSE')) {
      if ($block -notmatch ('(?m)^\s*' + $member + '\s*=\s*\(')) {
        throw "Missing QRCodeLoginEvents decoder member: $member"
      }
      $derived += "QRCodeLoginEvents.$member"
    }
    return $block + "`n" + ($derived -join "`n")
  }
  if ($Operation -in @(
    'post-confirmation exchange','session validation/profile','Favorites read','Favorites write',
    'playlist summaries','playlist detail','playlist create','playlist add','playlist remove',
    'playlist delete','entitlement','playback vkey'
  )) {
    $block = Get-PythonClassBlock $Bodies['qqmusic_api/core/request.py'] 'CgiRequest'
    if ($block -notmatch '(?m)raw_data\.get\(["'']code["''],\s*0\)') {
      throw 'Missing shared CGI result decoder.'
    }
    return $block
  }
  return ''
}

function Get-AnchorBlock {
  param([string]$Text, [SymbolSelector]$Selector)
  $clean = Remove-CodeComments $Text $Selector.Language
  if ($Selector.AnchorKind -eq 'py:def') {
    return Get-PythonDeclarationBlock $clean $Selector.Anchor
  }
  $name = [regex]::Escape($Selector.Anchor)
  $pattern = switch ($Selector.AnchorKind) {
    'ts:export' { '(?m)(?:export\s+)?(?:const|function)\s+' + $name + '\b' }
    'ts:default-export' { '(?m)export\s+default\s+(?:async\s*)?\(' }
    'ts:method' {
      $method = [regex]::Escape(($Selector.Anchor -split '\.')[-1])
      '(?m)(?:public\s+|private\s+|protected\s+)?(?:async\s+)?' + $method + '(?:<[^\r\n{]+>)?\s*\('
    }
    'js:module-exports' { '(?m)module\.exports\s*=\s*(?:async\s*)?\(' }
    'js:class' { '(?m)class\s+' + $name + '\b' }
    'js:method' {
      $method = [regex]::Escape(($Selector.Anchor -split '\.')[-1])
      '(?m)(?:async\s+)?' + $method + '\s*\('
    }
    'js:const' { '(?m)const\s+' + $name + '\s*=' }
    'java:method' { '(?m)(?:public|private|protected)\s+(?:static\s+)?[^\r\n{;]+\s+' + $name + '\s*\(' }
    default { throw "Unknown anchor kind: $($Selector.AnchorKind)" }
  }
  $match = [regex]::Match($clean, $pattern)
  if (-not $match.Success) { throw "Missing $($Selector.AnchorKind) anchor $($Selector.Anchor) in $($Selector.Path)" }
  $bodySearchIndex = $match.Index
  $requiresArrow = $Selector.AnchorKind -in @('ts:default-export','js:module-exports','js:const') -or
    ($Selector.AnchorKind -eq 'ts:export' -and $match.Value -notmatch '\bfunction\b')
  if ($requiresArrow) {
    $arrowIndex = $clean.IndexOf('=>', $match.Index, [StringComparison]::Ordinal)
    if ($arrowIndex -lt 0) { throw "Anchored function has no arrow body: $($Selector.Anchor)" }
    $bodySearchIndex = $arrowIndex + 2
  }
  return Get-BalancedBraceBlock $clean $match.Index $bodySearchIndex
}

function Test-LiteralToken {
  param([string]$Text, [string]$Token)
  $pattern = '(?<![A-Za-z0-9_])' + [regex]::Escape($Token) + '(?![A-Za-z0-9_])'
  return [regex]::IsMatch($Text, $pattern)
}

function Test-ValidResultToken {
  param([string]$Token, [bool]$Quoted = $false)
  $denied = @('case','exc','int','match','raise','resp','str','await','self','null','authorizeres')
  if ($denied -contains $Token.ToLowerInvariant()) { return $false }
  if ($Token -match '^-?(0|[1-9][0-9]{0,7})$') { return $true }
  if ($Token -match '^(QRCodeLoginEvents|PhoneLoginEvents|LoginStatus|AuthStatus)\.[A-Z][A-Z0-9_]*$') {
    return $true
  }
  return $Quoted -and $Token -match '^[A-Za-z0-9_-]{1,32}$'
}

function Get-RequestHeaderNames {
  param([string]$Block)
  $headers = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($match in [regex]::Matches($Block, '(?is)(?<!response\.)headers\s*[:=]\s*\{(?<body>.{0,1600}?)\}')) {
    if ($match.Groups['body'].Value -match '(?i)(?:["'']?Cookie["'']?\s*:|\bcookie\b)') {
      [void]$headers.Add('Cookie')
    }
  }
  if ($Block -match '(?is)setRequestHeader\s*\(\s*["'']Cookie["'']' -or
      $Block -match '(?is)\.header\s*\(\s*(?:header::COOKIE|["'']Cookie["''])' -or
      $Block -match '(?is)(?<!response\.)(?:headers\.Cookie|headers\[["'']Cookie["'']\])\s*=') {
    [void]$headers.Add('Cookie')
  }
  return @($headers | Sort-Object)
}

function Test-DelegatedCookieHeader {
  param([string[]]$Blocks, [hashtable]$Bodies)
  if (-not (@($Blocks | Where-Object { Test-LiteralToken $_ 'cookie' }).Count -gt 0)) { return $false }
  $clean = Remove-CodeComments $Bodies['src/util/request.ts'] 'typescript'
  $match = [regex]::Match($clean, '(?m)function\s+request(?:<[^\r\n{]+>)?\s*\(')
  if (-not $match.Success) { throw 'Missing imported wxuyu request wrapper.' }
  $wrapper = Get-BalancedBraceBlock $clean $match.Index
  return @(Get-RequestHeaderNames $wrapper) -contains 'Cookie'
}

function Get-ResponseHeaderNames {
  param([string]$Block)
  $result = @()
  if ($Block -match '(?is)(?:response|resp|checkSigRes)\.headers\.get\s*\(\s*["'']Set-Cookie["'']') {
    $result += 'Set-Cookie'
  }
  return $result
}

function Test-ModuleMethod {
  param([string[]]$Blocks, [string]$Module, [string]$Method)
  foreach ($block in $Blocks) {
    $modulePattern = [regex]::Escape($Module)
    $methodPattern = [regex]::Escape($Method)
    if ($block -match ('(?is)["'']' + $modulePattern + '["''].{0,1800}["'']' + $methodPattern + '["'']') -or
        $block -match ('(?is)["'']' + $methodPattern + '["''].{0,1800}["'']' + $modulePattern + '["'']')) {
      return $true
    }
  }
  return $false
}

function Test-EndpointRequirement {
  param([string[]]$Blocks, [string]$Requirement)
  if ($Requirement.Contains('||')) {
    foreach ($alternative in ($Requirement -split '\|\|')) {
      if (Test-EndpointRequirement $Blocks $alternative) { return $true }
    }
    return $false
  }
  if ($Requirement.StartsWith('url:', [StringComparison]::Ordinal)) {
    $literal = $Requirement.Substring(4)
    if (@($Blocks | Where-Object { $_.Contains($literal) }).Count -gt 0) { return $true }
    $uri = [Uri]$literal
    $origin = $uri.GetLeftPart([UriPartial]::Authority)
    $hasOrigin = @($Blocks | Where-Object { $_.Contains($origin) }).Count -gt 0
    $hasPath = @($Blocks | Where-Object { $_.Contains($uri.AbsolutePath) }).Count -gt 0
    return $hasOrigin -and $hasPath
  }
  if ($Requirement.StartsWith('mm:', [StringComparison]::Ordinal)) {
    $pair = $Requirement.Substring(3).Split('/')
    if ($pair.Count -ne 2) { throw "Malformed module/method requirement: $Requirement" }
    return Test-ModuleMethod $Blocks $pair[0] $pair[1]
  }
  throw "Unknown endpoint evidence requirement: $Requirement"
}

function Get-RenameEdges {
  param([hashtable]$Bodies)
  $base = Remove-CodeComments $Bodies['platforms/base/BasePlatform.js'] 'javascript'
  $platform = Remove-CodeComments $Bodies['platforms/qqmusic/QQMusicPlatform.js'] 'javascript'
  $update = Remove-CodeComments $Bodies['platforms/qqmusic/module/playlist_update.js'] 'javascript'
  $created = Remove-CodeComments $Bodies['platforms/qqmusic/module/user_playlist_created.js'] 'javascript'
  $request = Remove-CodeComments $Bodies['platforms/qqmusic/util/request.js'] 'javascript'
  $edges = New-Object 'Collections.Generic.List[string]'
  if ($platform -match 'class\s+QQMusicPlatform\s+extends\s+BasePlatform') {
    $edges.Add('QQMusicPlatform --inherits--> BasePlatform')
  }
  if ($base -match "file\.replace\(/\\\.js\$/i,\s*''\)\.replace\(/_/g,\s*'/'\)" -and
      $base -match 'this\.modules\.set\(moduleRoute,\s*moduleFunction\)') {
    $edges.Add('BasePlatform.loadModules --loads-route:playlist/update--> playlist_update.js#module.exports')
  }
  if ($base -match 'this\.modules\.get\(route\)') {
    $edges.Add('BasePlatform.callModule --retrieves-route:playlist/update--> playlist_update.js#module.exports')
  }
  if ($base -match 'this\.createRequestFunction\(\)' -and $platform -match 'createRequestFunction\s*\(') {
    $edges.Add('BasePlatform.callModule --virtual-call-on:QQMusicPlatform--> QQMusicPlatform.createRequestFunction')
  }
  if ($base -match '(?s)moduleFunction\s*\(\s*query,\s*this\.createRequestFunction\(\)\s*\)') {
    $edges.Add('BasePlatform.callModule --injects-return-of:QQMusicPlatform.createRequestFunction-as-parameter:request--> playlist_update.js#module.exports')
  }
  if ($update -match 'require\([''"]\./user_playlist_created[''"]\)' -and
      $update -match '(?s)module\.exports\s*=\s*async\s*\(\s*query,\s*request\s*\)' -and
      $update -match 'getPlaylistCreated\s*\(\s*query,\s*request\s*\)' -and
      $update -match '(?s)request\s*\(\s*["'']music\.musicasset\.PlaylistBaseWrite["'']\s*,\s*["'']EditPlaylist["'']' -and
      $created -match '(?s)module\.exports\s*=\s*async\s*\(\s*query,\s*request\s*\)' -and
      $created -match '(?s)request\s*\(\s*["'']music\.musicasset\.PlaylistBaseRead["'']\s*,\s*["'']GetPlaylistByUin["'']') {
    $edges.Add('playlist_update.js#module.exports --static-require-call-forwarding:query,request--> user_playlist_created.js#module.exports')
  }
  if ($platform -match 'require\([''"]\./util/request[''"]\)' -and
      $platform -match 'request\.createRequest\s*\(' -and
      $request -match 'const\s+createRequest\s*=' -and
      $request -match '(?s)module\.exports\s*=\s*\{[^}]*\bcreateRequest\b') {
    $edges.Add('QQMusicPlatform.createRequestFunction --static-require-delegate--> request.js#createRequest')
  }
  if ($created -notmatch 'response\.body\.v_playlist') { return @() }
  return @($edges)
}

function Convert-DeclarationEdgeToIdentity {
  param([DeclarationEdge]$Edge)
  $source = if ($Edge.FromAnchor -eq 'module.exports') {
    [IO.Path]::GetFileName($Edge.FromPath) + '#' + $Edge.FromAnchor
  } else {
    $Edge.FromAnchor
  }
  $target = if ($Edge.EdgeKind -in @('inherits','virtual-call-on:QQMusicPlatform')) {
    $Edge.ToAnchor
  } else {
    [IO.Path]::GetFileName($Edge.ToPath) + '#' + $Edge.ToAnchor
  }
  return "$source --$($Edge.EdgeKind)--> $target"
}

function Get-DeclarationEdges {
  return [DeclarationEdge[]]@(
    [DeclarationEdge]::new('platforms/qqmusic/QQMusicPlatform.js','QQMusicPlatform','inherits','platforms/base/BasePlatform.js','BasePlatform'),
    [DeclarationEdge]::new('platforms/base/BasePlatform.js','BasePlatform.loadModules','loads-route:playlist/update','platforms/qqmusic/module/playlist_update.js','module.exports'),
    [DeclarationEdge]::new('platforms/base/BasePlatform.js','BasePlatform.callModule','retrieves-route:playlist/update','platforms/qqmusic/module/playlist_update.js','module.exports'),
    [DeclarationEdge]::new('platforms/base/BasePlatform.js','BasePlatform.callModule','virtual-call-on:QQMusicPlatform','platforms/qqmusic/QQMusicPlatform.js','QQMusicPlatform.createRequestFunction'),
    [DeclarationEdge]::new('platforms/base/BasePlatform.js','BasePlatform.callModule','injects-return-of:QQMusicPlatform.createRequestFunction-as-parameter:request','platforms/qqmusic/module/playlist_update.js','module.exports'),
    [DeclarationEdge]::new('platforms/qqmusic/module/playlist_update.js','module.exports','static-require-call-forwarding:query,request','platforms/qqmusic/module/user_playlist_created.js','module.exports'),
    [DeclarationEdge]::new('platforms/qqmusic/QQMusicPlatform.js','QQMusicPlatform.createRequestFunction','static-require-delegate','platforms/qqmusic/util/request.js','createRequest')
  )
}

function Get-OperationDefinitions {
  $login = 'qqmusic_api/modules/login.py'
  $user = 'qqmusic_api/modules/user.py'
  $songlist = 'qqmusic_api/modules/songlist.py'
  $song = 'qqmusic_api/modules/song.py'
  $definitions = @(
    @{ Operation='QR create'; Class='public-read'; Selectors=@((New-Selector python $login 'py:def' '_get_qq_qr'),(New-Selector typescript 'src/services/apis/user/getQQLoginQr.ts' 'ts:export' 'getQQLoginQr')); EndpointGroups=@(@('url:https://ssl.ptlogin2.qq.com/ptqrshow')); Keys=@('appid','daid','pt_3rd_aid','u1'); Headers='none'; Pagination='none'; Results=@('200'); Minimum=2; SecretInputs='none' },
    @{ Operation='QR status'; Class='auth-poll'; Selectors=@((New-Selector python $login 'py:def' '_check_qq_qr'),(New-Selector typescript 'src/services/apis/user/checkQQLoginQr.ts' 'ts:export' 'checkQQLoginQr')); EndpointGroups=@(@('url:https://ssl.ptlogin2.qq.com/ptqrlogin')); Keys=@('ptqrtoken','qrsig','action','u1'); Headers='Cookie'; Pagination='none'; Results=@('65','66','67','68','QRCodeLoginEvents.SCAN','QRCodeLoginEvents.CONF','QRCodeLoginEvents.TIMEOUT','QRCodeLoginEvents.REFUSE'); Minimum=2; SecretInputs='qrsig, ptqrtoken' },
    @{ Operation='post-confirmation exchange'; Class='auth-poll'; Selectors=@((New-Selector python $login 'py:def' '_authorize_qq_qr'),(New-Selector typescript 'src/services/apis/user/checkQQLoginQr.ts' 'ts:export' 'checkQQLoginQr')); EndpointGroups=@('url:https://ssl.ptlogin2.graph.qq.com/check_sig||mm:QQConnectLogin.LoginServer/QQLogin'); Keys=@('client_id','redirect_uri','response_type','code'); Headers='Cookie'; Pagination='none'; Results=@('0','QRCodeLoginEvents.DONE'); Minimum=2; SecretInputs='qrsig, authorization code' },
    @{ Operation='session validation/profile'; Class='account-read'; Selectors=@((New-Selector python $login 'py:def' 'check_expired'),(New-Selector typescript 'src/services/apis/user/getUserDetail.ts' 'ts:export' 'getUserDetail')); EndpointGroups=@('mm:music.UserInfo.userInfoServer/GetLoginUserInfo||url:https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg'); Keys=@('uin','g_tk'); Headers='Cookie'; Pagination='none'; Results=@('0'); Minimum=2; SecretInputs='session credential, UIN' },
    @{ Operation='Favorites read'; Class='account-read'; Selectors=@((New-Selector python $user 'py:def' 'get_fav_song'),(New-Selector typescript 'src/services/apis/user/getUserLikedSongs.ts' 'ts:export' 'getUserLikedSongs')); EndpointGroups=@(@('mm:music.srfDissInfo.DissInfo/CgiGetDiss')); Keys=@('dirid','song_begin','song_num'); Headers='Cookie'; Pagination='song_begin, song_num'; Results=@('0'); Minimum=2; SecretInputs='session credential, UIN' },
    @{ Operation='Favorites write'; Class='account-write'; Selectors=@((New-Selector python $songlist 'py:def' 'like_song'),(New-Selector python $songlist 'py:def' 'unlike_song')); EndpointGroups=@('mm:music.musicasset.PlaylistDetailWrite/AddSonglist||mm:music.musicasset.PlaylistDetailWrite/DelSonglist'); Keys=@('dirId','songId','songType'); Headers='none'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' },
    @{ Operation='playlist summaries'; Class='account-read'; Selectors=@((New-Selector python $user 'py:def' 'get_created_songlist'),(New-Selector typescript 'src/services/apis/user/getUserPlaylists.ts' 'ts:export' 'getUserPlaylists'),(New-Selector typescript 'src/services/apis/user/getUserCollections.ts' 'ts:export' 'getUserCollectedSongLists')); EndpointGroups=@('mm:music.musicasset.PlaylistBaseRead/GetPlaylistByUin||url:https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg||url:https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg'); Keys=@('uin','sin','ein'); Headers='Cookie'; Pagination='offset, limit, page, sin, ein'; Results=@('0'); Minimum=2; SecretInputs='session credential, UIN' },
    @{ Operation='playlist detail'; Class='account-read'; Selectors=@((New-Selector python $songlist 'py:def' 'get_detail'),(New-Selector typescript 'src/services/apis/songLists/songListDetail.ts' 'ts:default-export' 'default')); EndpointGroups=@(@('mm:music.srfDissInfo.DissInfo/CgiGetDiss')); Keys=@('disstid','song_begin','song_num'); Headers='none'; Pagination='song_begin, song_num'; Results=@('0'); Minimum=2; SecretInputs='session credential, UIN' },
    @{ Operation='playlist create'; Class='account-write'; Selectors=@((New-Selector python $songlist 'py:def' 'create')); EndpointGroups=@(@('mm:music.musicasset.PlaylistBaseWrite/AddPlaylist')); Keys=@('dirName'); Headers='none'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' },
    @{ Operation='playlist rename'; Class='account-write'; Selectors=@((New-Selector javascript 'platforms/qqmusic/module/playlist_update.js' 'js:module-exports' 'module.exports'),(New-Selector javascript 'platforms/qqmusic/module/user_playlist_created.js' 'js:module-exports' 'module.exports'),(New-Selector javascript 'platforms/base/BasePlatform.js' 'js:class' 'BasePlatform'),(New-Selector javascript 'platforms/base/BasePlatform.js' 'js:method' 'BasePlatform.loadModules'),(New-Selector javascript 'platforms/base/BasePlatform.js' 'js:method' 'BasePlatform.callModule'),(New-Selector javascript 'platforms/qqmusic/QQMusicPlatform.js' 'js:class' 'QQMusicPlatform'),(New-Selector javascript 'platforms/qqmusic/QQMusicPlatform.js' 'js:method' 'QQMusicPlatform.createRequestFunction'),(New-Selector javascript 'platforms/qqmusic/util/request.js' 'js:const' 'createRequest')); EndpointGroups=@(@('mm:music.musicasset.PlaylistBaseRead/GetPlaylistByUin'),@('mm:music.musicasset.PlaylistBaseWrite/EditPlaylist')); Keys=@('uin','dirId','mask','dirNewName','dirNewDesc','dirNewPicUrl','dirNewtaglist'); ResponseKeys=@('dirId','dirName','picUrl','desc','tagNameList'); Headers='Cookie'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='qm_keyst, UIN'; Edges=(Get-DeclarationEdges) },
    @{ Operation='playlist add'; Class='account-write'; Selectors=@((New-Selector python $songlist 'py:def' 'add_songs')); EndpointGroups=@(@('mm:music.musicasset.PlaylistDetailWrite/AddSonglist')); Keys=@('dirId','songId','songType'); Headers='none'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' },
    @{ Operation='playlist remove'; Class='account-write'; Selectors=@((New-Selector python $songlist 'py:def' 'del_songs')); EndpointGroups=@(@('mm:music.musicasset.PlaylistDetailWrite/DelSonglist')); Keys=@('dirId','songId','songType'); Headers='none'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' },
    @{ Operation='playlist delete'; Class='account-write'; Selectors=@((New-Selector python $songlist 'py:def' 'delete')); EndpointGroups=@(@('mm:music.musicasset.PlaylistBaseWrite/DelPlaylist')); Keys=@('dirId'); Headers='none'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' },
    @{ Operation='recent history'; Class='account-read'; Selectors=@((New-Selector typescript 'src/api/user.ts' 'ts:export' 'getRecentTracks'),(New-Selector typescript 'src/api/client.ts' 'ts:method' 'ApiClient.request')); EndpointGroups=@(@('mm:music.musichallSong.RecentPlayList/GetRecentPlayList')); Keys=@('uin','begin','num'); Headers='Cookie'; Pagination='begin, num'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' },
    @{ Operation='entitlement'; Class='account-read'; Selectors=@((New-Selector python $user 'py:def' 'get_vip_info')); EndpointGroups=@(@('mm:VipLogin.VipLoginInter/vip_login_base')); Keys=@('uin'); Headers='none'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' },
    @{ Operation='playback vkey'; Class='account-read'; Selectors=@((New-Selector python $song 'py:def' 'get_song_urls')); EndpointGroups=@('mm:music.vkey.GetVkey/UrlGetVkey||mm:music.vkey.GetEVkey/CgiGetEVkey'); Keys=@('filename','guid','songmid','uin'); Headers='none'; Pagination='none'; Results=@('0'); Minimum=1; SecretInputs='session credential, UIN' }
  )
  foreach ($definition in $definitions) {
    if (-not $definition.ContainsKey('ResponseKeys')) { $definition['ResponseKeys'] = @() }
    if (-not $definition.ContainsKey('Edges')) { $definition['Edges'] = [DeclarationEdge[]]@() }
    $definition['Spec'] = [OperationEvidenceSpec]::new(
      $definition.Operation,
      [SymbolSelector[]]$definition.Selectors,
      [string[]]$definition.ResponseKeys,
      [DeclarationEdge[]]$definition.Edges,
      $definition.Headers,
      $definition.Pagination,
      [int]$definition.Minimum
    )
  }
  return $definitions
}

function Get-ReferenceBodies {
  param([ReferenceTarget[]]$Targets)
  $seen = @{}
  $bodies = @{}
  $metadata = New-Object 'Collections.Generic.List[object]'
  $proxy = if (-not [string]::IsNullOrWhiteSpace($env:YAQMC_REFERENCE_PROXY)) {
    $env:YAQMC_REFERENCE_PROXY
  } elseif (-not [string]::IsNullOrWhiteSpace($env:HTTPS_PROXY)) {
    $env:HTTPS_PROXY
  } else { $null }
  foreach ($target in $Targets) {
    if ($seen.ContainsKey($target.Path)) { throw "Duplicate immutable target path: $($target.Path)" }
    $seen[$target.Path] = $true
    $uri = "https://raw.githubusercontent.com/$($target.Repository)/$($target.Commit)/$($target.Path)"
    $request = @{ UseBasicParsing = $true; Headers = @{ 'User-Agent' = 'YAQMC-interoperability-audit' }; Uri = $uri }
    if ($proxy) { $request.Proxy = $proxy }
    $response = Invoke-WebRequest @request
    $bytes = [byte[]]$response.RawContentStream.ToArray()
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    $text = $utf8.GetString($bytes)
    if ([string]::IsNullOrWhiteSpace($text)) { throw "Pinned reference is empty: $($target.Path)" }
    $bodies[$target.Path] = $text
    $metadata.Add([ordered]@{
      repository = $target.Repository
      commit = $target.Commit
      path = $target.Path
      contentSha256 = Get-Sha256Bytes $bytes
    }) | Out-Null
  }
  return [pscustomobject]@{ Bodies = $bodies; Metadata = $metadata.ToArray() }
}

function Assert-MinimumCorroboration {
  param([int]$Actual, [int]$Minimum, [string]$Operation)
  if ($Actual -lt $Minimum) {
    throw "Insufficient corroborating sources for $Operation`: $Actual/$Minimum"
  }
}

function Resolve-OperationEvidence {
  param($Definition, [ReferenceTarget[]]$Targets, [hashtable]$Bodies)
  $blocks = New-Object 'Collections.Generic.List[string]'
  $sources = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($selector in $Definition.Spec.Selectors) {
    Assert-SelectorMetadata $selector
    $target = Get-TargetByPath $Targets $selector.Path
    try {
      $block = Get-AnchorBlock $Bodies[$selector.Path] $selector
    } catch {
      throw "Failed selector $($Definition.Operation) -> $($selector.Path)#$($selector.AnchorKind):$($selector.Anchor): $($_.Exception.Message)"
    }
    $blocks.Add($block) | Out-Null
    [void]$sources.Add("$($target.Repository)@$($target.Commit):$($target.Path)")
  }
  if ($Definition.Operation -eq 'Favorites write') {
    $songlistBody = $Bodies['qqmusic_api/modules/songlist.py']
    $likeBlock = Get-PythonDeclarationBlock $songlistBody 'like_song'
    $unlikeBlock = Get-PythonDeclarationBlock $songlistBody 'unlike_song'
    if ($likeBlock -notmatch '\bself\.add_songs\s*\(' -or $unlikeBlock -notmatch '\bself\.del_songs\s*\(') {
      throw 'Favorites write delegates are disconnected.'
    }
    $blocks.Add((Get-PythonDeclarationBlock $songlistBody 'add_songs')) | Out-Null
    $blocks.Add((Get-PythonDeclarationBlock $songlistBody 'del_songs')) | Out-Null
  }
  if ($Definition.Operation -in @('Favorites write','playlist add','playlist remove')) {
    $songlistBody = $Bodies['qqmusic_api/modules/songlist.py']
    $requestBuilder = Get-PythonDeclarationBlock $songlistBody '_build_songlist_oper_param'
    if (-not (@($blocks | Where-Object { $_ -match '\b_build_songlist_oper_param\s*\(' }).Count -gt 0)) {
      throw "Disconnected song-list request builder for $($Definition.Operation)."
    }
    $blocks.Add($requestBuilder) | Out-Null
  }
  if ($Definition.Operation -eq 'playlist summaries') {
    $collectionBody = $Bodies['src/services/apis/user/getUserCollections.ts']
    $entryBlock = Get-AnchorBlock $collectionBody (New-Selector typescript 'src/services/apis/user/getUserCollections.ts' 'ts:export' 'getUserCollectedSongLists')
    if ($entryBlock -notmatch '\bgetUserCollection\s*\(') { throw 'Collected-playlist delegate is disconnected.' }
    $blocks.Add((Get-AnchorBlock $collectionBody (New-Selector typescript 'src/services/apis/user/getUserCollections.ts' 'ts:export' 'getUserCollection'))) | Out-Null
    $requestBody = Remove-CodeComments $Bodies['src/util/request.ts'] 'typescript'
    $requestMatch = [regex]::Match($requestBody, '(?m)function\s+request(?:<[^\r\n{]+>)?\s*\(')
    if (-not $requestMatch.Success) { throw 'Missing playlist-summary request wrapper.' }
    $requestBlock = Get-BalancedBraceBlock $requestBody $requestMatch.Index
    if ($requestBlock -notmatch '\bBASE_URL_MAP\b' -or
        $requestBody -notmatch '(?m)^const\s+cURL\s*=\s*["'']https://c\.y\.qq\.com["'']' -or
        $requestBody -notmatch '(?m)^\s*c\s*:\s*cURL\s*,?\s*$') {
      throw 'Collected-playlist relative URL is not connected to the c.y.qq.com base.'
    }
    $blocks.Add($requestBlock) | Out-Null
    $blocks.Add('https://c.y.qq.com') | Out-Null
  }
  if ($Definition.Operation -eq 'entitlement') {
    if (-not (@($blocks | Where-Object { $_ -match '\bcredential\s*=\s*credential\b' }).Count -gt 0)) {
      throw 'Entitlement request is not connected to the shared credential envelope.'
    }
    $blocks.Add((Get-PythonDeclarationBlock $Bodies['qqmusic_api/core/versioning.py'] 'build_comm')) | Out-Null
  }
  Assert-MinimumCorroboration $sources.Count $Definition.Spec.MinimumCorroboratingSources $Definition.Operation
  $resolvedEndpointGroups = @()
  foreach ($group in $Definition.EndpointGroups) {
    $alternatives = @($group -split '\|\|')
    $matched = @($alternatives | Where-Object { Test-EndpointRequirement @($blocks) $_ })
    if ($matched.Count -eq 0) { throw "Missing endpoint evidence for $($Definition.Operation): $($group -join ' or ')" }
    $resolvedEndpointGroups += (($matched | ForEach-Object {
      if ($_.StartsWith('url:', [StringComparison]::Ordinal)) { $_.Substring(4) } else { $_.Substring(3) }
    }) -join ' or ')
  }
  foreach ($key in $Definition.Keys) {
    if (-not (@($blocks | Where-Object { Test-LiteralToken $_ $key }).Count -gt 0)) {
      throw "Missing request key $key for $($Definition.Operation)"
    }
  }
  $knownPagination = @('offset','limit','page','pageSize','song_begin','song_num','begin','num','sin','ein')
  if ($Definition.Pagination -eq 'none') {
    foreach ($paginationKey in $knownPagination) {
      if (@($blocks | Where-Object { Test-LiteralToken $_ $paginationKey }).Count -gt 0) {
        throw "Unexpected pagination token $paginationKey for $($Definition.Operation)"
      }
    }
  } else {
    foreach ($paginationKey in @($Definition.Pagination -split '\s*,\s*')) {
      if (-not (@($blocks | Where-Object { Test-LiteralToken $_ $paginationKey }).Count -gt 0)) {
        throw "Missing pagination token $paginationKey for $($Definition.Operation)"
      }
    }
  }
  $requestHeaders = @($blocks | ForEach-Object { Get-RequestHeaderNames $_ } | Sort-Object -Unique)
  if ($requestHeaders -notcontains 'Cookie' -and (Test-DelegatedCookieHeader @($blocks) $Bodies)) {
    $requestHeaders += 'Cookie'
  }
  if ($Definition.Headers -eq 'none') {
    if ($requestHeaders.Count -ne 0) { throw "Unexpected secret request header for $($Definition.Operation)" }
  } elseif ($requestHeaders -notcontains $Definition.Headers) {
    throw "Missing request header $($Definition.Headers) for $($Definition.Operation)"
  }
  $resolvedResults = @()
  $resultBlocks = @($blocks)
  $commonDecoder = Get-CommonResultDecoderBlock $Definition.Operation $Bodies
  if (-not [string]::IsNullOrWhiteSpace($commonDecoder)) { $resultBlocks += $commonDecoder }
  foreach ($result in $Definition.Results) {
    if (-not (Test-ValidResultToken $result)) { throw "Invalid declared result token: $result" }
    if (@($resultBlocks | Where-Object { Test-LiteralToken $_ $result }).Count -gt 0) {
      $resolvedResults += $result
    }
  }
  if ($resolvedResults.Count -eq 0) { throw "Missing valid result evidence for $($Definition.Operation)" }
  foreach ($responseKey in $Definition.ResponseKeys) {
    $created = $Bodies['platforms/qqmusic/module/user_playlist_created.js']
    if (-not (Test-LiteralToken $created $responseKey) -or $created -notmatch 'response\.body\.v_playlist') {
      throw "Missing anchored response key $responseKey for $($Definition.Operation)"
    }
  }
  $edgeNames = @()
  if ($Definition.Edges.Count -gt 0) {
    $edgeNames = Get-RenameEdges $Bodies
    $expectedEdgeNames = @($Definition.Edges | ForEach-Object { Convert-DeclarationEdgeToIdentity $_ })
    if ($edgeNames.Count -ne $expectedEdgeNames.Count) {
      throw "Disconnected playlist rename declaration chain: $($edgeNames.Count)/$($Definition.Edges.Count)"
    }
    for ($edgeIndex = 0; $edgeIndex -lt $expectedEdgeNames.Count; $edgeIndex += 1) {
      if ($edgeNames[$edgeIndex] -cne $expectedEdgeNames[$edgeIndex]) {
        throw "Playlist rename edge mismatch at index $edgeIndex"
      }
    }
  }
  $responseHeaders = @($blocks | ForEach-Object { Get-ResponseHeaderNames $_ } | Sort-Object -Unique)
  return [ordered]@{
    operation = $Definition.Operation
    class = $Definition.Class
    endpoints = @($resolvedEndpointGroups)
    requestKeys = @($Definition.Keys)
    responseKeys = @($Definition.ResponseKeys)
    requestHeaders = if ($Definition.Headers -eq 'none') { @('none') } else { @($Definition.Headers) }
    responseHeaders = $responseHeaders
    pagination = @($Definition.Pagination)
    results = @($resolvedResults)
    declarationEdges = @($edgeNames)
    corroboration = @($sources | Sort-Object)
    secretInputs = $Definition.SecretInputs
    liveStatus = 'reference-correlated; live acceptance pending'
    confidence = if ($sources.Count -ge 2) { 'high' } else { 'medium' }
  }
}

function Get-LedgerRows {
  param($Resolved)
  return @($Resolved | ForEach-Object {
    [ordered]@{
      Operation = $_.Operation
      Endpoint = @($_.Endpoints) -join ' and '
      Class = $_.Class
      Request = (@($_.RequestKeys) -join ', ') + '; pagination: ' + (@($_.Pagination) -join ', ')
      SecretInputs = $_.SecretInputs
      Headers = @($_.RequestHeaders) -join ', '
      Results = @($_.Results) -join ', '
      Corroboration = @($_.Corroboration) -join '<br>'
      LiveStatus = $_.LiveStatus
      Confidence = $_.Confidence
    }
  })
}

function Normalize-LedgerCell {
  param([string]$Value)
  return (($Value -replace '`', '') -replace '\s+', ' ').Trim()
}

function Test-Ledger {
  param([string]$Path, $Rows)
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'Ledger file does not exist.' }
  $lines = @(Get-Content -LiteralPath $resolved -Encoding UTF8)
  foreach ($expected in $Rows) {
    $matches = @($lines | Where-Object { $_ -match ('^\|\s*' + [regex]::Escape($expected.Operation) + '\s*\|') })
    if ($matches.Count -ne 1) { throw "Ledger row count for $($expected.Operation): $($matches.Count)" }
    $cells = @($matches[0].Trim('|').Split('|') | ForEach-Object { Normalize-LedgerCell $_ })
    if ($cells.Count -ne 10) { throw "Ledger column count for $($expected.Operation): $($cells.Count)" }
    $values = @($expected.Operation,$expected.Endpoint,$expected.Class,$expected.Request,$expected.SecretInputs,$expected.Headers,$expected.Results,$expected.Corroboration,$expected.LiveStatus,$expected.Confidence)
    for ($index = 0; $index -lt $values.Count; $index += 1) {
      if ($cells[$index] -ne (Normalize-LedgerCell ([string]$values[$index]))) {
        throw "Ledger mismatch for $($expected.Operation), column $($index + 1)"
      }
    }
  }
}

function Get-SyntheticRenameBodies {
  $base = @'
class BasePlatform {
  async loadModules(modulePath) {
    const moduleRoute = file.replace(/\.js$/i, '').replace(/_/g, '/')
    const moduleFunction = require(path.join(modulePath, file))
    this.modules.set(moduleRoute, moduleFunction)
  }
  async callModule(route, query) {
    const moduleFunction = this.modules.get(route)
    return moduleFunction(
      query,
      this.createRequestFunction()
    )
  }
}
'@
  $platform = @'
const request = require('./util/request')
class QQMusicPlatform extends BasePlatform {
  createRequestFunction() {
    return (module, method, data, options = {}) => request.createRequest(module, method, data, options)
  }
}
'@
  $update = @'
const getPlaylistCreated = require('./user_playlist_created')
module.exports = async(query, request) => {
  const current = await getPlaylistCreated(query, request)
  return request("music.musicasset.PlaylistBaseWrite", "EditPlaylist", {
    dirId: current.dirId,
    mask: 15,
    dirNewName: query.name,
    dirNewDesc: query.desc,
    dirNewPicUrl: query.pic,
    dirNewtaglist: query.tags
  })
}
'@
  $created = @'
module.exports = async (query, request) => {
  const response = await request("music.musicasset.PlaylistBaseRead", "GetPlaylistByUin", { uin: query.uin })
  return response.body.v_playlist.map(item => ({
    dirId: item.dirId,
    dirName: item.dirName,
    picUrl: item.picUrl,
    desc: item.desc,
    tagNameList: item.tagNameList
  }))
}
'@
  $request = @'
const createRequest = (module, method, data, options = {}) => {
  const headers = {}
  headers['Cookie'] = options.qm_keyst
  return { code: 0, module, method, data, headers }
}
module.exports = { createRequest }
'@
  return @{
    'platforms/base/BasePlatform.js' = $base
    'platforms/qqmusic/QQMusicPlatform.js' = $platform
    'platforms/qqmusic/module/playlist_update.js' = $update
    'platforms/qqmusic/module/user_playlist_created.js' = $created
    'platforms/qqmusic/util/request.js' = $request
  }
}

function Assert-SyntheticRenameFixture {
  param([hashtable]$Bodies)
  $actual = @(Get-RenameEdges $Bodies)
  $expected = @(Get-DeclarationEdges | ForEach-Object { Convert-DeclarationEdgeToIdentity $_ })
  if ($actual.Count -ne $expected.Count) { throw "Synthetic rename chain is incomplete: $($actual.Count)/$($expected.Count)" }
  for ($index = 0; $index -lt $expected.Count; $index += 1) {
    if ($actual[$index] -cne $expected[$index]) { throw "Synthetic rename edge mismatch at $index" }
  }
  $created = $Bodies['platforms/qqmusic/module/user_playlist_created.js']
  foreach ($field in @('dirId','dirName','picUrl','desc','tagNameList')) {
    if (-not (Test-LiteralToken $created $field)) { throw "Synthetic rename mapper lost $field" }
  }
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Name)
  $threw = $false
  try { & $Action } catch { $threw = $true }
  if (-not $threw) { throw "Expected rejection did not occur: $Name" }
}

function Assert-SyntheticMutationRejected {
  param([string]$Mutation)
  $rejected = $false
  try {
    switch ($Mutation) {
      'fabricated-operation-tag' {
        $fake = "operations = @('playlist rename')"
        if (-not (Test-EndpointRequirement @($fake) 'mm:music.musicasset.PlaylistBaseWrite/EditPlaylist')) {
          throw 'An operation tag cannot create endpoint evidence.'
        }
      }
      'empty-evidence-class' {
        $selector = New-Selector typescript 'fixture.ts' 'ts:export' 'probe'
        $selector.EvidenceClass = ''
        Assert-SelectorMetadata $selector
      }
      'response-set-cookie' {
        $responseOnly = "const value = response.headers.get('Set-Cookie')"
        if (@(Get-RequestHeaderNames $responseOnly) -notcontains 'Cookie') {
          throw 'Response Set-Cookie cannot satisfy request Cookie evidence.'
        }
      }
      'noisy-result-token' {
        if (-not (Test-ValidResultToken 'authorizeRes')) { throw 'Noisy result identifier rejected.' }
      }
      'missing-playlist-rename-anchor' {
        $fixture = "class Api:`n  def create(self):`n    return 0"
        [void](Get-PythonDeclarationBlock $fixture 'rename')
      }
      'missing-recent-history-anchor' {
        $fixture = "class Api:`n  def get_history(self):`n    return 0"
        [void](Get-PythonDeclarationBlock $fixture 'get_recent_song')
      }
      'disconnected-rename-delegate' {
        $bodies = Get-SyntheticRenameBodies
        $bodies['platforms/qqmusic/QQMusicPlatform.js'] = $bodies['platforms/qqmusic/QQMusicPlatform.js'].Replace('request.createRequest', 'request.detachedRequest')
        Assert-SyntheticRenameFixture $bodies
      }
      'missing-rename-preservation-field' {
        $bodies = Get-SyntheticRenameBodies
        $bodies['platforms/qqmusic/module/user_playlist_created.js'] = $bodies['platforms/qqmusic/module/user_playlist_created.js'].Replace('tagNameList', 'removedTagField')
        Assert-SyntheticRenameFixture $bodies
      }
    }
  } catch { $rejected = $true }
  if (-not $rejected) { throw "Self-test mutation was accepted: $Mutation" }
  Write-Output "EXPECTED_REJECTION:$Mutation"
}

function Invoke-SelfTest {
  $typescript = @'
export const probe = async () => client.request({
  module: 'music.example.Read',
  method: 'GetPage',
  params: { page: 1, pageSize: 20 }
});
'@
  $selector = New-Selector typescript 'fixture.ts' 'ts:export' 'probe'
  Assert-SelectorMetadata $selector
  $typescriptBlock = Get-AnchorBlock $typescript $selector
  if (-not (Test-ModuleMethod @($typescriptBlock) 'music.example.Read' 'GetPage')) {
    throw 'Multiline TypeScript module/method pair was not extracted.'
  }
  foreach ($token in @('module','method','params','page','pageSize')) {
    if (-not (Test-LiteralToken $typescriptBlock $token)) { throw "Multiline TypeScript token missing: $token" }
  }

  Assert-SyntheticRenameFixture (Get-SyntheticRenameBodies)

  $responseOnly = "const value = response.headers.get('Set-Cookie')"
  if (@(Get-RequestHeaderNames $responseOnly).Count -ne 0) { throw 'Response Set-Cookie became request evidence.' }
  if ((Get-ResponseHeaderNames $responseOnly) -notcontains 'Set-Cookie') { throw 'Response header was not classified.' }
  foreach ($token in @('case','exc','int','match','raise','resp','str','await','self','null','authorizeRes')) {
    if (Test-ValidResultToken $token) { throw "Noisy result token accepted: $token" }
    if (Test-ValidResultToken $token $true) { throw "Quoted noisy result token accepted: $token" }
  }
  if (Test-ValidResultToken 'arbitraryIdentifier') { throw 'Bare arbitrary result identifier accepted.' }
  if (-not (Test-ValidResultToken 'OK' $true)) { throw 'Valid quoted result token was rejected.' }
  if (-not (Test-ValidResultToken 'QRCodeLoginEvents.SCAN')) { throw 'Valid enum result token was rejected.' }
  if (-not (Test-ValidResultToken '0')) { throw 'Valid numeric result token was rejected.' }

  Assert-Throws { Get-TargetByPath (Get-ReferenceTargets) 'unknown/path.ts' } 'unknown immutable path'
  Assert-Throws { Get-AnchorBlock $typescript (New-Selector typescript 'fixture.ts' 'ts:export' 'missing') } 'unknown anchor'
  Assert-Throws { Assert-MinimumCorroboration 1 2 'synthetic' } 'corroboration shortfall'

  foreach ($mutation in @(
    'fabricated-operation-tag','empty-evidence-class','response-set-cookie','noisy-result-token',
    'missing-playlist-rename-anchor','missing-recent-history-anchor',
    'disconnected-rename-delegate','missing-rename-preservation-field'
  )) { Assert-SyntheticMutationRejected $mutation | Out-Null }
  Write-Output 'SELF_TEST_PASS'
}

if ($PSCmdlet.ParameterSetName -eq 'SelfTest') {
  Invoke-SelfTest
  exit 0
}
if ($PSCmdlet.ParameterSetName -eq 'Mutation') {
  Assert-SyntheticMutationRejected $SelfTestMutation
  exit 0
}

$targets = Get-ReferenceTargets
$definitions = Get-OperationDefinitions
$operationNames = @($definitions | ForEach-Object Operation)
if (($operationNames | Sort-Object -Unique).Count -ne $operationNames.Count) {
  throw 'Duplicate operation names in immutable evidence manifest.'
}
$reference = Get-ReferenceBodies $targets
$resolved = @($definitions | ForEach-Object {
  Resolve-OperationEvidence $_ $targets $reference.Bodies
})

if ($PSCmdlet.ParameterSetName -eq 'Emit') {
  [ordered]@{
    schemaVersion = 1
    pins = $reference.Metadata
    operations = $resolved
  } | ConvertTo-Json -Depth 20
  exit 0
}

$rows = Get-LedgerRows $resolved
Test-Ledger $VerifyLedger $rows
Write-Output "REFERENCE_LEDGER_PASS:$([IO.Path]::GetFullPath($VerifyLedger))"
