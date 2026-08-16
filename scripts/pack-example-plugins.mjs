import { crc32 } from 'node:zlib';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = path.join(root, 'examples', 'plugins');
const outDir = path.join(pluginsRoot, 'packages');
const runtimeDirs = new Set(['styles', 'scenes', 'dist', 'assets']);

function dosDateTime(date) {
  const year = Math.max(date.getFullYear() - 1980, 0);
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

async function collectFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!prefix && !runtimeDirs.has(entry.name)) continue;
      files.push(...(await collectFiles(full, relative)));
      continue;
    }
    if (!prefix && entry.name !== 'manifest.json') continue;
    files.push({ name: relative.replaceAll('\\', '/'), bytes: await readFile(full) });
  }
  return files;
}

function zipStore(files) {
  const { dosTime, dosDate } = dosDateTime(new Date('2026-01-01T00:00:00Z'));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.bytes) >>> 0;
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(file.bytes.length),
      u32(file.bytes.length),
      u16(name.length),
      u16(0),
      name,
      file.bytes,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(file.bytes.length),
      u32(file.bytes.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, ...centrals, end]);
}

const pluginDirs = [
  'style-sakura',
  'style-night',
  'scene-pack',
  'script-now-playing',
  'script-actions',
  'script-network',
  'studio',
  'ink-core',
  'ink-accent',
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const directory of pluginDirs) {
  const source = path.join(pluginsRoot, directory);
  await stat(source);
  const files = await collectFiles(source);
  if (!files.some((file) => file.name === 'manifest.json')) {
    throw new Error(`${directory} is missing manifest.json`);
  }
  const manifest = JSON.parse(
    files.find((file) => file.name === 'manifest.json').bytes.toString('utf8'),
  );
  const filename = `${manifest.id}-${manifest.version}.yaqmc-plugin`;
  const archive = zipStore(files);
  await writeFile(path.join(outDir, filename), archive);
  process.stdout.write(`packed ${filename} (${files.length} files, ${archive.length} bytes)\n`);
}
