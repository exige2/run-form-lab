import { loadFitFile, summarizeWindow } from './fit.js';
import { processVideo, seek, MODEL_VARIANTS } from './pose.js';
import { analyzeFrames, CONNECTIONS } from './metrics.js';
import { PROVIDERS, analyzeWithAI, listModels, buildUserPrompt, renderMarkdown } from './ai.js';

const $ = (id) => document.getElementById(id);
const state = { fit: null, fitWindow: null, videoFile: null, frames: null, result: null, keyImages: [], aiText: '' };

// ---------- 設定（localStorage は使えない環境もあるので必ず try/catch） ----------
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('rfl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rfl.' + k, JSON.stringify(v)); } catch { /* 保存できなくても動作は続ける */ } },
  del(k) { try { localStorage.removeItem('rfl.' + k); } catch { /* noop */ } },
};

function initSettings() {
  const sel = $('provider');
  for (const [id, p] of Object.entries(PROVIDERS)) sel.add(new Option(p.label, id));
  sel.value = store.get('provider', 'gemini');
  const remember = store.get('rememberKey', false);
  $('rememberKey').checked = remember;
  const loadProvider = () => {
    const p = PROVIDERS[sel.value];
    $('apiKey').value = remember || $('rememberKey').checked ? store.get('key.' + sel.value, '') : (state.sessionKeys?.[sel.value] || '');
    $('model').value = store.get('model.' + sel.value, p.defaultModel);
    $('keyHint').innerHTML = `${p.keyHint}（<a href="${p.keyUrl}" target="_blank" rel="noopener">発行ページ</a>）`;
    $('modelList').innerHTML = '';
    updateProviderNote();
  };
  state.sessionKeys = {};
  sel.addEventListener('change', () => { store.set('provider', sel.value); loadProvider(); });
  $('apiKey').addEventListener('input', () => {
    state.sessionKeys[sel.value] = $('apiKey').value.trim();
    if ($('rememberKey').checked) store.set('key.' + sel.value, $('apiKey').value.trim());
    updateProviderNote();
  });
  $('rememberKey').addEventListener('change', (e) => {
    store.set('rememberKey', e.target.checked);
    if (e.target.checked) store.set('key.' + sel.value, $('apiKey').value.trim());
    else for (const id of Object.keys(PROVIDERS)) store.del('key.' + id);
  });
  $('model').addEventListener('change', () => store.set('model.' + sel.value, $('model').value.trim()));
  $('fetchModels').addEventListener('click', async () => {
    const btn = $('fetchModels'); btn.disabled = true; btn.textContent = '取得中…';
    try {
      const models = await listModels(sel.value, $('apiKey').value.trim());
      $('modelList').innerHTML = models.map((m) => `<option value="${m}">`).join('');
      btn.textContent = `${models.length}件`;
    } catch (e) { alert(e.message); btn.textContent = '一覧を取得'; }
    finally { btn.disabled = false; }
  });
  $('openSettings').addEventListener('click', () => $('settings').showModal());
  loadProvider();
}

function currentAI() {
  const provider = $('provider').value;
  return { provider, apiKey: $('apiKey').value.trim(), model: $('model').value.trim() || PROVIDERS[provider].defaultModel };
}
function updateProviderNote() {
  const ai = currentAI();
  $('aiProviderNote').textContent = ai.apiKey
    ? `使用する AI: ${PROVIDERS[ai.provider].label}（${ai.model}）`
    : 'AI の解説には API キーが必要です。右上の「設定」から入力してください（数値の解析だけならキーは不要です）。';
}

// ---------- Garmin ----------
function statHtml(k, v, unit = '') {
  return `<div class="stat"><div class="k">${k}</div><div class="v">${v ?? '—'}${v != null && unit ? `<small>${unit}</small>` : ''}</div></div>`;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

$('fitInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    state.fit = await loadFitFile(file);
  } catch (err) { alert(err.message); return; }
  const f = state.fit, all = summarizeWindow(f, 0, Infinity);
  $('fitSummary').innerHTML = [
    statHtml('距離', f.totalDistanceM ? (f.totalDistanceM / 1000).toFixed(2) : null, 'km'),
    statHtml('時間', fmtTime(f.durationSec)),
    statHtml('平均ペース', all?.pacePerKm, '/km'),
    statHtml('心拍', all?.heartRate, 'bpm'),
    statHtml('ケイデンス', all?.cadenceSpm, 'spm'),
    statHtml('ランニングダイナミクス', f.available.dynamics ? 'あり' : 'なし'),
  ].join('');
  $('fitStart').max = Math.floor(f.durationSec);
  $('fitInfo').classList.remove('hidden');
  trySyncVideoToFit();
  updateFitWindow();
});
$('fitStart').addEventListener('input', updateFitWindow);
$('fitWindowLen').addEventListener('change', updateFitWindow);

