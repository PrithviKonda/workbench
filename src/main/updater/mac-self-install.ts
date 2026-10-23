/**
 * Updates for Mac builds without a Developer ID signature
 *
 * electron-updater installs Mac updates through Squirrel.Mac, which only accepts an update signed
 * by the same Developer ID as the running app. The release builds are ad-hoc signed, so Squirrel
 * rejects every update. For those builds Workbench does the update itself: it downloads the
 * release's zip for this architecture, checks it against the sha512 in latest-mac.yml, unpacks it,
 * and once the app has quit a small script swaps the new bundle in and opens it.
 */
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { app, net } from 'electron';
import type { UpdateInfo } from 'electron-updater';
import { isMacOS } from '../platform';

const execFileAsync = promisify(execFile);

let unsignedCache: boolean | undefined;

/** The running .app bundle (…/Workbench.app) */
export function appBundlePath(): string {
  return path.resolve(app.getPath('exe'), '..', '..', '..');
}

/** Whether this is a packaged Mac build that Squirrel.Mac can't update (no Developer ID) */
export async function needsSelfInstall(): Promise<boolean> {
  if (!isMacOS() || !app.isPackaged) return false;
  if (unsignedCache !== undefined) return unsignedCache;
  try {
    // codesign prints the signature details on stderr
    const { stderr } = await execFileAsync('codesign', ['-dv', '--verbose=2', appBundlePath()]);
    unsignedCache = /Signature=adhoc|TeamIdentifier=not set/.test(stderr);
  } catch {
    // Not signed at all
    unsignedCache = true;
  }
  return unsignedCache;
}

/** The release's zip for this Mac's architecture */
export function pickMacZip(info: Pick<UpdateInfo, 'files'>, arch = process.arch): UpdateInfo['files'][number] | undefined {
  const zips = info.files.filter((file) => file.url.endsWith('.zip'));
  return zips.find((file) => file.url.includes(arch === 'arm64' ? 'arm64' : 'x64')) ?? (zips.length === 1 ? zips[0] : undefined);
}

/**
 * Download the update's zip (`baseUrl`: the release's download folder) into a temp folder,
 * reporting progress, and check its sha512. Returns the zip's path.
 */
export async function downloadMacZip(
  info: Pick<UpdateInfo, 'files' | 'version'>,
  baseUrl: string,
  onProgress: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void,
): Promise<string> {
  const file = pickMacZip(info);
  if (!file) throw new Error(`Release ${info.version} has no Mac download for ${process.arch}`);
  const url = /^https?:\/\//.test(file.url) ? file.url : `${baseUrl}/${encodeURIComponent(file.url)}`;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-update-'));
  const zipPath = path.join(dir, path.basename(file.url));

  const response = await net.fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
  const total = Number(response.headers.get('content-length')) || file.size || 0;
  const hash = createHash('sha512');
  const out = createWriteStream(zipPath);
  const started = Date.now();
  let transferred = 0;
  let lastReport = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      transferred += value.length;
      if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        const seconds = Math.max((now - started) / 1000, 0.001);
        onProgress({ percent: total ? (transferred / total) * 100 : 0, bytesPerSecond: transferred / seconds, transferred, total });
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  }
  onProgress({ percent: 100, bytesPerSecond: 0, transferred, total: total || transferred });

  if (file.sha512 && hash.digest('base64') !== file.sha512) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error('The downloaded update is damaged (checksum mismatch). Try again.');
  }
  return zipPath;
}

/** Shell-quote one value for /bin/sh */
const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Unpack the zip, then start a detached script that waits for this app to exit, replaces the
 * bundle, clears the download quarantine and opens the new version. The caller quits the app.
 */
export async function startMacSelfInstall(zipPath: string, target = appBundlePath()): Promise<void> {
  const dir = path.dirname(zipPath);
  const unpacked = path.join(dir, 'unpacked');
  await fsp.mkdir(unpacked, { recursive: true });
  // ditto keeps the bundle's symlinks, permissions and signature intact
  await execFileAsync('ditto', ['-x', '-k', zipPath, unpacked]);
  const bundle = (await fsp.readdir(unpacked)).find((name) => name.endsWith('.app'));
  if (!bundle) throw new Error('The update has no app inside');

  const script = path.join(dir, 'install.sh');
  await fsp.writeFile(script, [
    '#!/bin/sh',
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf ${sh(target)}`,
    `ditto ${sh(path.join(unpacked, bundle))} ${sh(target)} || exit 1`,
    `xattr -dr com.apple.quarantine ${sh(target)} 2>/dev/null`,
    `open ${sh(target)}`,
    `rm -rf ${sh(dir)}`,
    '',
  ].join('\n'), { mode: 0o755 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
}
