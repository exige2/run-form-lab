// Garmin FIT の読み込みと区間集計
// デコードは Garmin 公式 FIT SDK（JavaScript 版）を使用。集計部分は純粋関数。

const FIT_SDK_URL = 'https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.218.0/+esm';
const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm';

// .fit または Garmin Connect からエクスポートした .zip を受け付ける
export async function loadFitFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // "PK" = zip
    const { unzipSync } = await import(FFLATE_URL);
    const entries = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith('.fit') });
    const first = Object.values(entries)[0];
    if (!first) throw new Error('ZIP の中に .fit ファイルが見つかりませんでした。');
    bytes = first;
  }
  const { Decoder, Stream } = await import(FIT_SDK_URL);
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  if (!decoder.isFIT()) throw new Error('FIT ファイルとして読み込めませんでした。');
  const { messages, errors } = decoder.read();
  if (errors?.length && !messages?.recordMesgs?.length) throw new Error('FIT の解析に失敗しました: ' + errors[0].message);
  return fitFromMessages(messages);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function fitFromMessages(messages) {
  const recs = messages.recordMesgs || [];
  if (!recs.length) throw new Error('記録データ（record）が含まれていません。');
  const t0 = new Date(recs[0].timestamp).getTime();
  const records = recs.map((r) => {
    const cad = num(r.cadence);
    const speed = num(r.enhancedSpeed) ?? num(r.speed);
    return {
      t: (new Date(r.timestamp).getTime() - t0) / 1000,
      hr: num(r.heartRate),
      spm: cad != null ? (cad + (num(r.fractionalCadence) || 0)) * 2 : null, // FIT のランニングケイデンスは片足あたり
      speed,
      dist: num(r.distance),
      voMm: num(r.verticalOscillation),
      gctMs: num(r.stanceTime),
      gctBalance: num(r.stanceTimeBalance),
      stepMm: num(r.stepLength),
      vRatio: num(r.verticalRatio),
      power: num(r.power),
    };
  });
  const session = messages.sessionMesgs?.[0] || {};
  const has = (k) => records.some((r) => r[k] != null && r[k] > 0);
  return {
    startTime: new Date(t0),
    sport: session.sport ?? null,
    subSport: session.subSport ?? null,
    durationSec: records.at(-1).t,
    totalDistanceM: num(session.totalDistance) ?? records.at(-1).dist,
    records,
    available: {
      hr: has('hr'), cadence: has('spm'), speed: has('speed'), power: has('power'),
      dynamics: has('voMm') || has('gctMs'),
    },
  };
}

function med(arr) {
  const s = arr.filter((v) => v != null && Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function formatPace(speed) {
  if (!speed || speed <= 0.3) return null;
  const secPerKm = 1000 / speed;
  const m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

// 指定区間（アクティビティ開始からの秒）の中央値を集計
export function summarizeWindow(fit, fromSec = 0, toSec = Infinity) {
  const rs = fit.records.filter((r) => r.t >= fromSec && r.t <= toSec);
  if (!rs.length) return null;
  const speed = med(rs.map((r) => r.speed));
  const spm = med(rs.map((r) => r.spm));
  let stepCm = med(rs.map((r) => r.stepMm));
  stepCm = stepCm != null ? stepCm / 10 : speed && spm ? (speed / (spm / 60)) * 100 : null;
  return {
    fromSec: round(fromSec), toSec: round(Math.min(toSec, fit.durationSec)),
    pacePerKm: formatPace(speed),
    speedMs: round(speed, 2),
    heartRate: round(med(rs.map((r) => r.hr))),
    cadenceSpm: round(spm),
    stepLengthCm: round(stepCm, 1),
    verticalOscillationCm: round(med(rs.map((r) => r.voMm)) / 10, 1) || null,
    verticalRatioPct: round(med(rs.map((r) => r.vRatio)), 1),
    groundContactMs: round(med(rs.map((r) => r.gctMs))),
    groundContactBalanceLeftPct: round(med(rs.map((r) => r.gctBalance)), 1),
    powerW: round(med(rs.map((r) => r.power))),
    samples: rs.length,
  };
}
