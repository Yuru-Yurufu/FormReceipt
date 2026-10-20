// Googleフォームの回答画面で動くスクリプト
// 入力中の回答をタブ内（sessionStorage）に控え、送信完了画面を確認したら background に渡す
(() => {
  'use strict';

  const path = location.pathname;
  if (!/\/(viewform|formResponse)\b/.test(path)) return; // 編集画面・集計画面では動かさない
  const m = path.match(/\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([^/]+)/);
  if (!m) return;
  const KEY = 'formReceipt:draft:' + m[1];
  const DRAFT_TTL_MS = 6 * 3600 * 1000;

  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const CONTROLS = ['input:not([type="hidden"])', 'textarea', '[role="radio"]', '[role="checkbox"]', '[role="listbox"]'];
  const hasControl = root => CONTROLS.some(sel => root.querySelector(sel));

  const CHECKED = '[role="radio"][aria-checked="true"],[role="checkbox"][aria-checked="true"]';
  const choiceValue = el => clean(el.getAttribute('data-value') || el.getAttribute('data-answer-value') || el.getAttribute('aria-label'));

  // グリッド（選択式・チェックボックス）の行の見出しを取る
  function rowLabel(group, i) {
    const by = group.getAttribute('aria-labelledby');
    const labelled = by && by.split(/\s+/).map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
    return clean(group.getAttribute('aria-label') || labelled || group.innerText) || `行${i + 1}`;
  }

  // グリッドなら「行：選んだ列」の形で1行ずつ返す（グリッドでなければ null）
  function readGrid(item) {
    const groups = [...item.querySelectorAll('[role="radiogroup"],[role="group"]')]
      .filter(g => g.querySelector('[role="radio"],[role="checkbox"]'))
      .filter((g, _, all) => !all.some(o => o !== g && g.contains(o))); // 入れ子になっていたら内側だけ使う
    if (groups.length < 2) return null;
    return groups.map((g, i) => {
      const picked = [...g.querySelectorAll(CHECKED)].map(choiceValue).filter(Boolean);
      return `${rowLabel(g, i)}：${picked.length ? picked.join('、') : '（未回答）'}`;
    });
  }

  const TEXT_INPUTS = 'input[type="text"],input[type="email"],input[type="url"],input[type="tel"],input[type="date"],input[type="time"],textarea';
  const OTHER = '__other_option__';

  // グリッド以外の質問の回答を読む
  function readAnswer(item) {
    const vals = [];
    const choices = [...item.querySelectorAll('[role="radio"],[role="checkbox"]')];

    if (choices.length) {
      // 選択式：選んだ選択肢を順番どおりに（「その他」は記入欄の内容を添える）
      const otherText = clean([...item.querySelectorAll(TEXT_INPUTS)].map(el => el.value).join(' '));
      choices.filter(el => el.getAttribute('aria-checked') === 'true').forEach(el => {
        const raw = el.getAttribute('data-value') ?? el.getAttribute('data-answer-value');
        vals.push(raw === OTHER ? (otherText ? `その他：${otherText}` : 'その他') : choiceValue(el));
      });
    } else {
      // 記述式・段落・日付など（段落の改行はそのまま残す）
      item.querySelectorAll(TEXT_INPUTS).forEach(el => { if (el.value.trim()) vals.push(el.value.trim()); });
    }

    // 時刻・所要時間など、数字の欄が並ぶもの（例：時・分 → 09:05）
    const nums = [...item.querySelectorAll('input[type="number"]')];
    if (nums.length && nums.some(el => el.value !== '')) {
      vals.push(nums.length > 1 ? nums.map(el => el.value.padStart(2, '0')).join(':') : nums[0].value);
    }

    // プルダウン（未選択の「選択」は data-value が空なので除外される）
    item.querySelectorAll('[role="option"][aria-selected="true"]').forEach(el => {
      const v = clean(el.getAttribute('data-value'));
      if (v) vals.push(v);
    });
    return vals;
  }

  // ---- 画面上の回答を読む ----
  function readQuestions() {
    const out = {};
    document.querySelectorAll('div[role="listitem"]').forEach(item => {
      const h = item.querySelector('[role="heading"]');
      if (!h || !hasControl(item)) return; // 見出しだけ・説明だけの項目は除外
      const title = clean(h.textContent).replace(/\s*\*$/, '');
      const grid = readGrid(item);
      if (grid) { if (title) out[title] = grid; return; }
      if (title) out[title] = readAnswer(item);
    });
    return out;
  }

  // ---- 下書き（同じタブ内でページをまたいで保持）----
  function loadDraft() {
    try {
      const d = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (d && Date.now() - new Date(d.updatedAt).getTime() > DRAFT_TTL_MS) { sessionStorage.removeItem(KEY); return null; }
      return d;
    } catch { return null; }
  }
  function save() {
    const cur = readQuestions();
    if (!Object.keys(cur).length) return;
    const d = loadDraft() || {
      title: clean(document.title.replace(/\s*-\s*Google\s*(フォーム|Forms).*$/i, '')),
      url: location.origin + path.replace(/\/formResponse\b/, '/viewform'),
      answers: {},
    };
    Object.assign(d.answers, cur); // 複数ページのフォームは各ページ分を足していく
    d.updatedAt = new Date().toISOString();
    try { sessionStorage.setItem(KEY, JSON.stringify(d)); } catch {}
  }

  let timer;
  document.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 300); }, true);
  document.addEventListener('change', save, true);
  document.addEventListener('click', () => { save(); setTimeout(save, 80); }, true); // 「送信」「次へ」を押した瞬間も控える
  window.addEventListener('pagehide', save);

  // ---- 送信完了画面の検出 ----
  const isDone = () => /\/formResponse\b/.test(location.pathname) &&
    ![...document.querySelectorAll('div[role="listitem"]')].some(hasControl);

  let sent = false;
  function check() {
    if (sent || !isDone()) return;
    const d = loadDraft();
    if (!d) return;
    sent = true;
    sessionStorage.removeItem(KEY);
    d.submittedAt = new Date().toISOString();
    d.confirmText = clean(document.body.innerText).slice(0, 300);
    chrome.runtime.sendMessage({ type: 'receipt', data: d }, res => {
      if (chrome.runtime.lastError || !res) return toast('Form Receipt：拡張機能と通信できませんでした', true);
      if (res.ok && res.local) toast('回答の控えを履歴に保存しました');
      else if (res.ok) toast('回答の控えを送信しました');
      else toast('控えの送信に失敗（' + res.error + '）。履歴には保存済みで、設定画面から再送できます', true);
    });
  }
  check();
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });

  function toast(msg, err) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:10px 14px;border-radius:10px;
      font:14px/1.5 system-ui,sans-serif;color:#fff;background:${err ? '#c0392b' : '#1f6feb'};box-shadow:0 4px 14px rgba(0,0,0,.2)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
})();
