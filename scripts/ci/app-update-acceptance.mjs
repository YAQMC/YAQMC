// Exercises real installer/portable replacement in an isolated application and profile.
// This never installs or starts the production YAQMC application.
import assert from 'node:assert/strict';
import console from 'node:console';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeAppUpdateMetadata } from './app-update-metadata.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRequire = createRequire(path.join(repository, 'apps/desktop/package.json'));
const { build } = desktopRequire('esbuild');
const root = path.join(
  repository,
  'output/app-updates',
  `packaged-${Date.now()}-${randomBytes(3).toString('hex')}`,
);
const project = path.join(root, 'project');
mkdirSync(project, { recursive: true });
const helper = process.env.YAQMC_UPDATE_HELPER_BIN;
if (!helper || !existsSync(helper))
  throw new Error('Set YAQMC_UPDATE_HELPER_BIN to the compiled native helper.');
const platform = process.platform === 'win32' ? 'windows' : 'linux';
const arch = process.arch;
const id = `org.yaqmc.updatetest.${randomBytes(6).toString('hex')}`;
const source = path.join(project, 'fixture.ts');
const modulePath = (name) =>
  JSON.stringify(path.join(repository, 'apps/desktop/main/services', name).replaceAll('\\', '/'));
writeFileSync(
  source,
  `
import {app,BrowserWindow} from 'electron';
import {NsisUpdater} from 'electron-updater';
import {readFileSync,writeFileSync,appendFileSync,createReadStream,statSync} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {createUpdater} from ${modulePath('updater.ts')};
import {createElectronUpdaterPort} from ${modulePath('electron-updater-port.ts')};
import {launchNativeUpdate,nativeUpdateHealth} from ${modulePath('native-update.ts')};
const root=process.env.YAQMC_APP_UPDATE_QA_ROOT||${JSON.stringify(path.join(root, 'nsis'))};
const kind=process.env.YAQMC_APP_UPDATE_QA_KIND||'nsis';
process.on('uncaughtException',error=>{writeFileSync(path.join(root,'error.txt'),String(error.stack));app.exit(1);});
app.setPath('userData',path.join(root,'userData'));
const stream=file=>new Response(Readable.toWeb(createReadStream(file)),{headers:{'content-length':String(statSync(file).size)}});
const target=kind==='portable'?process.env.PORTABLE_EXECUTABLE_FILE:process.env.APPIMAGE;
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await window.loadURL('data:text/html,<main>Updater QA</main>');
 const session=JSON.parse(readFileSync(path.join(root,'userData/session.json'),'utf8'));
 if(session.handle!=='synthetic-session-reference')throw new Error('session was lost');
 if(app.getVersion()==='2.0.0'){
   if(target)await nativeUpdateHealth(path.join(root,'updater'),app.getVersion(),false,target);
   if(target)await nativeUpdateHealth(path.join(root,'updater'),app.getVersion(),true,target);
   writeFileSync(path.join(root,'result.json'),JSON.stringify({version:app.getVersion(),session}));
   setTimeout(()=>app.quit(),1500);return;
 }
 const release=JSON.parse(readFileSync(path.join(root,'release.json'),'utf8'));
 const packageFile=path.join(root,'package');
 const fetcher=async url=>url.startsWith('https://api.github.com/')
   ? new Response(JSON.stringify(url.includes('?')?[release]:release)):stream(packageFile);
 const port=createElectronUpdaterPort({currentVersion:app.getVersion(),identity:{source:'official-release',tag:'v1.0.0',commit:'a'.repeat(40),architecture:process.arch,packageKind:kind},
   fetcher,directory:path.join(root,'downloads'),
   createNsis:()=>{const updater=new NsisUpdater();updater.netSession.protocol.handle('https',request=>{
     const name=path.basename(new URL(request.url).pathname);
     if(name===release.assets[0].name)return stream(packageFile);
     if(name==='updater-windows-'+process.arch+'.yml')return stream(path.join(root,name));
     return new Response('not found',{status:404});
   });return updater;},
   installNative:(candidate,file)=>launchNativeUpdate({root:path.join(root,'updater'),helper:path.join(process.resourcesPath,'updater',process.platform==='win32'?'yaqmc-update-helper.exe':'yaqmc-update-helper'),target,targetKind:kind,candidate,package:file,quit:()=>app.quit()})});
 const updater=createUpdater({port,channel:'latest',currentVersion:app.getVersion(),platform:process.platform,
   identity:{source:'official-release',tag:'v1.0.0',commit:'a'.repeat(40),architecture:process.arch,packageKind:kind},
   prepareInstall:async()=>{writeFileSync(path.join(root,'saved-queue.json'),'["synthetic-track"]');},
   emit:(_,payload)=>{appendFileSync(path.join(root,'events.log'),payload.state+'\\n');if(payload.state==='error'){writeFileSync(path.join(root,'error.txt'),payload.error||'unknown');app.quit();}}});
 await updater.check();
 const timer=setInterval(async()=>{if(updater.state()==='available'){clearInterval(timer);await updater.start(updater.payload().candidate.id);}},20);
});
`,
);
const product = 'YAQMC Update QA';
writeFileSync(
  path.join(project, 'package.json'),
  JSON.stringify({
    name: 'yaqmc-update-qa',
    productName: product,
    version: '1.0.0',
    type: 'module',
    main: 'main.js',
    description: 'Isolated updater acceptance fixture',
    author: 'YAQMC',
    dependencies: { 'electron-updater': '6.8.9', semver: '7.7.4' },
  }),
);
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: project,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
  });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}\n${result.stdout}`);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (process.platform === 'win32')
  run(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', [
    '/d',
    '/c',
    npm,
    'install',
    '--ignore-scripts',
    '--offline',
    '--workspaces=false',
  ]);
else run(npm, ['install', '--ignore-scripts', '--offline', '--workspaces=false']);
await build({
  entryPoints: [source],
  outfile: path.join(project, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron', 'electron-updater', 'semver', 'builder-util-runtime'],
  logLevel: 'warning',
});
const resources = path.join(project, 'updater');
mkdirSync(resources);
const helperName = path.basename(helper);
copyFileSync(helper, path.join(resources, helperName));
writeFileSync(
  path.join(resources, 'manifest.json'),
  JSON.stringify({
    name: helperName,
    sha256: createHash('sha256').update(readFileSync(helper)).digest('hex'),
    bytes: readFileSync(helper).length,
  }),
);
const base = {
  appId: id,
  productName: product,
  executableName: 'YAQMCUpdateQA',
  electronVersion: '43.8.3',
  electronDist: path.dirname(desktopRequire('electron')),
  asar: true,
  files: ['main.js', 'package.json'],
  extraResources: [{ from: 'updater', to: 'updater' }],
  publish: { provider: 'generic', url: 'https://github.com/YAQMC/YAQMC/releases/download/v2.0.0/' },
  win: { target: ['nsis', 'portable'], verifyUpdateCodeSignature: true },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'YAQMC-windows-' + arch + '-setup.exe',
  },
  portable: { unpackDirName: true, artifactName: 'YAQMC-windows-' + arch + '-portable.exe' },
  linux: {
    target: ['AppImage'],
    category: 'AudioVideo',
    artifactName: 'YAQMC-linux-' + arch + '.AppImage',
  },
};
for (const version of ['1.0.0', '2.0.0']) {
  const pkg = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
  pkg.version = version;
  writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg));
  const config = path.join(project, 'builder.json');
  writeFileSync(
    config,
    JSON.stringify({ ...base, directories: { output: path.join(root, version) } }),
  );
  const command = desktopRequire.resolve('electron-builder/cli.js');
  run(
    process.execPath,
    [
      command,
      '--projectDir',
      project,
      '--config',
      config,
      platform === 'windows' ? '--win' : '--linux',
      `--${arch}`,
      '--publish',
      'never',
    ],
    { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  );
  console.log('Built updater fixture', platform, arch, version);
}
const kinds = platform === 'windows' ? ['portable', 'nsis'] : ['AppImage'];
for (const kind of kinds) {
  const runRoot = path.join(root, kind);
  mkdirSync(path.join(runRoot, 'userData'), { recursive: true });
  writeFileSync(
    path.join(runRoot, 'userData/session.json'),
    JSON.stringify({ handle: 'synthetic-session-reference' }),
  );
  const name =
    kind === 'AppImage'
      ? `YAQMC-linux-${arch}.AppImage`
      : `YAQMC-windows-${arch}-${kind === 'nsis' ? 'setup' : 'portable'}.exe`;
  const candidate = path.join(root, '2.0.0', name);
  copyFileSync(candidate, path.join(runRoot, 'package'));
  const assets = [
    {
      id: 2,
      name,
      size: readFileSync(candidate).length,
      digest: 'sha256:' + createHash('sha256').update(readFileSync(candidate)).digest('hex'),
      browser_download_url: `https://github.com/YAQMC/YAQMC/releases/download/v2.0.0/${name}`,
    },
  ];
  if (kind === 'nsis') {
    copyFileSync(candidate, path.join(runRoot, name));
    writeAppUpdateMetadata(runRoot, '2.0.0', arch);
    assets.push({
      id: 3,
      name: `updater-windows-${arch}.yml`,
      browser_download_url: `https://github.com/YAQMC/YAQMC/releases/download/v2.0.0/updater-windows-${arch}.yml`,
    });
  }
  writeFileSync(
    path.join(runRoot, 'release.json'),
    JSON.stringify({
      id: 1,
      draft: false,
      prerelease: false,
      tag_name: 'v2.0.0',
      body: 'commits',
      assets,
    }),
  );
  const env = {
    ...process.env,
    YAQMC_APP_UPDATE_QA_ROOT: runRoot,
    YAQMC_APP_UPDATE_QA_KIND: kind,
    LOCALAPPDATA: path.join(runRoot, 'LocalAppData'),
    APPDATA: path.join(runRoot, 'AppData'),
    XDG_CACHE_HOME: path.join(runRoot, 'cache'),
  };
  let executable;
  const install = path.join(runRoot, 'installed');
  if (kind === 'nsis') {
    run(path.join(root, '1.0.0', name), ['/S', `/D=${install}`], env);
    executable = path.join(install, 'YAQMCUpdateQA.exe');
  } else {
    executable = path.join(
      runRoot,
      kind === 'portable' ? 'Custom YAQMC.exe' : 'Custom YAQMC.AppImage',
    );
    copyFileSync(path.join(root, '1.0.0', name), executable);
  }
  const child = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' });
  let error;
  child.once('error', (value) => {
    error = value;
  });
  try {
    const deadline = Date.now() + 120_000;
    while (!existsSync(path.join(runRoot, 'result.json'))) {
      if (error) throw error;
      if (existsSync(path.join(runRoot, 'error.txt')))
        throw new Error(readFileSync(path.join(runRoot, 'error.txt'), 'utf8'));
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for ${kind}: ${existsSync(path.join(runRoot, 'events.log')) ? readFileSync(path.join(runRoot, 'events.log'), 'utf8') : ''}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = JSON.parse(readFileSync(path.join(runRoot, 'result.json'), 'utf8'));
    assert.equal(result.version, '2.0.0');
    assert.equal(result.session.handle, 'synthetic-session-reference');
    assert.equal(
      readFileSync(path.join(runRoot, 'saved-queue.json'), 'utf8'),
      '["synthetic-track"]',
    );
    await new Promise((resolve) => setTimeout(resolve, 2200));
    if (kind !== 'nsis')
      assert.equal(
        createHash('sha256').update(readFileSync(executable)).digest('hex'),
        assets[0].digest.slice(7),
      );
    console.log('Passed packaged A→B:', kind, arch);
  } finally {
    child.kill();
    const uninstaller = path.join(install, `Uninstall ${product}.exe`);
    if (existsSync(uninstaller)) run(uninstaller, ['/S'], env);
  }
}
console.log('Isolated acceptance artifacts:', root);
