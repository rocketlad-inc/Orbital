// ============================================================
// filmVideo — the whole-match film as a video file to post.
//
// The fight video's twin (recapVideo.ts) for the match film: a second,
// unseen copy of the film's own renderer is stepped frame by frame at a
// fixed 30 fps into a 1280x720 canvas, and MediaRecorder takes each frame
// as it is drawn (captureStream(0) + requestFrame). Frames are paced to
// the wall clock so the recorder's timestamps match the film's: a film of
// two minutes takes about two minutes to record.
//
// On a phone the file goes to the share sheet (post it straight to an
// app); elsewhere, or if the sheet cannot take files, it downloads.
// ============================================================

import { createMatchMap } from '../render/matchMap';
import { advanceClock } from '../render/filmReel';
import { forgetDrawnShips } from '../render/mapRenderer';
import { forgetBattleGlides } from '../render/battleLayoutLive';
import type { MatchSummary, SnapshotRow } from '../render/matchWorld';
import { pickMime } from './recapVideo';
import { downloadBlob } from './recapGif';

export const FILM_VIDEO_W = 1280;
export const FILM_VIDEO_H = 720;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
/** The result card held on screen once the film has run. */
const END_HOLD_MS = 3000;

export interface RecordFilmOptions {
  summary: MatchSummary;
  rows: SnapshotRow[];
  /** 0..1 as the film records. */
  onProgress?: (k: number) => void;
  /** Stop early (the result is then null). */
  signal?: AbortSignal;
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function recordFilmVideo(o: RecordFilmOptions): Promise<{ blob: Blob; ext: string } | null> {
  const mime = pickMime();
  if (!mime || o.summary.ticks.lo == null) return null;
  const cv = document.createElement('canvas');
  cv.width = FILM_VIDEO_W; cv.height = FILM_VIDEO_H;
  // A fresh start for the per-hull animation state the two stages share.
  forgetDrawnShips(); forgetBattleGlides();
  const stage = createMatchMap(o.summary, cv);
  stage.resize(FILM_VIDEO_W, FILM_VIDEO_H);
  stage.applyRows(o.rows);
  const lo = o.summary.ticks.lo ?? 0, hi = o.summary.ticks.hi ?? lo;

  const stream = (cv as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise<void>(r => { rec.onstop = () => r(); });

  // The film's length in frames, to report progress against.
  let filmS = 0;
  for (let t = lo; t <= hi; t++) filmS += stage.rateAt?.(t) ?? 0;
  const total = Math.max(1, Math.ceil((filmS * 1000 + END_HOLD_MS) / FRAME_MS));

  rec.start(1000);
  const t0 = performance.now();
  let pos = lo;
  let k = 0;
  const frame = (p: number) => {
    const tick = Math.floor(p);
    stage.setTick(tick, p - tick);
    stage.render(FRAME_MS);
    track.requestFrame?.();
  };
  try {
    for (; pos < hi; k++) {
      if (o.signal?.aborted) break;
      frame(pos);
      pos = advanceClock(t => stage.rateAt?.(t) ?? 1, pos, 1 / FPS, hi);
      o.onProgress?.(Math.min(1, k / total));
      const ahead = t0 + (k + 1) * FRAME_MS - performance.now();
      if (ahead > 0) await wait(ahead); else if (k % 8 === 0) await wait(0);
    }
    // Hold the result card.
    for (let h = 0; h < END_HOLD_MS / FRAME_MS && !o.signal?.aborted; h++, k++) {
      frame(hi);
      o.onProgress?.(Math.min(1, k / total));
      const ahead = t0 + (k + 1) * FRAME_MS - performance.now();
      if (ahead > 0) await wait(ahead);
    }
  } finally {
    rec.stop();
    await stopped;
    stage.dispose();
    forgetDrawnShips(); forgetBattleGlides();
  }
  if (o.signal?.aborted) return null;
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm' };
}

type FileShareNavigator = Navigator & { canShare?: (data: ShareData) => boolean };

/**
 * Hand the video on: the phone's share sheet with the file in it when it
 * can take one (post it straight to an app), else a download.
 */
export async function shareOrSaveVideo(blob: Blob, name: string, title: string, mobile: boolean): Promise<'shared' | 'saved' | 'cancelled'> {
  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as FileShareNavigator | undefined;
  if (mobile && nav && typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    try {
      const file = new File([blob], name, { type: blob.type });
      if (nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title });
          return 'shared';
        } catch (e) {
          if ((e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
        }
      }
    } catch { /* no File constructor: download */ }
  }
  downloadBlob(blob, name);
  return 'saved';
}
