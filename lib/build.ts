import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {minify} from "terser";
import { hash, spawn } from './utils';
import { hostArch, hostPlatform } from './system';
import { log } from './log';
import patchesJson from '../patches/patches.json';

const buildPath = path.resolve(
  process.env.PKG_BUILD_PATH ||
    path.join(os.tmpdir(), `pkg.${crypto.randomBytes(12).toString('hex')}`)
);
const nodePath = path.join(buildPath, 'node');
const patchesPath = path.resolve(__dirname, '../patches');
const nodeRepo = 'https://github.com/nodejs/node';

function getMajor(nodeVersion: string) {
  const [, version] = nodeVersion.match(/^v?(\d+)/) || ['', 0];
  return Number(version) | 0;
}

function getConfigureArgs(major: number, targetPlatform: string): string[] {
  const args: string[] = [];

  // first of all v8_inspector introduces the use
  // of `prime_rehash_policy` symbol that requires
  // GLIBCXX_3.4.18 on some systems
  // also we don't support any kind of debugging
  // against packaged apps, hence v8_inspector is useless
  args.push('--without-inspector');

  /*
  if (hostPlatform === 'alpine') {
    // Statically Link against libgcc and libstdc++ libraries. See vercel/pkg#555.
    // libgcc and libstdc++ grant GCC Runtime Library Exception of GPL
    args.push('--partly-static');
  }
   */

  if (targetPlatform === 'linuxstatic') {
    args.push('--fully-static');
  }

  // Link Time Optimization
  if (major >= 12) {
    if (hostPlatform !== 'win') {
      args.push('--enable-lto');
    }
  }

  // production binaries do NOT take NODE_OPTIONS from end-users
  args.push('--without-node-options');

  // DTrace
  args.push('--without-dtrace');
  args.push('--without-etw');

  // bundled npm package manager
  args.push('--without-npm');

  // No ICU
  args.push('--without-intl');

  args.push('--without-corepack');

  // New node v22
  args.push('--without-amaro');
  args.push('--without-sqlite');
  
  args.push('--experimental-enable-pointer-compression');
  args.push('--v8-disable-object-print');
  args.push('--v8-enable-snapshot-compression'); // see https://github.com/nodejs/node/commit/a996638e53c82a7c60589f88c6d7b517e9fd5505


  // Workaround for nodejs/node#39313
  // All supported macOS versions have zlib as a system library
  if (targetPlatform === 'macos') {
    args.push('--shared-zlib');
  }

  args.push('--tag');
  args.push('Valetudo');

  return args;
}

async function gitClone(nodeVersion: string) {
  log.info('Cloning Node.js repository from GitHub...');

  const args = [
    'clone',
    '-b',
    nodeVersion,
    '--depth',
    '1',
    '--single-branch',
    '--bare',
    '--progress',
    nodeRepo,
    'node/.git',
  ];

  await spawn('git', args, { cwd: buildPath, stdio: 'inherit' });
}

async function gitResetHard(nodeVersion: string) {
  log.info(`Checking out ${nodeVersion}`);

  const patches = patchesJson[nodeVersion as keyof typeof patchesJson] as
    | string[]
    | { commit?: string };

  const commit =
    'commit' in patches && patches.commit ? patches.commit : nodeVersion;
  const args = ['--work-tree', '.', 'reset', '--hard', commit];

  await spawn('git', args, { cwd: nodePath, stdio: 'inherit' });
}

async function applyPatches(nodeVersion: string) {
  log.info('Applying patches');

  const storedPatches = patchesJson[nodeVersion as keyof typeof patchesJson] as
    | string[]
    | { patches: string[] }
    | { sameAs: string };
  const storedPatch =
    'patches' in storedPatches ? storedPatches.patches : storedPatches;
  const patches =
    'sameAs' in storedPatch
      ? patchesJson[storedPatch.sameAs as keyof typeof patchesJson]
      : storedPatch;

  for (const patch of patches) {
    const patchPath = path.join(patchesPath, patch);
    const args = ['-p1', '-i', patchPath];
    await spawn('patch', args, { cwd: nodePath, stdio: 'inherit' });
  }
}

