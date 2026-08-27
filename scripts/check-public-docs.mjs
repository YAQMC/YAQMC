import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDocuments = [
  'account-membership.md',
  'account-library.md',
  'appearance.md',
  'architecture.md',
  'artwork.md',
  'audio-quality.md',
  'authentication.md',
  'caching.md',
  'ci.md',
  'data-locations.md',
  'design-system.md',
  'deep-link.md',
  'development.md',
  'diagnostics.md',
  'discover.md',
  'entitlement.md',
  'home-recommendations.md',
  'i18n.md',
  'issue-reporting.md',
  'linux.md',
  'linux-acceptance.md',
  'linux-graphics.md',
  'local-api.md',
  'logging.md',
  'lyrics.md',
  'lyrics-presets.md',
  'lyrics-composer.md',
  'lyrics-surfaces.md',
  'platform-integration.md',
  'playback.md',
  'plugin-platform.md',
  'plugin-manifest.md',
  'plugin-security.md',
  'plugin-development.md',
  'plugin-examples.md',
  'plugin-style-api.md',
  'plugin-scene-api.md',
  'provider-contract.md',
  'qqmusic-provider.md',
  'qqmusic-artwork.md',
  'qqmusic-official-interoperability.md',
  'security.md',
  'streaming.md',
  'windows-acceptance.md',
];

const communityDocuments = [
  'README.md',
  'README-EN.md',
  'ACKNOWLEDGEMENTS.md',
  'ACKNOWLEDGEMENTS-EN.md',
  'CHANGELOG.md',
  'CHANGELOG-EN.md',
  'CODE_OF_CONDUCT.md',
  'CODE_OF_CONDUCT-EN.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING-EN.md',
  'SECURITY.md',
  'SECURITY-EN.md',
  'SUPPORT.md',
  'SUPPORT-EN.md',
  'CORRESPONDING_SOURCE_POLICY.md',
  'LICENSING_CONSENT.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/README.md',
  'docs/release/README.md',
  'docs/release/provider-readiness.md',
  'docs/release/provenance.md',
  'docs/release/qm-api-rs-provenance.md',
  'docs/zh-CN/README.md',
];

const errors = [];

const forbiddenPublicPlaceholders = [
  /\[PROJECT_NAME\]/u,
  /\$PROJECT_NAME_API_TOKEN/u,
  /GPT-Read-?me\.md/iu,
];

const forbiddenPublicContent = [
  {
    pattern: /[A-Z]:\\(?:Users|Downloads|Documents|YAQMC)(?:\\|\b)/iu,
    label: 'workstation-specific absolute Windows path',
  },
  {
    pattern: /\/(?:home|Users)\/[^/\s)]+/u,
    label: 'workstation-specific absolute user path',
  },
  { pattern: /\bHANDOFF[_-]\d{4}/iu, label: 'internal handoff reference' },
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function requireFile(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!(await exists(absolutePath))) {
    errors.push(`Missing required file: ${relativePath}`);
  }
  return absolutePath;
}

function extractMarkdownTargets(markdown) {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(
    (match) =>
      match[1]
        .trim()
        .replace(/^<|>$/g, '')
        .split(/\s+['"]/u, 1)[0],
  );
}

async function checkMarkdownLinks(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const markdown = await readFile(absolutePath, 'utf8');
  const sourceDirectory = path.dirname(absolutePath);

  for (const rawTarget of extractMarkdownTargets(markdown)) {
    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z+.-]*:/iu.test(rawTarget)) {
      continue;
    }

    const withoutFragment = rawTarget.split('#', 1)[0].split('?', 1)[0];
    if (!withoutFragment) continue;

    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(withoutFragment);
    } catch {
      errors.push(`${relativePath}: malformed local link ${rawTarget}`);
      continue;
    }

    const resolved = path.resolve(sourceDirectory, decodedTarget);
    if (!(await exists(resolved))) {
      errors.push(`${relativePath}: missing local link target ${rawTarget}`);
    }
  }
}

for (const fileName of publicDocuments) {
  const englishPath = `docs/${fileName}`;
  const chinesePath = `docs/zh-CN/${fileName}`;
  const englishAbsolute = await requireFile(englishPath);
  const chineseAbsolute = await requireFile(chinesePath);

  if (
    (await exists(englishAbsolute)) &&
    !(await readFile(englishAbsolute, 'utf8')).includes(`zh-CN/${fileName}`)
  ) {
    errors.push(`${englishPath}: missing Simplified Chinese language link`);
  }
  if (
    (await exists(chineseAbsolute)) &&
    !(await readFile(chineseAbsolute, 'utf8')).includes(`../${fileName}`)
  ) {
    errors.push(`${chinesePath}: missing English language link`);
  }
}

