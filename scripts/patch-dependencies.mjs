// Install-time patch for @applemusic-like-lyrics/core 0.5.2 (AGPL-3.0-only; this script is the
// modification's source). Runs from `postinstall`; idempotent; refuses unknown builds.
//
// Lyric lines that have never been the current line render in SOLID mode, where the bright and dark
// mask alphas are equal, so their per-word gradient masks and mask animations draw nothing a plain
// opacity cannot. AMLL builds both for every visible line on each lyrics open; in an Electron 43
// measurement that was ~48 MiB of the renderer's peak over four open/close cycles. Never-active lines
// now paint their words at the dark mask alpha; masks and animations are created on first enable().
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MARKER = '/* yaqmc-patch: amll-inactive-line-opacity */';
const VERSION = '0.5.2';

const REPLACEMENTS = [
  [
    '\tgenerateWebAnimationBasedMaskImage() {\n',
    `\tgenerateWebAnimationBasedMaskImage() {\n\t\t${MARKER}\n\t\tif (!this.isEnabled && !this.maskAnimated) {\n\t\t\tfor (const word of this.splittedWords) if (word.mainElement) word.mainElement.style.opacity = "var(--dark-mask-alpha, 1)";\n\t\t\treturn;\n\t\t}\n`,
  ],
  [
    '\tasync enable(maskAnimationTime = this.lyricPlayer.getCurrentTime(), shouldPlay = this.lyricPlayer.getIsPlaying()) {\n\t\tthis.isEnabled = true;\n',
    '\tasync enable(maskAnimationTime = this.lyricPlayer.getCurrentTime(), shouldPlay = this.lyricPlayer.getIsPlaying()) {\n\t\tthis.isEnabled = true;\n\t\tif (!this.maskAnimated && this.splittedWords.length > 0 && this.lyricPlayer.supportMaskImage) {\n\t\t\tthis.maskAnimated = true;\n\t\t\tfor (const word of this.splittedWords) if (word.mainElement) word.mainElement.style.opacity = "";\n\t\t\tthis.generateWebAnimationBasedMaskImage();\n\t\t}\n',
  ],
  ['\tdisposeElements() {\n', '\tdisposeElements() {\n\t\tthis.maskAnimated = false;\n'],
];

export function patchSource(source) {
  if (source.includes(MARKER)) return source;
  let patched = source;
  for (const [find, replace] of REPLACEMENTS) {
    const count = patched.split(find).length - 1;
    if (count !== 1)
      throw new Error(`AMLL patch anchor matched ${count} times: ${find.trim().slice(0, 60)}`);
    patched = patched.replace(find, () => replace);
  }
  return patched;
}

export function patchAmll(root) {
  const packageDir = path.join(root, 'node_modules', '@applemusic-like-lyrics', 'core');
  const manifest = path.join(packageDir, 'package.json');
  if (!existsSync(manifest)) return 'missing';
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (version !== VERSION) {
    // A different AMLL build needs its own review of this patch.
    process.stderr.write(
      `[patch-dependencies] @applemusic-like-lyrics/core ${version} is not ${VERSION}; not patched\n`,
    );
    return 'skipped';
  }
  for (const file of ['amll-core.mjs', 'amll-core.cjs']) {
    const target = path.join(packageDir, 'dist', file);
    const source = readFileSync(target, 'utf8');
    const patched = patchSource(source);
    if (patched !== source) writeFileSync(target, patched);
  }
  return 'patched';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.stdout.write(`[patch-dependencies] @applemusic-like-lyrics/core: ${patchAmll(root)}\n`);
}
