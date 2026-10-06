// ============================================================
// Main Menu "Download Log" did nothing in the Android app (playtester):
// an <a download> click inside the Trusted Web Activity is dropped
// silently. On the phone layout the log goes to the share sheet, else a
// browser download, else (in the app) the clipboard. Desktop downloads.
// ============================================================

import { saveTextFile } from '../saveTextFile';

type Nav = Navigator & { share?: unknown; canShare?: unknown; clipboard?: unknown };
const nav = navigator as Nav;

function setNav(p: { share?: (d: ShareData) => Promise<void>; canShare?: (d: ShareData) => boolean; writeText?: (t: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'share', { configurable: true, value: p.share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: p.canShare });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: p.writeText ? { writeText: p.writeText } : undefined,
  });
}

afterEach(() => setNav({}));

describe('saveTextFile', () => {
  it('desktop: the old download, and nothing else is touched', async () => {
    const share = jest.fn(() => Promise.resolve());
    setNav({ share, canShare: () => true });
    const download = jest.fn();
    expect(await saveTextFile('log', 'a.txt', { mobile: false, inApp: false, download })).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(1);
    expect(share).not.toHaveBeenCalled();
  });

  it('phone with file sharing: the share sheet gets the file, called synchronously', async () => {
    const share = jest.fn((_d: ShareData) => Promise.resolve());
    setNav({ share, canShare: (d) => !!d.files?.length });
    const download = jest.fn();
    const p = saveTextFile('the log', 'orbital-log.txt', { mobile: true, inApp: true, download });
    // Before any await: user activation is only good inside the tap.
    expect(share).toHaveBeenCalledTimes(1);
    expect(await p).toBe('shared');
    const files = share.mock.calls[0][0].files!;
    expect(files[0].name).toBe('orbital-log.txt');
    expect(files[0].type).toBe('text/plain');
    expect(download).not.toHaveBeenCalled();
  });

  it('closing the share sheet is not a failure and copies nothing', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    setNav({
      share: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })),
      canShare: () => true,
      writeText,
    });
    expect(await saveTextFile('t', 'a.txt', { mobile: true, inApp: true, download: jest.fn() })).toBe('cancelled');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('in the app without file sharing: the clipboard, never the dead download', async () => {
    const writeText = jest.fn((_t: string) => Promise.resolve());
    setNav({ writeText });
    const download = jest.fn();
    expect(await saveTextFile('the log', 'a.txt', { mobile: true, inApp: true, download })).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('the log');
    expect(download).not.toHaveBeenCalled();
  });

  it('in the app, a share that errors falls back to the clipboard', async () => {
    const writeText = jest.fn((_t: string) => Promise.resolve());
    setNav({ share: () => Promise.reject(new Error('NotAllowedError')), canShare: () => true, writeText });
    expect(await saveTextFile('x', 'a.txt', { mobile: true, inApp: true, download: jest.fn() })).toBe('copied');
  });

  it('a phone browser without file sharing downloads as before', async () => {
    setNav({ share: () => Promise.resolve(), canShare: () => false });
    const download = jest.fn();
    expect(await saveTextFile('x', 'a.txt', { mobile: true, inApp: false, download })).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('reports failure when nothing can take the text', async () => {
    setNav({ writeText: () => Promise.reject(new Error('denied')) });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    expect(await saveTextFile('x', 'a.txt', { mobile: true, inApp: true, download: jest.fn() })).toBe('failed');
    expect(nav.share).toBeUndefined();
  });
});
