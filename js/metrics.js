// フォーム指標の計算（純粋関数のみ。ブラウザ・Node 両方で動作）
// 入力: frames = [{ t: 秒, lm: [{x, y, visibility}] (ピクセル座標) | null }]

export const LM = {
  NOSE: 0, L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANK: 27, R_ANK: 28,
  L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32,
};

export const SIDES = {
  left:  { sh: LM.L_SH, el: LM.L_EL, wr: LM.L_WR, hip: LM.L_HIP, knee: LM.L_KNEE, ank: LM.L_ANK, heel: LM.L_HEEL, foot: LM.L_FOOT },
  right: { sh: LM.R_SH, el: LM.R_EL, wr: LM.R_WR, hip: LM.R_HIP, knee: LM.R_KNEE, ank: LM.R_ANK, heel: LM.R_HEEL, foot: LM.R_FOOT },
};

// 骨格の描画用接続
export const CONNECTIONS = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [12, 14], [14, 16], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

// 脚長（股関節〜足首）の身長比。Drillis & Contini の体節比（大腿0.245＋下腿0.246）による概算
const LEG_TO_HEIGHT = 0.49;

const finite = (a) => a.filter(Number.isFinite);
export function quantile(arr, q) {
  const s = finite(arr).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (a) => quantile(a, 0.5);
const mean = (a) => { const f = finite(a); return f.length ? f.reduce((s, v) => s + v, 0) / f.length : NaN; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const deg = (r) => (r * 180) / Math.PI;
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r0 = (v) => (Number.isFinite(v) ? Math.round(v) : null);

export function angleAt(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!n) return NaN;
  return deg(Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n))));
}

// 3フレーム移動平均で手ぶれ的なジッタを抑える
export function smoothFrames(frames) {
  return frames.map((f, i) => {
    if (!f.lm) return f;
    const nb = [frames[i - 1], f, frames[i + 1]].filter((g) => g && g.lm);
    const lm = f.lm.map((p, k) => ({
      x: nb.reduce((s, g) => s + g.lm[k].x, 0) / nb.length,
      y: nb.reduce((s, g) => s + g.lm[k].y, 0) / nb.length,
      visibility: p.visibility ?? 1,
    }));
    return { ...f, lm };
  });
}

// 接地・離地イベント検出（画像座標は y 下向き＝地面側が大きい）
function detectEvents(frames, s, legLen) {
  const footY = frames.map((f) => Math.max(f.lm[s.heel].y, f.lm[s.foot].y));
  const toeY = frames.map((f) => f.lm[s.foot].y);
  const ground = quantile(footY, 0.95);
  const toeGround = quantile(toeY, 0.95);
  const contactTh = ground - 0.04 * legLen;
  const liftTh = ground - 0.12 * legLen;
  const contacts = [], toeoffs = [];
  let state = footY[0] >= contactTh ? 'ground' : 'air';
  for (let i = 1; i < frames.length; i++) {
    if (state === 'air' && footY[i] >= contactTh) {
      state = 'ground';
      // つま先が浮くまで探索して離地とする
      let to = -1;
      for (let j = i + 1; j < frames.length; j++) {
        if (toeY[j] < toeGround - 0.025 * legLen) { to = j; break; }
      }
      contacts.push(i);
      toeoffs.push(to);
    } else if (state === 'ground' && footY[i] < liftTh) {
      state = 'air';
    }
  }
  return { contacts, toeoffs };
}

