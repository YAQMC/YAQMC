import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { signWindowsWidevine } from '../../apps/desktop/scripts/sign-widevine.mjs';

const context = {
  electronPlatformName: 'win32',
  appOutDir: 'C:/build with spaces/win-unpacked',
  packager: { appInfo: { productFilename: 'YAQMC' } },
};
const env = { YAQMC_WIDEVINE_PYTHON: 'C:/tools with spaces/python.exe' };

test('Windows VMP signs and verifies the renamed executable before archiving', () => {
  const calls = [];
  signWindowsWidevine(context, {
    env,
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 2);
  for (const [index, command] of ['sign-pkg', 'verify-pkg'].entries()) {
    assert.equal(calls[index].command, env.YAQMC_WIDEVINE_PYTHON);
    assert.deepEqual(calls[index].args, [
      '-m',
      'castlabs_evs.vmp',
      '--no-ask',
      command,
      '--name-hint',
      'YAQMC',
      context.appOutDir,
    ]);
    assert.equal(calls[index].options.shell, undefined);
  }
  const yaml = readFileSync(
    new URL('../../apps/desktop/electron-builder.yml', import.meta.url),
    'utf8',
  );
  assert.match(yaml, /^afterSign: scripts\/sign-widevine\.mjs$/m);
  assert.doesNotMatch(yaml, /^afterPack:.*sign-widevine/m);
});

test('a failed signing or verification step fails the package build', () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    assert.throws(
      () =>
        signWindowsWidevine(context, {
          env,
          run() {
            calls += 1;
            return { status: calls === failAt ? 1 : 0 };
          },
        }),
      /package is not ready for DRM playback/,
    );
    assert.equal(calls, failAt);
  }
});

test('Windows signing does not run on other platforms', () => {
  signWindowsWidevine(
    { ...context, electronPlatformName: 'linux' },
    {
      env,
      run() {
        assert.fail('Windows signing must not run');
      },
    },
  );
});
