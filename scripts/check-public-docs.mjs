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
  'design-system.md',
  'deep-link.md',
  'diagnostics.md',
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
  'docs/README.md',
  'docs/zh-CN/README.md',
];

const errors = [];

const forbiddenPublicPlaceholders = [
  /\[PROJECT_NAME\]/u,
  /\$PROJECT_NAME_API_TOKEN/u,
  /GPT-Read-?me\.md/iu,
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

    let resolved = path.resolve(sourceDirectory, decodedTarget);
    if (!(await exists(resolved)) && relativePath.startsWith('wiki/') && !path.extname(resolved)) {
      resolved += '.md';
    }
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

const wikiFiles = [
  'wiki/Home.md',
  'wiki/_Sidebar.md',
  'wiki/安装与更新.md',
  'wiki/常见问题.md',
  'wiki/Linux-测试.md',
  'wiki/开发者入口.md',
  'wiki/English.md',
  'wiki/README.md',
];

for (const relativePath of [
  ...communityDocuments,
  ...publicDocuments.map((file) => `docs/${file}`),
  ...publicDocuments.map((file) => `docs/zh-CN/${file}`),
  ...wikiFiles,
]) {
  await requireFile(relativePath);
  if (await exists(path.join(repositoryRoot, relativePath))) {
    await checkMarkdownLinks(relativePath);
    const contents = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    for (const forbidden of forbiddenPublicPlaceholders) {
      if (forbidden.test(contents)) {
        errors.push(`${relativePath}: contains forbidden public placeholder ${forbidden}`);
      }
    }
  }
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

if (errors.length > 0) {
  process.stderr.write(`Public documentation validation failed (${errors.length}):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Public documentation validation passed: ${publicDocuments.length} bilingual technical pages.\n`,
  );
}
