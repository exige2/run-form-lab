// 動画ファイル（MP4 / MOV）のメタデータから撮影開始時刻を読む
// ファイル全体は読まず、必要な箱（box）だけを slice で読み込む

const EPOCH_1904 = Date.UTC(1904, 0, 1);
const MAX_MOOV = 64 * 1024 * 1024;

const typeAt = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

async function view(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

// 子ボックスを列挙する
function* children(dv, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = typeAt(dv, o + 4);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { type, start: o + hdr, end: o + size };
    o += size;
  }
}

function plausible(d) {
  const y = d?.getUTCFullYear?.();
  return d && !Number.isNaN(d.getTime()) && y >= 2005 && d.getTime() < Date.now() + 2 * 86400e3;
}

// "2026-10-10T16:05:12+0900" のような Apple 形式を Date に
export function parseAppleDate(s) {
  if (!s) return null;
  const norm = s.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(norm);
  return plausible(d) ? d : null;
}

function readMvhd(dv, box) {
  const version = dv.getUint8(box.start);
  const secs = version === 1 ? Number(dv.getBigUint64(box.start + 4)) : dv.getUint32(box.start + 4);
  if (!secs) return null;
  const d = new Date(EPOCH_1904 + secs * 1000);
  return plausible(d) ? d : null;
}

// QuickTime の moov/meta（keys + ilst）から com.apple.quicktime.creationdate を探す
function readAppleCreationDate(dv, meta) {
  // QuickTime の meta はフルボックスではないが、ISO 形式ではバージョン/フラグの4バイトが付く
  const first = typeAt(dv, meta.start + 4) === 'hdlr' || typeAt(dv, meta.start + 4) === 'keys' ? meta.start : meta.start + 4;
  let keys = [], ilst = null;
  for (const b of children(dv, first, meta.end)) {
    if (b.type === 'keys') {
      const count = dv.getUint32(b.start + 4);
      let o = b.start + 8;
      for (let i = 0; i < count && o + 8 <= b.end; i++) {
        const sz = dv.getUint32(o);
        if (sz < 8) break;
        keys.push(new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + o + 8, sz - 8)));
        o += sz;
      }
    } else if (b.type === 'ilst') ilst = b;
  }
  const idx = keys.indexOf('com.apple.quicktime.creationdate');
  if (idx < 0 || !ilst) return null;
  for (const item of children(dv, ilst.start, ilst.end)) {
    if (dv.getUint32(item.start - 4) !== idx + 1) continue; // ilst の子の type はキー番号（1始まり）
    for (const data of children(dv, item.start, item.end)) {
      if (data.type !== 'data') continue;
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset + data.start + 8, data.end - data.start - 8);
      return parseAppleDate(new TextDecoder().decode(bytes));
    }
  }
  return null;
}

// 戻り値: { date: Date, source: string } または null
export async function getVideoCreationTime(file) {
  try {
    let off = 0, moov = null;
    for (let guard = 0; off + 8 <= file.size && guard < 2000; guard++) {
      const h = await view(file, off, Math.min(off + 16, file.size));
      let size = h.getUint32(0), hdr = 8;
      const type = typeAt(h, 4);
      if (size === 1) { size = Number(h.getBigUint64(8)); hdr = 16; }
      else if (size === 0) size = file.size - off;
      if (size < 8) break;
      if (type === 'moov') {
        if (size > MAX_MOOV) return null;
        moov = await view(file, off, off + size);
        moov.box = { start: hdr, end: size };
        break;
      }
      off += size;
    }
    if (!moov) return null;
    let mvhd = null, apple = null;
    for (const b of children(moov, moov.box.start, moov.box.end)) {
      if (b.type === 'mvhd') mvhd = readMvhd(moov, b);
      if (b.type === 'meta' && !apple) apple = readAppleCreationDate(moov, b);
      if (b.type === 'udta' && !apple) { // 変換ソフトによっては moov/udta/meta に入る
        for (const u of children(moov, b.start, b.end)) if (u.type === 'meta') apple = readAppleCreationDate(moov, u) || apple;
      }
    }
    if (apple) return { date: apple, source: '動画のメタデータ（撮影日時）' };
    if (mvhd) return { date: mvhd, source: '動画のメタデータ（作成日時）' };
    return null;
  } catch {
    return null;
  }
}
