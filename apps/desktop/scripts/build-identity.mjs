import { createRequire } from 'node:module';
const { valid } = createRequire(import.meta.url)('semver');

export function officialBuildIdentity(env, version) {
  const tag = env.GITHUB_REF_NAME ?? '';
  const official =
    env.GITHUB_ACTIONS === 'true' &&
    env.GITHUB_REPOSITORY === 'YAQMC/YAQMC' &&
    env.GITHUB_WORKFLOW === 'YAQMC release' &&
    ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) &&
    env.GITHUB_REF_TYPE === 'tag' &&
    tag === `v${version}` &&
    valid(version) === version.split('+')[0];
  return {
    source: official ? 'official-release' : 'source',
    tag: official ? tag : '',
    architecture: env.YAQMC_PACKAGE_ARCH ?? process.arch,
  };
}
