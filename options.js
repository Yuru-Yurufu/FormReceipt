const $ = id => document.getElementById(id);
const KIND_LABEL = {
  discord: 'Discord のWebhookとして送ります（カード形式）',
  slack: 'Slack のWebhookとして送ります',
  gchat: 'Google Chat のWebhookとして送ります',
  json: 'JSON形式でPOSTします',
};

function detectKind(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (/^(?:ptb\.|canary\.)?discord(?:app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return 'discord';
    if (u.hostname === 'hooks.slack.com') return 'slack';
    if (u.hostname === 'chat.googleapis.com') return 'gchat';
    return 'json';
  } catch { return null; }
}

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = kind || '';
}

function showKind() {
  const v = $('webhook').value.trim();
  $('kind').textContent = v ? (KIND_LABEL[detectKind(v)] || 'https:// で始まるURLを入れてください') : '';
}

async function load() {
  const s = await chrome.storage.sync.get({ enabled: true, webhook: '' });
  $('enabled').checked = s.enabled;
  $('webhook').value = s.webhook;
  showKind();
  renderHistory();
}

// 送信先サイトへのアクセス許可を求める（クリック直後に呼ぶ必要がある）
function requestAccess(url) {
  if (!url) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [new URL(url).origin + '/*'] }).catch(() => false);
}

async function save() {
  const s = { enabled: $('enabled').checked, webhook: $('webhook').value.trim() };
  if (s.webhook && !detectKind(s.webhook)) {
    setStatus('Webhook URLは https:// で始まるURLにしてください', 'err');
    return false;
  }
  const granted = await requestAccess(s.webhook);
  if (!granted) {
    setStatus('送信先へのアクセスが許可されなかったため、保存しませんでした', 'err');
    return false;
  }
  await chrome.storage.sync.set(s);
  setStatus('保存しました', 'ok');
  return true;
}

$('webhook').oninput = showKind;
$('save').onclick = save;
$('enabled').onchange = save;

$('showWebhook').onclick = () => {
  const t = $('webhook');
  t.type = t.type === 'password' ? 'text' : 'password';
  $('showWebhook').textContent = t.type === 'password' ? '表示' : '隠す';
};

$('test').onclick = async () => {
  if (!(await save())) return;
  if (!$('webhook').value.trim()) return setStatus('Webhook URLを入れてください', 'err');
  $('test').disabled = true;
  setStatus('送信中…');
  chrome.runtime.sendMessage({ type: 'test' }, r => {
    $('test').disabled = false;
    if (r && r.ok) setStatus('テスト送信しました。届いているか確認してください', 'ok');
    else setStatus('失敗：' + ((r && r.error) || '不明なエラー'), 'err');
  });
};

$('export').onclick = async () => {
  const { history = [] } = await chrome.storage.local.get('history');
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `form-receipt-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$('clearHistory').onclick = async () => {
  if (!confirm('このブラウザに保存されている履歴をすべて消しますか？（Webhookで送った分は消えません）')) return;
  await chrome.storage.local.set({ history: [] });
  renderHistory();
};

$('search').oninput = () => renderHistory();

// ---- 履歴 ----
const STATUS_LABEL = { sent: '送信済み', failed: '送信失敗', sending: '送信中', local: '履歴のみ' };
const fmt = iso => iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '';

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => (k === 'class' ? (e.className = v) : e.setAttribute(k, v)));
  children.flat().forEach(c => c != null && e.append(c));
  return e;
}

function asText(h) {
  return [
    h.title, fmt(h.submittedAt), h.url, '',
    ...Object.entries(h.answers || {}).map(([q, v]) => `■ ${q}\n${v && v.length ? v.join('\n') : '（未回答）'}`),
  ].join('\n');
}

function button(label, cls, onclick) {
  const b = el('button', { class: 'ghost small ' + (cls || ''), type: 'button' }, label);
  b.onclick = onclick;
  return b;
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const q = $('search').value.trim().toLowerCase();
  const list = q ? history.filter(h => asText(h).toLowerCase().includes(q)) : history;
  const box = $('history');
  box.replaceChildren();
  if (!history.length) return box.append(el('p', { class: 'empty' }, 'まだ履歴はありません。Googleフォームを送信すると、ここに控えが残ります。'));
  if (!list.length) return box.append(el('p', { class: 'empty' }, '一致する履歴はありません。'));

  list.forEach(h => {
    const qa = el('ol', { class: 'qa' });
    Object.entries(h.answers || {}).forEach(([qq, v]) => {
      qa.append(el('li', {},
        el('div', { class: 'q' }, qq),
        el('div', { class: 'a' + (v && v.length ? '' : ' none') }, v && v.length ? v.join('\n') : '未回答')));
    });

    const tools = el('div', { class: 'row tools' },
      button('テキストをコピー', '', async e => {
        await navigator.clipboard.writeText(asText(h));
        e.target.textContent = 'コピーしました';
        setTimeout(() => { e.target.textContent = 'テキストをコピー'; }, 1500);
      }),
      h.status !== 'sent' && h.status !== 'sending'
        ? button('Webhookで送る', '', e => {
            e.target.disabled = true;
            chrome.runtime.sendMessage({ type: 'resend', id: h.id }, () => renderHistory());
          })
        : null,
      button('この履歴を削除', 'danger', async () => {
        if (!confirm('この履歴を削除しますか？')) return;
        const { history: all = [] } = await chrome.storage.local.get('history');
        await chrome.storage.local.set({ history: all.filter(x => x.id !== h.id) });
      }));

    box.append(el('details', { class: 'h-item' },
      el('summary', {},
        el('span', { class: 'h-title' }, h.title || '(無題のフォーム)'),
        el('span', { class: 'h-date' }, fmt(h.submittedAt)),
        el('span', { class: 'badge ' + h.status }, STATUS_LABEL[h.status] || h.status)),
      el('div', { class: 'h-body' },
        qa,
        el('div', { class: 'h-meta' },
          el('a', { href: h.url, target: '_blank', rel: 'noopener' }, 'フォームを開く'),
          h.error ? ` ・ エラー：${h.error}` : ''),
        tools)));
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) renderHistory();
});

load();