function updateFitWindow() {
  const f = state.fit; if (!f) return;
  const len = Number($('fitWindowLen').value);
  const from = len ? Number($('fitStart').value) : 0;
  const to = len ? from + len : Infinity;
  $('fitStart').disabled = !len;
  $('fitStartLabel').textContent = len ? `${fmtTime(from)} 〜 ${fmtTime(Math.min(to, f.durationSec))}` : '全体';
  const w = summarizeWindow(f, from, to);
  state.fitWindow = w;
  $('fitWindowStats').innerHTML = w ? [
    statHtml('ペース', w.pacePerKm, '/km'), statHtml('心拍', w.heartRate, 'bpm'), statHtml('ケイデンス', w.cadenceSpm, 'spm'),
    statHtml('歩幅', w.stepLengthCm, 'cm'), statHtml('上下動', w.verticalOscillationCm, 'cm'), statHtml('上下動比', w.verticalRatioPct, '%'),
    statHtml('接地時間', w.groundContactMs, 'ms'), statHtml('GCTバランス(左)', w.groundContactBalanceLeftPct, '%'),
  ].join('') : '<p class="hint">この区間にはデータがありません。</p>';
  drawFitChart(from, to);
  refreshPayload();
}

function drawFitChart(from, to) {
  const c = $('fitChart'), f = state.fit, dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = 140;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const dur = f.durationSec || 1, x = (t) => (t / dur) * W;
  ctx.fillStyle = css.getPropertyValue('--line');
  ctx.fillRect(x(from), 0, Math.max(2, x(Math.min(to, dur)) - x(from)), H);
  const series = [
    { key: 'speed', color: css.getPropertyValue('--accent'), label: 'スピード' },
    { key: 'spm', color: css.getPropertyValue('--right'), label: 'ケイデンス' },
    { key: 'hr', color: css.getPropertyValue('--left'), label: '心拍' },
  ];
  series.forEach((s, si) => {
    const pts = f.records.filter((r) => r[s.key] > 0);
    if (pts.length < 2) return;
    const vals = pts.map((r) => r[s.key]).sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.02)], hi = vals[Math.floor(vals.length * 0.98)] || lo + 1;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.beginPath();
    pts.forEach((r, i) => {
      const y = H - 6 - ((Math.min(hi, Math.max(lo, r[s.key])) - lo) / (hi - lo || 1)) * (H - 24);
      i ? ctx.lineTo(x(r.t), y) : ctx.moveTo(x(r.t), y);
    });
    ctx.stroke();
    ctx.fillStyle = s.color; ctx.font = '11px system-ui'; ctx.fillText(s.label, 6 + si * 70, 12);
  });
}

// 動画ファイルの更新日時（多くのスマホでは撮影終了時刻）から、アクティビティ内の位置を推定
function trySyncVideoToFit() {
  const f = state.fit, file = state.videoFile, v = $('video');
  if (!f || !file || !v.duration) return;
  const startMs = file.lastModified - v.duration * 1000;
  const offset = (startMs - f.startTime.getTime()) / 1000 + Number($('segStart').value || 0);
  if (offset >= 0 && offset <= f.durationSec) {
    $('fitStart').value = Math.floor(offset);
    $('fitWindowLen').value = '30';
    updateFitWindow();
  }
}

// ---------- 動画 ----------
const video = $('video'), overlay = $('overlay');
for (const [id, label] of Object.entries(MODEL_VARIANTS)) $('variant').add(new Option(label, id));
$('variant').value = store.get('variant', 'full');
$('variant').addEventListener('change', () => store.set('variant', $('variant').value));
$('height').value = store.get('height', '') || '';
$('height').addEventListener('change', () => store.set('height', $('height').value));

$('videoInput').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  state.videoFile = file; state.frames = null; state.result = null;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  $('videoBox').classList.remove('hidden');
  $('secResult').classList.add('hidden'); $('secAI').classList.add('hidden');
});
video.addEventListener('loadedmetadata', () => {
  const stage = video.parentElement, ar = video.videoWidth / video.videoHeight;
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  stage.style.width = `min(100%, calc(70vh * ${ar}))`;
  stage.style.margin = '0 auto';
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  $('segStart').value = 0;
  $('segEnd').value = Math.min(video.duration, 10).toFixed(1);
  $('segStart').max = $('segEnd').max = video.duration.toFixed(1);
  if (video.duration > 30) alert('長い動画です。解析は指定区間（最大30秒まで）に限定されます。');
  trySyncVideoToFit();
});

