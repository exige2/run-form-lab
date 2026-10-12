// MediaPipe Pose Landmarker による骨格推定（すべてブラウザ内で実行。動画はどこにも送信しない）

const TASKS_VERSION = '1.1.0';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/+esm`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
// モデルは自前ホスト（/models/）を優先し、無ければ Google の配布元から読み込む
export const MODEL_VARIANTS = {
  lite: '軽量（速い）',
  full: '標準（おすすめ）',
  heavy: '高精度（遅い）',
};
const modelUrls = (v) => [
  `models/pose_landmarker_${v}.task`,
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task`,
];

let cache = { variant: null, landmarker: null };

async function firstReachable(urls) {
  for (const u of urls) {
    try {
      const res = await fetch(u, { method: 'HEAD' });
      if (res.ok) return u;
    } catch { /* 次の候補へ */ }
  }
  return urls.at(-1);
}

export async function getLandmarker(variant = 'full') {
  if (cache.landmarker && cache.variant === variant) return cache.landmarker;
  cache.landmarker?.close?.();
  const vision = await import(TASKS_URL);
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
  const modelAssetPath = await firstReachable(modelUrls(variant));
  const make = (delegate) => vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let landmarker;
  try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
  cache = { variant, landmarker };
  return landmarker;
}

function seek(video, t) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const done = () => {
      // seeked 直後はフレームが未描画のことがあるため、描画を待つ（来ない環境もあるので時間切れで進む）
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(finish);
      else requestAnimationFrame(finish);
      setTimeout(finish, 120);
    };
    video.addEventListener('seeked', done, { once: true });
    setTimeout(finish, 3000); // seeked が発火しない場合の保険
    video.currentTime = t;
  });
}

// 指定区間を一定間隔でシークしながら骨格推定する（再生速度に依存せず再現性がある）
export async function processVideo(video, { start = 0, end, fps = 30, variant = 'full', onProgress, signal } = {}) {
  const landmarker = await getLandmarker(variant);
  const W = video.videoWidth, H = video.videoHeight;
  const stop = Math.min(end ?? video.duration, video.duration - 0.01);
  const frames = [];
  const wasPaused = video.paused;
  video.pause();
  const n = Math.max(1, Math.floor((stop - start) * fps));
  let lastTs = -1;
  for (let k = 0; k <= n; k++) {
    if (signal?.aborted) throw new DOMException('中止しました', 'AbortError');
    const t = start + k / fps;
    await seek(video, t);
    let ts = Math.round(t * 1000);
    if (ts <= lastTs) ts = lastTs + 1; // VIDEO モードはタイムスタンプが単調増加である必要がある
    lastTs = ts;
    const res = landmarker.detectForVideo(video, ts);
    const pose = res.landmarks?.[0];
    frames.push({
      t,
      lm: pose ? pose.map((p) => ({ x: p.x * W, y: p.y * H, visibility: p.visibility ?? 1 })) : null,
    });
    onProgress?.((k + 1) / (n + 1));
  }
  if (!wasPaused) video.play();
  return frames;
}

export { seek };
