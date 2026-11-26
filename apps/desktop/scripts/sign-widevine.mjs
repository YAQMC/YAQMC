import { spawnSync } from 'node:child_process';
import { warn } from 'node:console';

/** Windows VMP signing runs after electron-builder finishes editing the executable. */
export function signWindowsWidevine(context, { env = process.env, run = spawnSync } = {}) {
  if (context.electronPlatformName !== 'win32') return;
  const python = env.YAQMC_WIDEVINE_PYTHON?.trim();
  if (!python) {
    warn(
      'Windows protected playback requires production VMP signing. Set YAQMC_WIDEVINE_PYTHON ' +
        'to a Python environment with castlabs-evs and an authenticated EVS account. ' +
        'The bundled development signature does not cover the packaged executable.',
    );
    return;
  }
  // EVS appends the platform extension to its name hint.
  const name = context.packager.appInfo.productFilename;
  for (const command of ['sign-pkg', 'verify-pkg']) {
    const result = run(
      python,
      ['-m', 'castlabs_evs.vmp', '--no-ask', command, '--name-hint', name, context.appOutDir],
      { env, stdio: 'inherit', windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Windows Widevine ${command} failed; the package is not ready for DRM playback.`,
      );
    }
  }
}

export default function afterSign(context) {
  signWindowsWidevine(context);
}