async function compileOnWindows(
  nodeVersion: string,
  targetArch: string,
  targetPlatform: string
) {
  const args = ['/c', 'vcbuild.bat', targetArch];
  const major = getMajor(nodeVersion);
  const config_flags = getConfigureArgs(major, targetPlatform);

  // Event Tracing for Windows
  args.push('noetw');

  // Performance counters on Windows
  if (major <= 10) {
    args.push('noperfctr');
  }

  // Link Time Code Generation
  if (major >= 12) {
    args.push('ltcg');
  }

  // Can't cross compile for arm64 with small-icu
  if (
    hostArch !== targetArch &&
    !config_flags.includes('--with-intl=full-icu')
  ) {
    config_flags.push('--without-intl');
  }

  await spawn('cmd', args, {
    cwd: nodePath,
    env: { ...process.env, config_flags: config_flags.join(' ') },
    stdio: 'inherit',
  });

  if (major <= 10) {
    return path.join(nodePath, 'Release/node.exe');
  }

  return path.join(nodePath, 'out/Release/node.exe');
}

const { MAKE_JOB_COUNT = os.cpus().length } = process.env;

async function compileOnUnix(
  nodeVersion: string,
  targetArch: string,
  targetPlatform: string
) {
  const args = [];
  const cpu = {
    x86: 'ia32',
    x64: 'x64',
    armv6: 'arm',
    armv7: 'arm',
    arm64: 'arm64',
    ppc64: 'ppc64',
    s390x: 's390x',
  }[targetArch];

  if (cpu) {
    args.push('--dest-cpu', cpu);
  }

  const { CFLAGS = '', CXXFLAGS = '' } = process.env;
  process.env.CFLAGS = `${CFLAGS} -Os -ffunction-sections -fdata-sections -flto`;
  process.env.CXXFLAGS = `${CXXFLAGS} -Os -ffunction-sections -fdata-sections -flto`;

  if (targetArch === 'armv7') {
    process.env.CFLAGS = `${process.env.CFLAGS} -marm -mcpu=cortex-a7 -mfpu=vfpv3`;
    process.env.CXXFLAGS = `${process.env.CXXFLAGS} -marm -mcpu=cortex-a7 -mfpu=vfpv3`;

    args.push('--with-arm-float-abi=hard');
    args.push('--with-arm-fpu=vfpv3');
  }

  if (hostArch !== targetArch) {
    log.warn('Cross compiling!');
    log.warn('You are responsible for appropriate env like CC, CC_host, etc.');
    args.push('--cross-compiling');
  }

  args.push(...getConfigureArgs(getMajor(nodeVersion), targetPlatform));

  // TODO same for windows?
  await spawn('./configure', args, { cwd: nodePath, stdio: 'inherit' });

  await spawn(
    hostPlatform === 'freebsd' ? 'gmake' : 'make',
    ['-j', String(MAKE_JOB_COUNT)],
    {
      cwd: nodePath,
      stdio: 'inherit',
    }
  );

  const output = path.join(nodePath, 'out/Release/node');

  await spawn(
    process.env.STRIP || 'strip',
    // global symbols are required for native bindings on macOS
    [...(targetPlatform === 'macos' ? ['-x'] : []), output],
    {
      stdio: 'inherit',
    }
  );

  if (targetPlatform === 'macos') {
    // Newer versions of Apple Clang automatically ad-hoc sign the compiled executable.
    // However, for final executable to be signable, base binary MUST NOT have an existing signature.
    await spawn('codesign', ['--remove-signature', output], {
      stdio: 'inherit',
    });
  }

  return output;
}

async function findJsFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const list = await fs.readdir(dir);
    for (const file of list) {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath);
        if (stat && stat.isDirectory()) {
            results.push(...(await findJsFiles(filePath)));
        } else if (filePath.endsWith('.js')) {
            results.push(filePath);
        }
    }
    return results;
}

