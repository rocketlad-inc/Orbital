// ============================================================
// Hand a text file to the player, on whatever they are holding.
//
// The Main Menu's "Download Log" did nothing in the Android app
// (playtester). It made a blob: URL and clicked an <a download>; inside
// the app -- a Trusted Web Activity, Chrome hosting us without a browser
// UI -- that click is not a reliable download, and there is no error to
// catch when it is dropped. So on the phone layout, in order:
//
//   1. The share sheet with the file (navigator.share + canShare
//      ({files})). Chrome on Android, the app included, shares text/plain
//      files: the player can send the log to Discord, mail, Drive, Files.
//   2. In a phone BROWSER, the old download (it works there).
//   3. In the app, or if sharing failed outright: the clipboard, so the
//      log can be pasted anywhere.
//
// Desktop is untouched: it downloads, exactly as before.
//
// Call it straight from the click handler, before any await: the share
// sheet needs the tap's user activation.
// ============================================================

export type SaveOutcome = 'shared' | 'downloaded' | 'copied' | 'cancelled' | 'failed';

export interface SaveTextOptions {
  /** The layout's verdict, useIsMobile(). Desktop just downloads. */
  mobile: boolean;
  /** Running as the installed app, where an <a download> is unreliable. */
  inApp: boolean;
  /** The existing download path (e.g. logger.downloadText). */
  download: () => void;
}

type ShareNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
};

export function saveTextFile(text: string, filename: string, opts: SaveTextOptions): Promise<SaveOutcome> {
  if (!opts.mobile) {
    opts.download();
    return Promise.resolve('downloaded');
  }

  const fallback = (): Promise<SaveOutcome> => {
    if (!opts.inApp) {
      try { opts.download(); return Promise.resolve('downloaded'); } catch { /* fall through to copy */ }
    }
    return copyText(text).then(ok => (ok ? 'copied' : 'failed'));
  };

  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as ShareNavigator | undefined;
  let file: File | null = null;
  try { file = new File([text], filename, { type: 'text/plain' }); } catch { file = null; }
  let canShareFile = false;
  try {
    canShareFile = !!file && typeof nav?.share === 'function' && typeof nav.canShare === 'function'
      && nav.canShare({ files: [file] });
  } catch { canShareFile = false; }

  if (canShareFile && nav && file) {
    let sharing: Promise<void>;
    try {
      sharing = nav.share({ files: [file], title: filename });
    } catch {
      return fallback();
    }
    return sharing.then(
      () => 'shared' as SaveOutcome,
      (err: unknown) => {
        // The player closed the sheet: that is an answer, not a failure.
        if ((err as { name?: string } | null)?.name === 'AbortError') return 'cancelled' as SaveOutcome;
        return fallback();
      },
    );
  }
  return fallback();
}

/** Clipboard API first; the old execCommand route if that is refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* try the legacy route */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}
