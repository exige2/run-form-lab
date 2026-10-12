// AI 解説：プロバイダごとの呼び出しをここに集約する
// Phase 1 はユーザー自身の API キー（BYOK）でブラウザから直接呼ぶ。
// Phase 2 で「キー不要モード」を追加するときは provider 'proxy' を有効化し、サーバー側で同じプロンプトを使う。

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-flash-latest',
    keyHint: 'Google AI Studio で発行した API キー',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-sonnet-5-5',
    keyHint: 'Claude Console で発行した API キー',
    keyUrl: 'https://console.anthropic.com/',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5-mini',
    keyHint: 'OpenAI Platform で発行した API キー',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

const SYSTEM_PROMPT = `あなたは経験豊富なランニングコーチ兼バイオメカニクスの専門家です。
ランナーの横からの動画を骨格推定して得た2Dの指標と、Garmin ウォッチの記録値、代表フレームの画像をもとに、フォームの特徴と改善策を日本語で解説してください。

守ること:
- 数値は2D動画からの推定であり、撮影角度・レンズ歪み・骨格推定の誤差を含む。断定しすぎず、確度に応じて言い切りと推測を使い分ける。
- 動画の指標と Garmin の指標が食い違う場合は、Garmin の接地時間・上下動・ケイデンスを優先し、食い違いに触れる。
- 根拠の数値を必ず引用する。数値が null の項目は計測できなかったものとして扱い、推測で埋めない。
- 医学的な診断やケガの断定はしない。痛みがある場合は専門家（医師・理学療法士）への相談を勧める一文を入れる。
- 一般論の羅列ではなく、このランナーの数値に基づいた優先度の高い指摘に絞る。

指標の読み方の目安（個人差・ペース依存が大きいので参考程度）:
- overstridePctLeg: 接地時に足首が骨盤中心より前にある距離（脚長比%）。大きいほどブレーキがかかりやすい。
- shinAngleAtContactDeg: 接地時の下腿の傾き。+は足首が膝より前（ブレーキ寄り）、0付近は真下接地に近い。
- kneeFlexionAtContactDeg: 接地時の膝の曲がり。小さすぎる（伸びきった）接地は衝撃が大きくなりやすい。
- footAngleAtContactDeg: +はつま先が上がった接地（かかと寄り）、0付近はフラット、−はつま先寄り。
- trunkLeanDeg: 体幹の前傾（+が前傾）。
- verticalOscillation / verticalRatioPct: 上下動と上下動比。上下動比は小さいほど効率的とされる。
- hipExtensionAtToeOffDeg: 離地時の股関節伸展（大腿が鉛直より後ろに何度）。

出力形式（Markdown）:
## 総評
2〜3文。
## 良い点
箇条書き1〜3個。
## 改善ポイント
優先度順に最大3つ。各項目に「根拠（数値）」「なぜ大事か」「意識するポイント」を含める。
## おすすめドリル・練習
2〜4個。回数や時間の目安つき。
## 次回の撮影・計測のヒント
解析の精度を上げるための助言を1〜2個（必要な場合のみ）。`;

export function buildUserPrompt({ video, fitWindow, fitMeta, runner }) {
  const payload = {
    runner: runner || {},
    video_metrics: video ? stripInternal(video) : null,
    garmin_window: fitWindow || null,
    garmin_activity: fitMeta || null,
  };
  return `以下のデータを解析してください。添付画像は骨格を重ねた代表フレームで、順に ${
    (video?.keyframes || []).map((k, i) => `画像${i + 1}=${k.label}`).join('、') || '（画像なし）'
  } です。\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function stripInternal(v) {
  const { _internal, contacts, keyframes, ...rest } = v;
  return { ...rest, contactCount: contacts?.length ?? 0 };
}

async function readError(res) {
  let msg = `${res.status} ${res.statusText}`;
  try { const j = await res.json(); msg += ' — ' + (j.error?.message || j.message || JSON.stringify(j).slice(0, 300)); } catch { /* noop */ }
  if (res.status === 401 || res.status === 403) msg += '（API キーを確認してください）';
  if (res.status === 429) msg += '（利用上限に達しました。時間をおいて再試行してください）';
  return new Error(msg);
}

// images: [{ base64, mime }]
export async function analyzeWithAI({ provider, apiKey, model, userPrompt, images = [], signal }) {
  if (!apiKey) throw new Error('API キーが設定されていません。');
  model = model || PROVIDERS[provider].defaultModel;

  if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [
          ...images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.base64 } })),
          { text: userPrompt },
        ] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    });
    if (!res.ok) throw await readError(res);
    const j = await res.json();
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) throw new Error('応答が空でした（安全フィルタやトークン上限の可能性）。');
    return text;
  }

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // BYOK でブラウザから直接呼ぶために必要
      },
      body: JSON.stringify({
        model, max_tokens: 4096, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [
          ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } })),
          { type: 'text', text: userPrompt },
        ] }],
      }),
    });
    if (!res.ok) throw await readError(res);
    const j = await res.json();
    return j.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') || '';
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: userPrompt },
            ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } })),
          ] },
        ],
      }),
    });
    if (!res.ok) throw await readError(res);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  }

  throw new Error('未対応のプロバイダです: ' + provider);
}

// 使えるモデル名の一覧を取得（モデル名は頻繁に変わるため、ハードコードせず選べるようにする）
export async function listModels(provider, apiKey) {
  if (!apiKey) throw new Error('先に API キーを入力してください。');
  if (provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': apiKey } });
    if (!res.ok) throw await readError(res);
    const j = await res.json();
    return (j.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /gemini/i.test(n));
  }
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    if (!res.ok) throw await readError(res);
    return ((await res.json()).data || []).map((m) => m.id);
  }
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw await readError(res);
    return ((await res.json()).data || []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort();
  }
  return [];
}

// 依存なしの簡易 Markdown → HTML（先にエスケープするので XSS にならない）
export function renderMarkdown(md) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); const lv = Math.min(4, m[1].length + 1); out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); }
    else if ((m = line.match(/^\s*[-*・]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('\n');
}
