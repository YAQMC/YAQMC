[CmdletBinding()]
param(
  [string]$Repository = "YAQMC/YAQMC"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$wikiSource = Join-Path $repositoryRoot "wiki"
$sourceFiles = @(
  "Home.md",
  "_Sidebar.md",
  "安装与更新.md",
  "常见问题.md",
  "Linux-测试.md",
  "开发者入口.md",
  "English.md"
)

if (-not (Test-Path -LiteralPath $wikiSource -PathType Container)) {
  throw "Wiki source directory not found: $wikiSource"
}

$repositoryInfo = gh repo view $Repository --json visibility,hasWikiEnabled | ConvertFrom-Json
if ($repositoryInfo.visibility -ne "PUBLIC") {
  throw "GitHub Free organization wikis cannot be published from this private repository. Make the repository public only after choosing a project license."
}
if (-not $repositoryInfo.hasWikiEnabled) {
  throw "Enable GitHub Wiki for $Repository before publishing."
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("yaqmc-wiki-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

try {
  $wikiUrl = "https://github.com/$Repository.wiki.git"
  git clone --quiet $wikiUrl $temporaryRoot
  if ($LASTEXITCODE -ne 0) {
    throw "The Wiki repository is not initialized. Open the GitHub Wiki tab, create the first page, then rerun this script."
  }

  $resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path
  $resolvedTempBase = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
  if (-not $resolvedTemporaryRoot.StartsWith($resolvedTempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a directory outside the system temporary root."
  }

  Get-ChildItem -LiteralPath $temporaryRoot -File -Filter "*.md" | Remove-Item -Force
  foreach ($file in $sourceFiles) {
    $sourcePath = Join-Path $wikiSource $file
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Missing Wiki source file: $file"
    }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $temporaryRoot $file)
  }

  git -C $temporaryRoot add --all
  $pending = git -C $temporaryRoot status --porcelain
  if (-not $pending) {
    Write-Host "Wiki is already up to date."
    exit 0
  }

  git -C $temporaryRoot commit -m "docs: update YAQMC wiki"
  if ($LASTEXITCODE -ne 0) { throw "Wiki commit failed." }
  git -C $temporaryRoot push origin HEAD
  if ($LASTEXITCODE -ne 0) { throw "Wiki push failed." }
  Write-Host "Published YAQMC Wiki from the tracked source directory."
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    $resolved = (Resolve-Path -LiteralPath $temporaryRoot).Path
    $tempBase = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
    if ($resolved.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }
}
