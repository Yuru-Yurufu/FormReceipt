// 設定の読み込み・Webhookへの送信・履歴の保存を担当する
const HISTORY_MAX = 300;
const APP = 'Form Receipt';
const VERSION = chrome.runtime.getManifest().version;

// ---- Webhookの種類を判定 ----
function detectKind(url) {
  try {
    const u = new URL(url);
    if (/^(?:ptb\.|canary\.)?discord(?:app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return 'discord';
    if (u.hostname === 'hooks.slack.com') return 'slack';
    if (u.hostname === 'chat.googleapis.com') return 'gchat';
    return 'json';
  } catch { return null; }
}

async function getSettings() {
  return chrome.storage.sync.get({ enabled: true, webhook: '' });
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const answerText = v => (v && v.length ? v.join('\n') : '（未回答）');
const entries = d => Object.entries(d.answers || {});
const fmtJa = iso => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' });

function plainText(d) {
  return [
    `📝 ${d.title || '無題のフォーム'}`,
    `送信日時：${fmtJa(d.submittedAt)}`,
    d.url,
    '',
    ...entries(d).map(([q, v], i) => `Q${i + 1}. ${q}\n${answerText(v)}`),
  ].join('\n');
}

// 長い文字列を n 字ごとに分ける（できるだけ改行で区切る）
function chunk(s, n) {
  const out = [];
  while (s.length > n) {
    let i = s.lastIndexOf('\n', n);
    if (i < n / 2) i = n;
    out.push(s.slice(0, i));
    s = s.slice(i).replace(/^\n/, '');
  }
  out.push(s);
  return out;
}

// ---- Discord：埋め込みカード（6000字・フィールド25個・名前256字・値1024字まで）----
function discordMessages(d) {
  const LIM = { total: 5800, fields: 25, name: 256, value: 1024, title: 256 };
  const COLOR = 0x1f6feb;
  const fields = [];
  entries(d).forEach(([q, v], i) => {
    const ans = v && v.length ? v.join('\n') : '*（未回答）*';
    chunk(ans, LIM.value).forEach((part, j) => {
      fields.push({ name: cut(j ? `　（Q${i + 1} の続き）` : `Q${i + 1}. ${q}`, LIM.name), value: part || '​' });
    });
  });

  const title = cut('📝 ' + (d.title || '無題のフォーム'), LIM.title);
  const embeds = [];
  let cur = null, size = 0;
  for (const f of fields) {
    const fs = f.name.length + f.value.length;
    if (!cur || cur.fields.length >= LIM.fields || size + fs > LIM.total) {
      cur = { color: COLOR, fields: [] };
      if (!embeds.length) {
        Object.assign(cur, { title, url: d.url, description: `送信日時：<t:${Math.floor(new Date(d.submittedAt) / 1000)}:F>` });
      } else {
        cur.title = cut(title + '（続き）', LIM.title);
      }
      size = cur.title.length + 40;
      embeds.push(cur);
    }
    cur.fields.push(f);
    size += fs;
  }
  if (!embeds.length) embeds.push({ color: COLOR, title, url: d.url, description: '（回答項目を読み取れませんでした）' });
  const last = embeds[embeds.length - 1];
  last.footer = { text: `送信完了画面を確認済み・${APP}` };
  last.timestamp = d.submittedAt;
  return embeds.map(e => ({ username: APP, embeds: [e], allowed_mentions: { parse: [] } }));
}

// ---- Slack：Block Kit（1メッセージ50ブロック・1セクション3000字まで）----
function slackMessages(d) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = [
    { type: 'header', text: { type: 'plain_text', text: cut('📝 ' + (d.title || '無題のフォーム'), 150), emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `送信日時：${fmtJa(d.submittedAt)}　<${d.url}|フォームを開く>` }] },
    { type: 'divider' },
  ];
  const sections = [];
  entries(d).forEach(([q, v], i) => {
    const body = `*Q${i + 1}. ${esc(q)}*\n${v && v.length ? esc(v.join('\n')) : '_（未回答）_'}`;
    chunk(body, 2900).forEach(t => sections.push({ type: 'section', text: { type: 'mrkdwn', text: t } }));
  });
  const msgs = [];
  for (let i = 0; i === 0 || i < sections.length; i += 45) {
    const blocks = (i === 0 ? head : []).concat(sections.slice(i, i + 45));
    msgs.push({ text: `回答の控え：${d.title || '無題のフォーム'}`, blocks });
  }
  msgs[msgs.length - 1].blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `送信完了画面を確認済み・${APP}` }] });
  return msgs;
}

