import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ isMacOS: () => true }));
vi.mock('electron', () => ({ app: { getPath: () => '/Applications/Workbench.app/Contents/MacOS/Workbench', isPackaged: true }, net: {} }));

import { pickMacZip } from '../mac-self-install';

const files = [
  { url: 'Workbench-1.3.0-mac-x64.zip', sha512: 'a', size: 1 },
  { url: 'Workbench-1.3.0-mac-x64.dmg', sha512: 'b', size: 1 },
  { url: 'Workbench-1.3.0-mac-arm64.zip', sha512: 'c', size: 1 },
  { url: 'Workbench-1.3.0-mac-arm64.dmg', sha512: 'd', size: 1 },
];

describe('pickMacZip', () => {
  it("picks the zip for this Mac's architecture", () => {
    expect(pickMacZip({ files }, 'arm64')?.url).toBe('Workbench-1.3.0-mac-arm64.zip');
    expect(pickMacZip({ files }, 'x64')?.url).toBe('Workbench-1.3.0-mac-x64.zip');
  });

  it('takes the only zip when the release has one', () => {
    expect(pickMacZip({ files: [{ url: 'Workbench-1.3.0-mac.zip', sha512: 'e', size: 1 }] }, 'arm64')?.url).toBe('Workbench-1.3.0-mac.zip');
  });

  it('finds nothing without a zip', () => {
    expect(pickMacZip({ files: files.filter((file) => file.url.endsWith('.dmg')) }, 'arm64')).toBeUndefined();
  });
});