export function analyzeFrames(rawFrames, opts = {}) {
  const { heightCm = null, fps = 30 } = opts;
  const warnings = [];
  const total = rawFrames.length;
  const frames = smoothFrames(rawFrames).filter((f) => f.lm);
  const detectedRatio = total ? frames.length / total : 0;
  if (frames.length < 15) {
    return { ok: false, error: '人物の骨格をほとんど検出できませんでした。全身が映った横からの動画で試してください。' };
  }
  if (detectedRatio < 0.8) warnings.push(`骨格を検出できたフレームが${Math.round(detectedRatio * 100)}%です。全身がフレームに収まっているか確認してください。`);

  const L = SIDES.left, R = SIDES.right;
  const hipMid = (f) => mid(f.lm[L.hip], f.lm[R.hip]);
  const shMid = (f) => mid(f.lm[L.sh], f.lm[R.sh]);

  // 進行方向（+1: 画面右へ, -1: 画面左へ）。つま先−かかとの向きで判定、補助で鼻の位置
  let s = median(frames.flatMap((f) => [f.lm[L.foot].x - f.lm[L.heel].x, f.lm[R.foot].x - f.lm[R.heel].x]));
  if (!s) s = median(frames.map((f) => f.lm[LM.NOSE].x - shMid(f).x));
  const dir = s >= 0 ? 1 : -1;

  const legLen = median(frames.map((f) =>
    (dist(f.lm[L.hip], f.lm[L.knee]) + dist(f.lm[L.knee], f.lm[L.ank]) +
     dist(f.lm[R.hip], f.lm[R.knee]) + dist(f.lm[R.knee], f.lm[R.ank])) / 2));
  const torso = median(frames.map((f) => dist(shMid(f), hipMid(f))));
  const pxToCm = heightCm ? (heightCm * LEG_TO_HEIGHT) / legLen : null;

  // 撮影角度チェック：横からなら肩幅（x方向）は胴の長さに比べて小さい
  const shoulderSpread = median(frames.map((f) => Math.abs(f.lm[L.sh].x - f.lm[R.sh].x)));
  if (shoulderSpread > 0.45 * torso) warnings.push('真横からの撮影ではない可能性があります。角度系の指標は誤差が大きくなります。');
  const hipXRange = quantile(frames.map((f) => hipMid(f).x), 0.95) - quantile(frames.map((f) => hipMid(f).x), 0.05);
  if (hipXRange > 1.5 * legLen) warnings.push('人物が画面内を大きく移動しています（屋外の横切り撮影など）。固定カメラ・トレッドミルの方が安定します。');
  if (fps < 50) warnings.push(`解析は${fps}fpsです。接地時間（動画）は±${Math.round(1000 / fps)}ms程度の誤差があります。`);

  // フレームごとの指標
  const trunk = frames.map((f) => { const h = hipMid(f), sh = shMid(f); return deg(Math.atan2(dir * (sh.x - h.x), h.y - sh.y)); });
  const hipY = frames.map((f) => hipMid(f).y);

  const perSide = {};
  const allContacts = [];
  for (const [name, sd] of Object.entries(SIDES)) {
    const vis = mean(frames.map((f) => (f.lm[sd.ank].visibility + f.lm[sd.knee].visibility + f.lm[sd.hip].visibility) / 3));
    const { contacts, toeoffs } = detectEvents(frames, sd, legLen);
    const ev = contacts.map((i, k) => {
      const f = frames[i], h = hipMid(f);
      const hip = f.lm[sd.hip], knee = f.lm[sd.knee], ank = f.lm[sd.ank], heel = f.lm[sd.heel], foot = f.lm[sd.foot];
      const toI = toeoffs[k];
      let hipExt = NaN, gct = NaN;
      if (toI > i) {
        const g = frames[toI];
        hipExt = deg(Math.atan2(-dir * (g.lm[sd.knee].x - g.lm[sd.hip].x), g.lm[sd.knee].y - g.lm[sd.hip].y));
        gct = (g.t - f.t) * 1000;
      }
      return {
        i, t: f.t,
        overstride: (dir * (ank.x - h.x)) / legLen,            // 接地時の足首の前方距離（脚長比）
        kneeFlex: 180 - angleAt(hip, knee, ank),               // 接地時の膝屈曲角
        shin: deg(Math.atan2(dir * (ank.x - knee.x), ank.y - knee.y)), // 下腿の傾き（+は足首が膝より前）
        footAngle: deg(Math.atan2(heel.y - foot.y, dir * (foot.x - heel.x))), // +はつま先が上がった接地
        hipExt, gct,
      };
    });
    ev.forEach((e) => allContacts.push({ ...e, side: name }));
    const elbow = frames.map((f) => angleAt(f.lm[sd.sh], f.lm[sd.el], f.lm[sd.wr]));
    const wristRel = frames.map((f) => (dir * (f.lm[sd.wr].x - f.lm[sd.sh].x)) / legLen);
    const ovs = ev.map((e) => e.overstride);
    perSide[name] = {
      visibility: r1(vis * 100) / 100,
      contacts: ev.length,
      overstridePctLeg: r1(median(ovs) * 100),
      overstrideCm: pxToCm ? r1(median(ovs) * legLen * pxToCm) : null,
      kneeFlexionAtContactDeg: r1(median(ev.map((e) => e.kneeFlex))),
      shinAngleAtContactDeg: r1(median(ev.map((e) => e.shin))),
      footAngleAtContactDeg: r1(median(ev.map((e) => e.footAngle))),
      hipExtensionAtToeOffDeg: r1(median(ev.map((e) => e.hipExt))),
      groundContactMs: r0(median(ev.map((e) => e.gct))),
      elbowAngleDeg: r1(median(elbow)),
      armSwingRangePctLeg: r1((quantile(wristRel, 0.95) - quantile(wristRel, 0.05)) * 100),
      events: ev,
    };
  }
  allContacts.sort((a, b) => a.t - b.t);

  // ケイデンス
  let cadence = NaN;
  const both = perSide.left.contacts >= 2 && perSide.right.contacts >= 2;
  if (both && allContacts.length >= 3) {
    cadence = ((allContacts.length - 1) / (allContacts.at(-1).t - allContacts[0].t)) * 60;
  } else {
    const side = perSide.left.contacts >= perSide.right.contacts ? perSide.left : perSide.right;
    const ev = side.events;
    if (ev.length >= 2) cadence = ((ev.length - 1) / (ev.at(-1).t - ev[0].t)) * 60 * 2;
  }
  if (allContacts.length < 4) warnings.push('検出できた接地が少ないため、数値の信頼性は低めです。5秒以上（10歩以上）の動画を推奨します。');

  // 上下動：接地〜次の接地の間の骨盤高さの振れ幅
  const vos = [];
  for (let k = 1; k < allContacts.length; k++) {
    const a = allContacts[k - 1].i, b = allContacts[k].i;
    if (b - a < 2) continue;
    const seg = hipY.slice(a, b + 1);
    vos.push(Math.max(...seg) - Math.min(...seg));
  }
  const vo = median(vos);

  // 近い側の脚（可視性が高い側）
  const nearSide = perSide.left.visibility >= perSide.right.visibility ? 'left' : 'right';
  const farSide = nearSide === 'left' ? 'right' : 'left';
  if (perSide[farSide].visibility < 0.6) warnings.push(`カメラから遠い側（${farSide === 'left' ? '左' : '右'}脚）は隠れやすく、左右差の比較は参考程度です。`);

  // AI に送るキーフレーム：左右それぞれの代表的な接地と、近い側の離地
  const keyframes = [];
  for (const name of ['left', 'right']) {
    const ev = perSide[name].events;
    if (!ev.length) continue;
    const m = median(ev.map((e) => e.overstride));
    const pick = ev.reduce((best, e) => (Math.abs(e.overstride - m) < Math.abs(best.overstride - m) ? e : best));
    keyframes.push({ t: pick.t, label: `${name === 'left' ? '左' : '右'}足の接地` });
  }
  const nearEv = perSide[nearSide].events.filter((e) => Number.isFinite(e.gct));
  if (nearEv.length) {
    const e = nearEv[Math.floor(nearEv.length / 2)];
    keyframes.push({ t: e.t + e.gct / 1000, label: `${nearSide === 'left' ? '左' : '右'}足の離地` });
  }

  const strip = (o) => { const { events, ...rest } = o; return rest; };
  return {
    ok: true,
    meta: {
      framesAnalyzed: total, detectedRatio: r1(detectedRatio * 100) / 100, fps,
      durationSec: r1(rawFrames.at(-1).t - rawFrames[0].t),
      direction: dir > 0 ? '右向きに走行' : '左向きに走行',
      nearSide, heightCm, scaleNote: heightCm ? '身長から脚長を推定してcm換算（概算）' : 'cm換算なし（身長未入力）',
    },
    cadenceSpm: r0(cadence),
    trunkLeanDeg: { median: r1(median(trunk)), p10: r1(quantile(trunk, 0.1)), p90: r1(quantile(trunk, 0.9)) },
    verticalOscillation: { pctLeg: r1((vo / legLen) * 100), cm: pxToCm ? r1(vo * pxToCm) : null },
    left: strip(perSide.left),
    right: strip(perSide.right),
    contacts: allContacts.map((c) => ({ t: r1(c.t * 100) / 100, side: c.side, i: c.i })),
    keyframes,
    warnings,
    _internal: { dir, legLen, torso },
  };
}