function drawPose(ctx, lm, scale = 1) {
  if (!lm) return;
  const sideOf = (i) => (i % 2 === 1 ? 'left' : 'right'); // MediaPipe は奇数が左
  const css = getComputedStyle(document.documentElement);
  const color = { left: css.getPropertyValue('--left').trim() || '#e4572e', right: css.getPropertyValue('--right').trim() || '#2e86de' };
  ctx.lineWidth = 4 * scale; ctx.lineCap = 'round';
  for (const [a, b] of CONNECTIONS) {
    const pa = lm[a], pb = lm[b];
    const same = sideOf(a) === sideOf(b); // 11-12, 23-24 は体幹の横線なので白
    ctx.strokeStyle = same ? color[sideOf(a)] : 'rgba(255,255,255,.85)';
    ctx.globalAlpha = Math.min(pa.visibility, pb.visibility) < 0.5 ? 0.45 : 1;
    ctx.beginPath(); ctx.moveTo(pa.x * scale, pa.y * scale); ctx.lineTo(pb.x * scale, pb.y * scale); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.fillStyle = '#fff';
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) {
    ctx.beginPath(); ctx.arc(lm[i].x * scale, lm[i].y * scale, 4 * scale, 0, Math.PI * 2); ctx.fill();
  }
}

function nearestFrame(t) {
  const fr = state.frames; if (!fr?.length) return null;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].t < t) lo = m + 1; else hi = m; }
  const cand = [fr[lo - 1], fr[lo]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return Math.abs(cand.t - t) < 0.1 ? cand : null;
}
function paintOverlay() {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const f = nearestFrame(video.currentTime);
  if (f) drawPose(ctx, f.lm, 1);
}
function overlayLoop() {
  paintOverlay();
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(overlayLoop);
  else requestAnimationFrame(overlayLoop);
}
video.addEventListener('seeked', paintOverlay);
$('segStart').addEventListener('change', trySyncVideoToFit);

let abortCtl = null;
$('runPose').addEventListener('click', async () => {
  const start = Math.max(0, Number($('segStart').value) || 0);
  let end = Math.min(video.duration, Number($('segEnd').value) || video.duration);
  if (end - start > 30) end = start + 30;
  if (end - start < 2) { alert('解析区間は2秒以上にしてください。'); return; }
  const fps = Number($('fps').value);
  abortCtl = new AbortController();
  $('runPose').disabled = true; $('cancelPose').classList.remove('hidden');
  const prog = $('poseProgress'); prog.classList.remove('hidden');
  const setProg = (p, label) => { prog.firstElementChild.style.width = `${Math.round(p * 100)}%`; prog.lastElementChild.textContent = label; };
  setProg(0, 'モデルを読み込み中…');
  try {
    state.frames = await processVideo(video, {
      start, end, fps, variant: $('variant').value, signal: abortCtl.signal,
      onProgress: (p) => setProg(p, `骨格を推定中… ${Math.round(p * 100)}%`),
    });
    const heightCm = Number($('height').value) || null;
    state.result = analyzeFrames(state.frames, { heightCm, fps });
    if (!state.result.ok) throw new Error(state.result.error);
    setProg(1, 'キーフレームを作成中…');
    await captureKeyframes();
    renderResult();
    overlayLoop();
    await seek(video, start);
    setProg(1, '完了');
    $('secResult').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    if (err.name !== 'AbortError') { console.error(err); alert('解析に失敗しました: ' + err.message); }
    setProg(0, err.name === 'AbortError' ? '中止しました' : 'エラー');
  } finally {
    $('runPose').disabled = false; $('cancelPose').classList.add('hidden');
  }
});
$('cancelPose').addEventListener('click', () => abortCtl?.abort());

async function captureKeyframes() {
  state.keyImages = [];
  const maxW = 768, scale = Math.min(1, maxW / video.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale);
  const ctx = c.getContext('2d');
  for (const kf of state.result.keyframes) {
    await seek(video, kf.t);
    ctx.drawImage(video, 0, 0, c.width, c.height);
    drawPose(ctx, nearestFrame(kf.t)?.lm, scale);
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, c.width, 28);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 16px system-ui'; ctx.fillText(`${kf.label}  t=${kf.t.toFixed(2)}s`, 8, 20);
    const url = c.toDataURL('image/jpeg', 0.82);
    state.keyImages.push({ label: kf.label, url, mime: 'image/jpeg', base64: url.split(',')[1] });
  }
}

