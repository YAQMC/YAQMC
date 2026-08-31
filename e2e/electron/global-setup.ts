import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function globalSetup(): void {
  execSync('npm run build:qa -w @yaqmc/desktop', { cwd: repoRoot, stdio: 'inherit' });
}
