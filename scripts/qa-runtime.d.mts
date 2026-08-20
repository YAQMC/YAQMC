export type QaSandboxPaths = {
  root: string;
  electronUserData: string;
  coreData: string;
  cache: string;
  plugins: string;
  logs: string;
  diagnostics: string;
  tmp: string;
  config: string;
  appData: string;
  localAppData: string;
  corePaths: {
    dataDir: string;
    cacheDir: string;
    logDir: string;
    configDir: string;
  };
};

export type CreateQaSandboxOptions = {
  tmpdir?: string;
  runId?: string;
  purpose?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
};

export function createQaSandbox(options?: CreateQaSandboxOptions): QaSandboxPaths;

export function qaElectronEnv(
  parentEnv: NodeJS.ProcessEnv,
  sandbox: QaSandboxPaths,
  extras?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function electronQaArgs(sandbox: QaSandboxPaths, extra?: readonly string[]): string[];