const chineseReadme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
const englishReadme = await readFile(path.join(repositoryRoot, 'README-EN.md'), 'utf8');
if (/\]\(docs\/(?!zh-CN\/)/u.test(chineseReadme)) {
  errors.push('README.md: public documentation links must target docs/zh-CN/');
}
if (englishReadme.includes('](docs/zh-CN/')) {
  errors.push('README-EN.md: English documentation links must not target docs/zh-CN/');
}

if (!chineseReadme.includes('`v0.1.0-beta.6`') || !chineseReadme.includes('Electron `main`')) {
  errors.push(
    'README.md: must distinguish the current Electron tree from the latest legacy release',
  );
}
if (!englishReadme.includes('`v0.1.0-beta.6`') || !englishReadme.includes('Electron `main`')) {
  errors.push(
    'README-EN.md: must distinguish the current Electron tree from the latest legacy release',
  );
}

const englishLyrics = await readFile(path.join(repositoryRoot, 'docs/lyrics.md'), 'utf8');
const chineseLyrics = await readFile(path.join(repositoryRoot, 'docs/zh-CN/lyrics.md'), 'utf8');
for (const [relativePath, contents] of [
  ['docs/lyrics.md', englishLyrics],
  ['docs/zh-CN/lyrics.md', chineseLyrics],
]) {
  for (const required of [
    '@applemusic-like-lyrics/core',
    '@applemusic-like-lyrics/react',
    'AGPL-3.0-only',
  ]) {
    if (!contents.includes(required)) {
      errors.push(`${relativePath}: missing current AMLL dependency fact ${required}`);
    }
  }
}
if (/没有使用[^\n]*AMLL/u.test(chineseLyrics)) {
  errors.push('docs/zh-CN/lyrics.md: contradicts the lockfile-pinned AMLL dependency');
}

const publicMarkdownDocuments = [
  ...communityDocuments,
  ...publicDocuments.map((file) => `docs/${file}`),
  ...publicDocuments.map((file) => `docs/zh-CN/${file}`),
];

for (const relativePath of publicMarkdownDocuments) {
  await requireFile(relativePath);
  if (await exists(path.join(repositoryRoot, relativePath))) {
    await checkMarkdownLinks(relativePath);
    const contents = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    for (const forbidden of forbiddenPublicPlaceholders) {
      if (forbidden.test(contents)) {
        errors.push(`${relativePath}: contains forbidden public placeholder ${forbidden}`);
      }
    }
    for (const forbidden of forbiddenPublicContent) {
      if (forbidden.pattern.test(contents)) {
        errors.push(`${relativePath}: contains ${forbidden.label}`);
      }
    }
  }
}

for (const requiredCommunityFile of [
  'LICENSE',
  '.github/ISSUE_TEMPLATE/bug-report.yml',
  '.github/ISSUE_TEMPLATE/feature-request.yml',
  '.github/ISSUE_TEMPLATE/linux-compatibility.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
]) {
  await requireFile(requiredCommunityFile);
}

for (const requiredSiteFile of [
  'site/index.html',
  'site/en/index.html',
  'site/styles.css',
  'assets/yaqmc-logo.png',
]) {
  await requireFile(requiredSiteFile);
}

const chineseSite = await readFile(path.join(repositoryRoot, 'site/index.html'), 'utf8');
const englishSite = await readFile(path.join(repositoryRoot, 'site/en/index.html'), 'utf8');
if (!chineseSite.includes('lang="zh-CN"') || !chineseSite.includes('href="en/"')) {
  errors.push('site/index.html: missing Chinese language declaration or English switch');
}
if (!englishSite.includes('lang="en"') || !englishSite.includes('href="../"')) {
  errors.push('site/en/index.html: missing English language declaration or Chinese switch');
}
if (
  !chineseSite.includes('v0.1.0-beta.6') ||
  !englishSite.includes('v0.1.0-beta.6') ||
  chineseSite.includes('/releases/latest') ||
  englishSite.includes('/releases/latest')
) {
  errors.push(
    'site: must explain the legacy latest release instead of linking it as the current Electron build',
  );
}

if (errors.length > 0) {
  process.stderr.write(`Public documentation validation failed (${errors.length}):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Public documentation validation passed: ${publicDocuments.length} bilingual technical pages.\n`,
  );
}
