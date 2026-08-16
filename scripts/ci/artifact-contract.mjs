import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = {
  windows: new Set(['x86_64', 'i686', 'aarch64']),
  linux: new Set(['x86_64', 'aarch64']),
};

const CONTRACT = [
  [
    'ci-windows-nsis',
    'stage-artifacts.mjs',
    'Windows',
    'NSIS installer',
    'YAQMC-{version}-windows-{arch}-{shortSha}-nsis-setup.exe',
  ],
  [
    'ci-windows-msi',
    'stage-artifacts.mjs',
    'Windows',
    'MSI installer',
    'YAQMC-{version}-windows-{arch}-{shortSha}-msi.msi',
  ],
  [
    'ci-windows-portable',
    'stage-artifacts.mjs',
    'Windows',
    'Portable archive',
    'YAQMC-{version}-windows-{arch}-{shortSha}-portable.zip',
  ],
  [
    'ci-linux-appimage',
    'stage-artifacts.mjs',
    'Linux',
    'AppImage',
    'YAQMC-{version}-linux-{arch}-{shortSha}.AppImage',
  ],
  [
    'ci-linux-deb',
    'stage-artifacts.mjs',
    'Linux',
    'deb',
    'YAQMC-{version}-linux-{arch}-{shortSha}.deb',
  ],
  [
    'ci-linux-rpm',
    'stage-artifacts.mjs',
    'Linux',
    'rpm',
    'YAQMC-{version}-linux-{arch}-{shortSha}.rpm',
  ],
  [
    'ci-linux-binary',
    'stage-artifacts.mjs',
    'Linux',
    'Binary archive',
    'YAQMC-{version}-linux-{arch}-{shortSha}-binary.tar.gz',
  ],
  ['ci-linux-readme', 'stage-artifacts.mjs', 'Linux', 'Binary archive readme', 'README-binary.txt'],
  ['ci-build-info', 'stage-artifacts.mjs', 'Windows/Linux', 'Build metadata', 'build-info.json'],
  [
    'ci-checksum',
    'stage-artifacts.mjs',
    'Windows/Linux',
    'Checksums',
    'SHA256SUMS-{os}-{arch}.txt',
  ],
  [
    'release-windows-nsis',
    'build.yml',
    'Windows',
    'NSIS installer',
    'YAQMC-windows-{arch}-{tauri-bundle-filename}',
  ],
  [
    'release-windows-msi',
    'build.yml',
    'Windows',
    'MSI installer',
    'YAQMC-windows-{arch}-{tauri-bundle-filename}',
  ],
  [
    'release-windows-portable',
    'build.yml',
    'Windows',
    'Portable archive',
    'YAQMC-windows-{arch}-portable.zip',
  ],
  [
    'release-windows-checksum',
    'build.yml',
    'Windows',
    'Checksums',
    'SHA256SUMS-windows-{arch}.txt',
  ],
  ['release-linux-appimage', 'build.yml', 'Linux', 'AppImage', '{tauri-bundle-filename}'],
  ['release-linux-deb', 'build.yml', 'Linux', 'deb', '{tauri-bundle-filename}'],
  ['release-linux-rpm', 'build.yml', 'Linux', 'rpm', '{tauri-bundle-filename}'],
  [
    'release-linux-portable',
    'build.yml',
    'Linux',
    'Portable archive',
    'YAQMC-linux-{arch}-portable.tar.gz',
  ],
  [
    'release-linux-tester',
    'build.yml',
    'Linux x86_64',
    'Tester archive',
    'YAQMC-linux-x86_64-tester.tar.gz',
  ],
  ['release-linux-checksum', 'build.yml', 'Linux', 'Checksums', 'SHA256SUMS-linux-{arch}.txt'],
].map(([id, source, platform, kind, pattern]) =>
  Object.freeze({ id, source, platform, kind, pattern }),
);

const BY_ID = new Map(CONTRACT.map((entry) => [entry.id, entry]));

function requireTarget(platform, arch) {
  if (!TARGETS[platform]?.has(arch)) {
    throw new Error(`unsupported artifact target: ${platform}/${arch}`);
  }
}