function formatBytes(bytes: number, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    // eslint-disable-next-line no-restricted-properties
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))  } ${  sizes[i]}`;
}

async function minifyInternalJS() {
    log.info('Minifying internal JavaScript sources with Terser...');

    const targets = [
        {
            path: path.join('deps', 'undici', 'src'),
            terserOptions: { mangle: true, compress: true },
        },
        {
            path: path.join('deps', 'acorn', 'acorn', 'dist'),
            terserOptions: { mangle: true, compress: true },
        },
        {
            path: path.join('deps', 'minimatch'),
            terserOptions: { mangle: true, compress: true },
        },
        /*
        {
            path: path.join('lib'),
            // CRITICAL: For Node's core library, we use a much safer config.
            // We disable mangling and property compression to avoid breaking internals.
            terserOptions: {
                mangle: false,
                compress: {
                    properties: false,
                },
            },
        }, */
    ];

    let totalSizeBefore = 0;
    let totalSizeAfter = 0;

    for (const target of targets) {
        const targetPath = path.join(nodePath, target.path);
        if (!(await fs.pathExists(targetPath))) {
            log.warn(`Path not found, skipping minification for: ${target.path}`);
            continue;
        }

        const jsFiles = await findJsFiles(targetPath);
        if (jsFiles.length === 0) continue;

        const statsBefore = await Promise.all(jsFiles.map(file => fs.stat(file)));
        const sizeBefore = statsBefore.reduce((sum, stat) => sum + stat.size, 0);
        totalSizeBefore += sizeBefore;

        const minifyPromises = jsFiles.map(async (file) => {
            try {
                const code = await fs.readFile(file, 'utf8');
                // Apply the specific options for this target
                const result = await minify(code, target.terserOptions);
                if (result.code) {
                    await fs.writeFile(file, result.code, 'utf8');
                }
            } catch (err) {
                log.error(`Failed to minify ${file}:`, err);
                throw err;
            }
        });
        await Promise.all(minifyPromises);

        const statsAfter = await Promise.all(jsFiles.map(file => fs.stat(file)));
        const sizeAfter = statsAfter.reduce((sum, stat) => sum + stat.size, 0);
        totalSizeAfter += sizeAfter;

        log.info(`Minified ${target.path}: ${formatBytes(sizeBefore)} -> ${formatBytes(sizeAfter)}`);
    }

    // Log the final summary report
    if (totalSizeBefore > 0) {
        const reduction = ((totalSizeBefore - totalSizeAfter) / totalSizeBefore) * 100;
        log.info(
            `Total minification complete. ` +
            `Before: ${formatBytes(totalSizeBefore)}, ` +
            `After: ${formatBytes(totalSizeAfter)} ` +
            `(Reduced by ${reduction.toFixed(1)}%)`
        );
    }
}

async function nullWasmFiles() {
    log.info('Nulling wasm files');

    const wasmFilesToNeuter = [
        'deps/cjs-module-lexer/src/lib/lexer.wasm',
        'deps/undici/src/lib/llhttp/llhttp.wasm',
        'deps/undici/src/lib/llhttp/llhttp_simd.wasm',
    ];
    
    const nullByte = Buffer.from([0]);

    for (const relativePath of wasmFilesToNeuter) {
        const fullPath = path.join(nodePath, relativePath);
        if (await fs.pathExists(fullPath)) {
            try {
                await fs.writeFile(fullPath, nullByte);
                log.info(`Overwrote: ${relativePath}`);
            } catch (err) {
                log.error(`Failed to overwrite ${relativePath}:`, err);
                throw err;
            }
        }
    }
}




async function compile(
  nodeVersion: string,
  targetArch: string,
  targetPlatform: string
) {
  log.info('Compiling Node.js from sources...');
  const win = hostPlatform === 'win';

  if (win) {
    return compileOnWindows(nodeVersion, targetArch, targetPlatform);
  }

  return compileOnUnix(nodeVersion, targetArch, targetPlatform);
}

export default async function build(
  nodeVersion: string,
  targetArch: string,
  targetPlatform: string,
  local: string
) {
  await fs.remove(buildPath);
  await fs.mkdirp(buildPath);

  await gitClone(nodeVersion);
  await gitResetHard(nodeVersion);
  await applyPatches(nodeVersion);

  await nullWasmFiles();
  await minifyInternalJS();

  const output = await compile(nodeVersion, targetArch, targetPlatform);
  const outputHash = await hash(output);

  await fs.mkdirp(path.dirname(local));
  await fs.copy(output, local);
  await fs.promises.writeFile(
    `${local}.sha256sum`,
    `${outputHash}  ${path.basename(local)}
`
  );
  await fs.remove(buildPath);
}
