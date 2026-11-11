import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { Script } from 'node:vm';

// ZIP STORE archive using Node's standard library. Ship runtime files and their license.
const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (
  !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id) ||
  !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)
)
  throw new Error('Use a reverse-DNS plugin id and a SemVer version');
if (
  manifest.manifestVersion !== 1 ||
  manifest.apiVersion !== 4 ||
  manifest.entrypoints?.script !== 'main.js'
)
  throw new Error('This starter requires manifest v1, API v4 and main.js');
const source = await readFile(path.join(root, 'main.js'));
new Script(source.toString('utf8'), { filename: 'main.js' });
const files = [
  { name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  { name: 'main.js', bytes: source },
  { name: 'LICENSE', bytes: await readFile(path.join(root, 'LICENSE')) },
];
const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name);
  const crc = crc32(file.bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); // 1980-01-01, deterministic timestamp
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(file.bytes.length, 18);
  local.writeUInt32LE(file.bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, file.bytes);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(file.bytes.length, 20);
  central.writeUInt32LE(file.bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + file.bytes.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const output = path.join(root, 'dist', `${manifest.id}-${manifest.version}.yaqmc-plugin`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([...locals, directory, end]));
process.stdout.write(`Packed ${output}\n`);