function expand(id, values) {
  const contract = BY_ID.get(id);
  if (!contract) throw new Error(`unknown artifact contract id: ${id}`);
  return contract.pattern.replace(/\{([^}]+)\}/g, (placeholder, name) => {
    const value = values[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${id} requires ${placeholder}`);
    }
    return value;
  });
}

export function artifactContractEntries() {
  return CONTRACT.map((entry) => ({ ...entry }));
}

export function ciArtifactNames({ platform, arch, version, shortSha }) {
  requireTarget(platform, arch);
  const values = { version, os: platform, arch, shortSha };
  const common = {
    releaseDirectory: `YAQMC-${platform}-${arch}`,
  };
  if (platform === 'windows') {
    return {
      ...common,
      nsis: expand('ci-windows-nsis', values),
      msi: expand('ci-windows-msi', values),
      portable: expand('ci-windows-portable', values),
      buildInfo: expand('ci-build-info', values),
      checksum: expand('ci-checksum', values),
    };
  }
  return {
    ...common,
    appImage: expand('ci-linux-appimage', values),
    deb: expand('ci-linux-deb', values),
    rpm: expand('ci-linux-rpm', values),
    binary: expand('ci-linux-binary', values),
    readme: expand('ci-linux-readme', values),
    buildInfo: expand('ci-build-info', values),
    checksum: expand('ci-checksum', values),
  };
}

export function taggedArtifactNames({ platform, arch, bundleFilenames = [] }) {
  requireTarget(platform, arch);
  const values = { arch };
  if (platform === 'windows') {
    const packages = bundleFilenames.map((filename) =>
      expand(
        filename.toLowerCase().endsWith('.msi') ? 'release-windows-msi' : 'release-windows-nsis',
        {
          ...values,
          'tauri-bundle-filename': filename,
        },
      ),
    );
    return {
      releaseDirectory: `YAQMC-windows-${arch}`,
      packages,
      portable: expand('release-windows-portable', values),
      checksum: expand('release-windows-checksum', values),
    };
  }
  const result = {
    releaseDirectory: `YAQMC-linux-${arch}`,
    packages: [...bundleFilenames],
    portable: expand('release-linux-portable', values),
  };
  if (arch === 'x86_64') result.tester = expand('release-linux-tester', values);
  result.checksum = expand('release-linux-checksum', values);
  return result;
}

export function taggedWorkflowOutputs({ platform, arch }) {
  const names = taggedArtifactNames({ platform, arch });
  return {
    releaseDirectory: names.releaseDirectory,
    portable: names.portable,
    checksum: names.checksum,
    bundlePrefix: platform === 'windows' ? `YAQMC-windows-${arch}-` : '',
    tester: names.tester ?? '',
  };
}

function requireFiles(filenames, predicate, label) {
  const matches = filenames.filter(predicate);
  if (matches.length === 0) throw new Error(`tagged artifact directory is missing ${label}`);
  return matches;
}

export function verifyTaggedArtifactDirectory({ platform, arch, directory }) {
  requireTarget(platform, arch);
  const names = taggedArtifactNames({ platform, arch });
  const filenames = readdirSync(directory);
  const expectedFixed = [names.portable, ...(names.tester ? [names.tester] : [])];
  for (const filename of expectedFixed) {
    if (!filenames.includes(filename)) {
      throw new Error(`tagged artifact directory is missing ${filename}`);
    }
  }

  let packages;
  if (platform === 'windows') {
    const prefix = `YAQMC-windows-${arch}-`;
    packages = [
      ...requireFiles(
        filenames,
        (filename) => filename.startsWith(prefix) && filename.endsWith('.exe'),
        'NSIS installer',
      ),
      ...requireFiles(
        filenames,
        (filename) => filename.startsWith(prefix) && filename.endsWith('.msi'),
        'MSI installer',
      ),
    ];
  } else {
    packages = [
      ...requireFiles(filenames, (filename) => filename.endsWith('.AppImage'), 'AppImage'),
      ...requireFiles(filenames, (filename) => filename.endsWith('.deb'), 'deb package'),
      ...requireFiles(filenames, (filename) => filename.endsWith('.rpm'), 'rpm package'),
    ];
  }

  const artifacts = [...new Set([...packages, ...expectedFixed])];
  for (const filename of artifacts) {
    if (statSync(path.join(directory, filename)).size === 0) {
      throw new Error(
        `tagged ${filename === names.portable ? 'portable artifact' : 'artifact'} is empty: ${filename}`,
      );
    }
  }
  if (!filenames.includes(names.checksum)) {
    throw new Error(`tagged artifact directory is missing ${names.checksum}`);
  }
  const covered = new Set(
    readFileSync(path.join(directory, names.checksum), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => /^[0-9a-f]{64}\s+\*?(.+)$/i.exec(line)?.[1])
      .filter(Boolean),
  );
  for (const filename of filenames.filter((entry) => entry !== names.checksum)) {
    if (!covered.has(filename)) throw new Error(`checksum does not cover ${filename}`);
  }
  for (const filename of covered) {
    if (!filenames.includes(filename))
      throw new Error(`checksum names missing artifact ${filename}`);
  }
  return { platform, arch, directory };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid artifact-contract argument: ${option ?? '(missing)'}`);
    }
    result[option.slice(2)] = value;
  }
  return result;
}

function invokedDirectly() {
  return (
    Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (invokedDirectly()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode !== 'tagged') throw new Error('artifact-contract --mode must be tagged');
    const output = taggedWorkflowOutputs({ platform: options.platform, arch: options.arch });
    if (options['verify-directory']) {
      verifyTaggedArtifactDirectory({
        platform: options.platform,
        arch: options.arch,
        directory: options['verify-directory'],
      });
    }
    const text = `${Object.entries(output)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
    else process.stdout.write(text);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
