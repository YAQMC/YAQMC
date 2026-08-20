import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './repo.mjs';
import {
  ELECTRON_COMBINED_CHECKSUMS_NAME,
  ELECTRON_RELEASE_NOTES,
  ELECTRON_RELEASE_NOTES_NAME,
  assembleElectronRelease,
  electronDraftTag,
} from './assemble-electron-release.mjs';

const WORKFLOW = path.join(repositoryRoot, '.github', 'workflows', 'electron-release.yml');

test('tagged builds publish against the existing version tag', () => {
  assert.equal(electronDraftTag({ eventName: 'push', refName: 'v0.1.0' }), 'v0.1.0');
  assert.equal(
    electronDraftTag({ eventName: 'workflow_dispatch', refName: 'main', runId: '99' }),
    'electron-draft-99',
  );
  assert.equal(electronDraftTag({ eventName: 'push', refName: 'v1.2.3' }), 'v1.2.3');
});

test('assembles installers, x64 updater feeds, and combined checksums', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-electron-release-'));
  const win = path.join(root, 'YAQMC-electron-windows-x64-deadbeef');
  const linux = path.join(root, 'YAQMC-electron-linux-x64-deadbeef');
  mkdirSync(win, { recursive: true });
  mkdirSync(linux, { recursive: true });
  writeFileSync(path.join(win, 'YAQMC-windows-x64-setup.exe'), 'nsis');
  writeFileSync(
    path.join(win, 'latest.yml'),
    'version: 0.1.0\npath: YAQMC-windows-x64-setup.exe\n',
  );
  writeFileSync(path.join(linux, 'YAQMC-linux-x64.AppImage'), 'appimage');
  writeFileSync(
    path.join(linux, 'latest-linux.yml'),
    'version: 0.1.0\npath: YAQMC-linux-x64.AppImage\n',
  );
  const dest = path.join(root, 'assembled');
  const result = assembleElectronRelease({ sourceDir: root, destDir: dest });
  assert.equal(result.hasWindowsFeed, true);
  assert.equal(result.hasLinuxFeed, true);
  assert.equal(readFileSync(path.join(dest, 'YAQMC-windows-x64-setup.exe'), 'utf8'), 'nsis');
  assert.match(readFileSync(path.join(dest, 'latest.yml'), 'utf8'), /YAQMC-windows-x64-setup\.exe/);
  assert.match(readFileSync(path.join(dest, 'latest-linux.yml'), 'utf8'), /AppImage/);
  assert.match(
    readFileSync(path.join(dest, ELECTRON_COMBINED_CHECKSUMS_NAME), 'utf8'),
    /YAQMC-windows-x64-setup\.exe/,
  );
  assert.equal(
    readFileSync(path.join(dest, ELECTRON_RELEASE_NOTES_NAME), 'utf8'),
    ELECTRON_RELEASE_NOTES,
  );
  assert.match(ELECTRON_RELEASE_NOTES, /unsigned/i);
  assert.match(ELECTRON_RELEASE_NOTES, /i686/);
  assert.match(ELECTRON_RELEASE_NOTES, /WebKitGTK/);
  assert.match(ELECTRON_RELEASE_NOTES, /org\.yaqmc\.desktop/);
  assert.match(ELECTRON_RELEASE_NOTES, /BLOCKED/);
});

test('Electron release workflow is the sole tagged desktop release workflow', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^name: Electron release/m);
  assert.match(workflow, /tags:\s*\n\s+-\s+'v\*'/);
  assert.match(workflow, /node scripts\/ci\/package-electron\.mjs/);
  assert.match(workflow, /node scripts\/ci\/assemble-electron-release\.mjs/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--draft/);
  assert.doesNotMatch(workflow, /autoDownload:\s*true/);
  assert.doesNotMatch(workflow, /--publish always/);
});