// ---- Google Chat：テキスト（4096字まで）----
function gchatMessages(d) {
  const t = plainText(d).replace(/^📝 (.*)$/m, '*📝 $1*');
  return chunk(t, 4000).map(text => ({ text }));
}

// ---- その他：JSON（Zapier・Make・n8n・自作サーバーなど向け。text は Mattermost などでそのまま表示される）----
function jsonMessages(d, type = 'form_response') {
  return [{
    app: APP,
    version: VERSION,
    type,
    form: { title: d.title || '', url: d.url || '' },
    submittedAt: d.submittedAt,
    answers: entries(d).map(([question, values]) => ({ question, values: values || [] })),
    text: plainText(d),
  }];
}

function buildMessages(kind, d, type) {
  if (kind === 'discord') return discordMessages(d);
  if (kind === 'slack') return slackMessages(d);
  if (kind === 'gchat') return gchatMessages(d);
  return jsonMessages(d, type);
}

async function postWebhook(url, kind, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(kind === 'discord' ? url + (url.includes('?') ? '&' : '?') + 'wait=true' : url, {
      method: 'POST',
      headers: { 'Content-Type': kind === 'gchat' ? 'application/json; charset=UTF-8' : 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    if (res.status === 429) { // レート制限：少し待って再試行
      const j = await res.clone().json().catch(() => ({}));
      const wait = j.retry_after || Number(res.headers.get('Retry-After')) || 2;
      await new Promise(r => setTimeout(r, Math.min(10, wait) * 1000));
      continue;
    }
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`.trim());
  }
  throw new Error('送信先のレート制限で送れませんでした');
}

async function send(d, type) {
  const { webhook } = await getSettings();
  const kind = detectKind(webhook);
  if (!kind || !/^https:\/\//.test(webhook)) throw new Error('Webhook URLが未設定です');
  const origin = new URL(webhook).origin + '/*';
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    throw new Error('送信先へのアクセスが許可されていません。設定画面で保存し直してください');
  }
  for (const m of buildMessages(kind, d, type)) await postWebhook(webhook, kind, m);
}

// ---- 履歴 ----
async function addHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}
async function updateHistory(id, patch) {
  const { history = [] } = await chrome.storage.local.get('history');
  const i = history.findIndex(h => h.id === id);
  if (i >= 0) { Object.assign(history[i], patch); await chrome.storage.local.set({ history }); }
}

async function sendReceipt(id, data) {
  try {
    await send(data);
    await updateHistory(id, { status: 'sent', error: null });
    return { ok: true };
  } catch (e) {
    await updateHistory(id, { status: 'failed', error: e.message });
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'receipt') {
      const s = await getSettings();
      const id = crypto.randomUUID();
      const off = !s.enabled || !s.webhook;
      await addHistory({ id, ...msg.data, status: off ? 'local' : 'sending' }); // 送信オフでも履歴は残す
      if (off) return reply({ ok: true, local: true });
      reply(await sendReceipt(id, msg.data));
    } else if (msg.type === 'resend') {
      const { history = [] } = await chrome.storage.local.get('history');
      const h = history.find(x => x.id === msg.id);
      if (!h) return reply({ ok: false, error: '履歴が見つかりません' });
      const { id, status, error, ...data } = h;
      reply(await sendReceipt(id, data));
    } else if (msg.type === 'test') {
      try {
        await send({
          title: 'テスト送信', url: 'https://docs.google.com/forms/', submittedAt: new Date().toISOString(),
          answers: { [`これは ${APP} のテストです`]: ['この通知が届いていれば設定は完了です。'] },
        }, 'test');
        reply({ ok: true });
      } catch (e) { reply({ ok: false, error: e.message }); }
    } else if (msg.type === 'detect') {
      reply({ kind: detectKind(msg.url) });
    }
  })();
  return true; // 非同期で reply する
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
