[CmdletBinding(DefaultParameterSetName = 'Scan')]
param(
  [Parameter(ParameterSetName = 'SelfTest', Mandatory = $true)]
  [switch]$SelfTest,

  [Parameter(ParameterSetName = 'Path', Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
$script:AssignmentPattern = [regex]::new(
  '(?i)["'']?(authorization|cookie|set-cookie|qm_keyst|qrsig|ptqrtoken|access_token|refresh_token|refresh_key|musickey|openid|unionid|uin|musicid|str_musicid|callback_url)["'']?\s*[:=]\s*(?:"(?<double>[^"\r\n]*)"|''(?<single>[^''\r\n]*)''|Bearer\s+(?<bearer>[^\s",;}\]\)]+)|(?<bare>\[REDACTED\]|[^\s",;}\]\)]+))'
)
$script:SignedUrlPattern = [regex]::new(
  '(?i)[?&](vkey|token|sig|key)=(?<value>[A-Za-z0-9._~%+-]{8,})'
)

function Test-SafeValue {
  param([AllowEmptyString()][string]$Value)

  $candidate = $Value.Trim()
  if ($candidate.StartsWith('Bearer ', [StringComparison]::OrdinalIgnoreCase)) {
    $candidate = $candidate.Substring(7).Trim()
  }
  $candidate = $candidate.TrimEnd([char]96)

  if ($candidate -ceq '[REDACTED]' -or
      $candidate -ieq '%5BREDACTED%5D' -or
      $candidate -ieq 'redacted' -or
      $candidate -ceq 'SECRET' -or
      $candidate -like 'SANITIZED_*' -or
      $candidate -in @('{', '[', '(')) {
    return $true
  }

  # Environment-variable and angle-bracket placeholders are references, not values.
  if ($candidate -match '^\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*(?:\})?$' -or
      $candidate -match '^%[A-Za-z_][A-Za-z0-9_]*%$' -or
      $candidate -match '^<[A-Za-z_][A-Za-z0-9_.-]*>$') {
    return $true
  }

  return [string]::IsNullOrWhiteSpace($candidate)
}

function Get-LineFindings {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$DisplayPath
  )

  $findings = [Collections.Generic.List[string]]::new()
  $lines = [regex]::Split($Text, '\r?\n')
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    $line = $lines[$index]
    foreach ($match in $script:AssignmentPattern.Matches($line)) {
      $value = if ($match.Groups['double'].Success) {
        $match.Groups['double'].Value
      } elseif ($match.Groups['single'].Success) {
        $match.Groups['single'].Value
      } elseif ($match.Groups['bearer'].Success) {
        $match.Groups['bearer'].Value
      } else {
        $match.Groups['bare'].Value
      }
      if (-not (Test-SafeValue -Value $value)) {
        $findings.Add(('{0}:{1}: assigned {2} value' -f $DisplayPath, ($index + 1), $match.Groups[1].Value))
      }
    }

    foreach ($match in $script:SignedUrlPattern.Matches($line)) {
      if (-not (Test-SafeValue -Value $match.Groups['value'].Value)) {
        $findings.Add(('{0}:{1}: signed URL query value' -f $DisplayPath, ($index + 1)))
      }
    }
  }
  return $findings.ToArray()
}

function Get-RepositoryCandidatePaths {
  $repositoryRoot = Split-Path -Parent $PSScriptRoot
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = 'git.exe'
  $startInfo.Arguments = 'ls-files -z --cached --others --exclude-standard -- README.md docs tests/fixtures'
  $startInfo.WorkingDirectory = $repositoryRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "git ls-files failed: $stderr"
  }
  $separator = [char[]]@([char]0)
  return @($stdout.Split($separator, [StringSplitOptions]::RemoveEmptyEntries))
}

function Invoke-PathScan {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$DisplayPath
  )

  $text = [IO.File]::ReadAllText($LiteralPath)
  return @(Get-LineFindings -Text $text -DisplayPath $DisplayPath)
}

function Invoke-SelfTest {
  $secretTail = 'value-12345678'
  $authorizationCase = 'Authorization: Bearer session-' + $secretTail
  $cookieCase = '"cookie":"session-' + $secretTail + '"'
  $urlCase = 'https://example.invalid/media?v' + 'key=token-12345678'
  $secondFieldCase = '"uin":"SANITIZED_ACCOUNT","refresh_' + 'token":"session-' + $secretTail + '"'
  $rejected = @()
  $rejected += @(Get-LineFindings -Text $authorizationCase -DisplayPath '<self-test>')
  $rejected += @(Get-LineFindings -Text $cookieCase -DisplayPath '<self-test>')
  $rejected += @(Get-LineFindings -Text $urlCase -DisplayPath '<self-test>')
  $rejected += @(Get-LineFindings -Text $secondFieldCase -DisplayPath '<self-test>')
  if ($rejected.Count -ne 4) {
    throw "secret scanner self-test expected four rejected cases, got $($rejected.Count)"
  }

  foreach ($safeCase in @(
      'qm_keyst',
      'qm_keyst=[REDACTED]',
      '"uin":"SANITIZED_ACCOUNT"',
      '`Authorization: Bearer $LOCAL_API_TOKEN`',
      '`Authorization: Bearer <LOCAL_API_TOKEN>`',
      '"authorization": {',
      'https://qpic.y.qq.com/synthetic.png'
    )) {
    $findings = @(Get-LineFindings -Text $safeCase -DisplayPath '<self-test>')
    if ($findings.Count -ne 0) {
      throw "secret scanner self-test rejected a safe case: $safeCase"
    }
  }
  [Console]::WriteLine('secret scanner self-test passed')
}

if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$allFindings = [Collections.Generic.List[string]]::new()
if ($PSCmdlet.ParameterSetName -eq 'Path') {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  foreach ($finding in @(Invoke-PathScan -LiteralPath $resolved -DisplayPath $Path)) {
    $allFindings.Add($finding)
  }
} else {
  foreach ($relativePath in @(Get-RepositoryCandidatePaths)) {
    $absolutePath = Join-Path $repositoryRoot $relativePath
    foreach ($finding in @(Invoke-PathScan -LiteralPath $absolutePath -DisplayPath $relativePath)) {
      $allFindings.Add($finding)
    }
  }
}

if ($allFindings.Count -gt 0) {
  foreach ($finding in $allFindings) {
    [Console]::Error.WriteLine($finding)
  }
  exit 1
}

[Console]::WriteLine('account secret scan passed')
exit 0
