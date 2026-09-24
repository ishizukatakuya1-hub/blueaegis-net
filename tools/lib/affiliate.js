'use strict';
/**
 * アフィリエイトリンクの展開と、広告表示まわりの検査。
 *
 * 記事本文では {{aff:<id>}} と書き、URL は data/affiliates.json に1か所だけ持つ。
 * 案件の差し替えや終了で記事を1本ずつ直さずに済ませるためと、
 * リンクの属性（rel="sponsored"）と「PR」表記を人の手に委ねないため。
 *
 * 考え方は 模擬会社/事業開発部/メディア統合運用システム/lib/affiliate.js・compliance.js から移植。
 * 景表法のステマ告示（令和5年10月1日施行）に従い、広告であることを
 *   1. 記事冒頭（build.js が pr: true の記事に自動で入れる）
 *   2. リンクの直前（ここで入れる）
 * の2か所で示す。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CATALOG = path.join(ROOT, 'data', 'affiliates.json');
const GUARDRAILS = path.join(ROOT, 'guardrails.private.json');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TOKEN = /\{\{aff:([a-z0-9-]+)\}\}/g;

function loadCatalog() {
  if (!fs.existsSync(CATALOG)) return new Map();
  const list = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).programs || [];
  return new Map(list.map(p => [p.id, p]));
}

/** 本文に出てくる案件IDの一覧 */
function idsIn(md) {
  return [...String(md).matchAll(TOKEN)].map(m => m[1]);
}

/**
 * 検証。公開記事では、未登録のIDやURL未設定の案件を許さない。
 * 下書きでは警告にとどめる（ASP登録前でも原稿は書き進められるように）。
 */
function checkLinks(file, fm, body, catalog, fail, warn) {
  const ids = idsIn(body);
  if (ids.length && fm.pr !== true) {
    fail(file, 'アフィリエイトリンクがあるのに pr: true がありません（ステマ告示）');
  }
  for (const id of ids) {
    const p = catalog.get(id);
    const report = fm.draft === true ? warn : fail;
    if (!p) { report(file, `data/affiliates.json に案件 "${id}" がありません`); continue; }
    if (!p.url) report(file, `案件 "${id}" の url が未設定です（ASP登録後に記入）`);
    else if (!/^https:\/\//.test(p.url)) fail(file, `案件 "${id}" の url は https で始めること`);
    if (p.type === 'banner') {
      if (!/^https:\/\//.test(p.image || '')) fail(file, `バナー "${id}" の image は https で始めること`);
      if (!(p.width > 0 && p.height > 0)) fail(file, `バナー "${id}" に width / height がありません`);
      if (p.pixel && !/^https:\/\//.test(p.pixel)) fail(file, `バナー "${id}" の pixel は https で始めること`);
    }
    if (p.active === false) report(file, `案件 "${id}" は提携終了（active: false）です`);
  }
}

/** 描画後のHTMLでトークンをリンクに置き換える */
function expand(html, catalog) {
  return html.replace(TOKEN, (m, id) => {
    const p = catalog.get(id);
    if (!p || !p.url || p.active === false) {
      return `<span class="aff pending">${esc(p ? p.label : id)}（リンク準備中）</span>`;
    }
    /* バナーは画像の読み込み時点で提携先へ通信が発生する。プライバシーポリシーの
       「広告バナーと計測画像」の節と対応しているので、type: banner を増やすときは向こうも確認すること */
    if (p.type === 'banner') {
      const pixel = p.pixel ? `<img class="pxl" src="${esc(p.pixel)}" width="1" height="1" alt="">` : '';
      return `<span class="aff banner"><span class="prmark">PR</span><a href="${esc(p.url)}" rel="sponsored noopener" target="_blank">`
        + `<img src="${esc(p.image)}" width="${Number(p.width)}" height="${Number(p.height)}" alt="${esc(p.label)}" loading="lazy"></a>${pixel}</span>`;
    }
    return `<span class="aff"><span class="prmark">PR</span><a href="${esc(p.url)}" rel="sponsored noopener" target="_blank">${esc(p.label)}</a></span>`;
  });
}

/* ---------------- 表現の検査 ----------------
   compliance.js の規則のうち、アフィリエイト記事で起きやすいものに絞った。
   sev: 'error' はビルドを止める。'warn' は止めないが人が見る。 */

const SOURCE_RE = /(出典|参照|公式|調べ|https?:\/\/|（\d{4}年）|\(\d{4}年?\))/;

const RULES = [
  { sev: 'error', re: /(必ず|絶対に?|確実に|100%|１００％)(儲か|稼げ|得する|節税でき|通る|登録でき)/,
    reason: '断定的な効果・結果の保証', basis: '景表法5条1号（優良誤認）' },
  { sev: 'warn', fn: t => /(日本一|業界最安|最安値|No\.?\s?1|ナンバーワン|唯一の)/.test(t) && !SOURCE_RE.test(t),
    show: /(日本一|業界最安|最安値|No\.?\s?1|ナンバーワン|唯一の)/,
    reason: '最上級表現に根拠の記載がない', basis: '景表法5条1号・2号／消費者庁 No.1表示に関する実態調査報告書' },
  { sev: 'warn', re: /(通常価格|定価)[0-9０-９,，]+円(のところ|が).{0,8}[0-9０-９,，]+円/,
    reason: '二重価格表示（期間・条件の明示を確認）', basis: '景表法5条2号（有利誤認）／価格表示ガイドライン' },
  { sev: 'warn', re: /(今だけ|本日限り|残りわずか|先着\d+名)/,
    reason: '期限・数量の煽り（事実か確認）', basis: '景表法5条2号（有利誤認）' },
  { sev: 'warn', re: /(実際に使ってみた|使ってみました|導入しました|契約しました)/,
    reason: '体験の記述。一次記録（契約・請求書・画面）があるか確認', basis: '運用ルール（CLAUDE.md §体験の書き方）' },
];

function loadGuardrails() {
  if (!fs.existsSync(GUARDRAILS)) return null;
  return JSON.parse(fs.readFileSync(GUARDRAILS, 'utf8'));
}

/**
 * 本文の検査。戻り値は { sev, reason, basis, hit }[]。
 * guardrails.private.json（リポジトリに入れない）があれば、未出願分野などの禁止語も見る。
 */
function lint(text, guardrails = loadGuardrails()) {
  const t = String(text);
  const found = [];
  for (const r of RULES) {
    const hit = r.fn ? (r.fn(t) ? (r.show.exec(t) || [''])[0] : null) : ((r.re.exec(t) || [null])[0]);
    if (hit) found.push({ sev: r.sev, reason: r.reason, basis: r.basis, hit });
  }
  for (const term of (guardrails && guardrails.blockedTerms) || []) {
    if (term && t.includes(term)) {
      // 語そのものはログに出さない（ログも公開されうる）
      found.push({ sev: 'error', reason: '社内ガードレールの禁止語に該当', basis: 'guardrails.private.json', hit: '（非表示）' });
    }
  }
  return found;
}

module.exports = { loadCatalog, checkLinks, expand, idsIn, lint, loadGuardrails, TOKEN };