// ---------- 結果表示 ----------
function renderResult() {
  const r = state.result;
  $('warnings').innerHTML = r.warnings.map((w) => `<li>${w}</li>`).join('');
  const near = r[r.meta.nearSide];
  $('metricCards').innerHTML = [
    statHtml('ケイデンス（動画）', r.cadenceSpm, 'spm'),
    statHtml('体幹の前傾', r.trunkLeanDeg.median, '°'),
    statHtml('上下動（動画）', r.verticalOscillation.cm ?? r.verticalOscillation.pctLeg, r.verticalOscillation.cm != null ? 'cm' : '%脚長'),
    statHtml('接地位置の前方距離', near.overstrideCm ?? near.overstridePctLeg, near.overstrideCm != null ? 'cm' : '%脚長'),
    statHtml('接地時の下腿角', near.shinAngleAtContactDeg, '°'),
    statHtml('接地時の膝屈曲', near.kneeFlexionAtContactDeg, '°'),
    statHtml('接地時間（動画）', near.groundContactMs, 'ms'),
    statHtml('検出率', Math.round(r.meta.detectedRatio * 100), '%'),
  ].join('');
  const rows = [
    ['接地回数', 'contacts', ''], ['可視性', 'visibility', ''],
    ['接地位置の前方距離', 'overstridePctLeg', '%脚長'], ['同（cm換算）', 'overstrideCm', 'cm'],
    ['接地時の膝屈曲', 'kneeFlexionAtContactDeg', '°'], ['接地時の下腿角', 'shinAngleAtContactDeg', '°'],
    ['接地時の足部角', 'footAngleAtContactDeg', '°'], ['離地時の股関節伸展', 'hipExtensionAtToeOffDeg', '°'],
    ['接地時間', 'groundContactMs', 'ms'], ['肘の角度', 'elbowAngleDeg', '°'], ['腕振りの幅', 'armSwingRangePctLeg', '%脚長'],
  ];
  $('lrTable').innerHTML = `<tr><th>指標</th><th class="l">左</th><th class="r">右</th></tr>` +
    rows.map(([k, key, u]) => `<tr><td>${k}${u ? ` <small>(${u})</small>` : ''}</td><td>${r.left[key] ?? '—'}</td><td>${r.right[key] ?? '—'}</td></tr>`).join('');
  $('keyframes').innerHTML = state.keyImages.map((k) => `<figure><img src="${k.url}" alt="${k.label}"><figcaption>${k.label}</figcaption></figure>`).join('');
  $('secResult').classList.remove('hidden');
  $('secAI').classList.remove('hidden');
  updateProviderNote();
  refreshPayload();
}

function buildPayload() {
  const heightCm = Number($('height').value) || null;
  return buildUserPrompt({
    video: state.result,
    fitWindow: state.fitWindow,
    fitMeta: state.fit ? { sport: state.fit.sport, subSport: state.fit.subSport, available: state.fit.available } : null,
    runner: heightCm ? { heightCm } : {},
  });
}
function refreshPayload() {
  if (!state.result) return;
  $('aiPayload').textContent = buildPayload() + `\n\n＋ 画像 ${state.keyImages.length} 枚（${state.keyImages.map((k) => k.label).join('、')}）`;
}

$('runAI').addEventListener('click', async () => {
  const ai = currentAI();
  if (!ai.apiKey) { $('settings').showModal(); return; }
  $('runAI').disabled = true;
  $('aiStatus').textContent = `${PROVIDERS[ai.provider].label} に問い合わせ中…`;
  try {
    const text = await analyzeWithAI({ ...ai, userPrompt: buildPayload(), images: state.keyImages });
    state.aiText = text;
    $('aiResult').innerHTML = renderMarkdown(text);
    $('aiStatus').textContent = `${ai.model} による解説`;
  } catch (err) {
    $('aiStatus').textContent = 'エラー: ' + err.message;
  } finally { $('runAI').disabled = false; }
});

$('exportJson').addEventListener('click', () => {
  const r = state.result; if (!r) return;
  const { _internal, ...video } = r;
  const blob = new Blob([JSON.stringify({
    app: 'Run Form Lab', exportedAt: new Date().toISOString(),
    video, garminWindow: state.fitWindow, aiComment: state.aiText || null,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `runform-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

initSettings();
