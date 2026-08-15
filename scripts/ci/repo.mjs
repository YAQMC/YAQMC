import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function gitSha() {
  return (
    process.env.GITHUB_SHA || process.env.VITE_GIT_COMMIT || process.env.YAQMC_BUILD_COMMIT || ''
  );
}
