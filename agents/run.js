#!/usr/bin/env node
/**
 * 記事制作パイプライン（1機能＝1役割のエージェント）
 *
 *   node agents/run.js scout --cat saas                 候補出し   → queue/keywords-<cat>.json
 *   node agents/run.js brief --cat saas --pick 0        構成案     → queue/briefs/<slug>.md
 *   node agents/run.js draft --brief queue/briefs/x.md  下書き     → content/<cat>/<date>-<slug>.md（draft: true）
 *   node agents/run.js check --file content/saas/x.md   事実確認＋公開前点検 → queue/reports/<slug>.md
 *   node agents/run.js pipeline --cat saas              上の4段を続けて実行（候補の先頭を使う）
 *
 * 共通オプション:
 *   --dry-run   APIを呼ばず、組み立てたプロンプトと機械検査だけを出す（キー不要）
 *   --force     1領域1日1本の上限を超えて下書きを作る
 *
 * 公開はしない。下書きは必ず draft: true で作り、人がレビューして draft を外し、PRをマージして初めて公開される。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const claude = require('./lib/claude');
const aff = require('../tools/lib/affiliate');
const { CATEGORIES, todayJst } = require('../tools/lib/seo');

const ROOT = path.resolve(__dirname, '..');
const Q = path.join(ROOT, 'queue');
const PROMPTS = path.join(__dirname, 'prompts');
const EXPERIENCE = path.join(ROOT, 'data', 'experience.json');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const DRY = Boolean(opt('dry-run'));
const FORCE = Boolean(opt('force'));

const read = f => fs.readFileSync(f, 'utf8');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); console.log(`書き出し: ${path.relative(ROOT, f)}`); };
const log = (...a) => console.log('[agents]', ...a);

/** テンプレートの {{name}} を埋める。{{aff:...}} のような書式は触らない */
function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
const SYSTEM = read(path.join(PROMPTS, 'common.md'));
const prompt = (name, vars) => fill(read(path.join(PROMPTS, `${name}.md`)), vars);

function experienceText(cat) {
  if (!fs.existsSync(EXPERIENCE)) return '（なし）';
  const list = (JSON.parse(read(EXPERIENCE)).records || []).filter(r => !r.category || r.category === cat);
  return list.length ? list.map(r => `- ${r.date} ${r.fact}（記録: ${r.record}）`).join('\n') : '（なし）';
}

function existingTitles(cat) {
  const dir = path.join(ROOT, 'content', cat);
  if (!fs.existsSync(dir)) return 'なし';
  const titles = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
    .map(f => (/^title:\s*(.+)$/m.exec(read(path.join(dir, f))) || [])[1]).filter(Boolean);
  return titles.length ? titles.join(' / ') : 'なし';
}

async function call(name, vars, { webSearch = false, effort = 'high' } = {}) {
  const p = prompt(name, vars);
  if (DRY) {
    log(`--dry-run: ${name} のプロンプト（${p.length}字）`);
    console.log('-----\n' + p + '\n-----');
    return null;
  }
  log(`${name} を実行中（${claude.MODEL}${webSearch ? '・Web検索あり' : ''}）…`);
  return claude.ask({ system: SYSTEM, prompt: p, webSearch, effort });
}

function needCat() {
  const cat = opt('cat');
  if (!CATEGORIES[cat]) throw new Error(`--cat は ${Object.keys(CATEGORIES).join(' / ')} のいずれか`);
  return cat;
}

/* ---------------- 各エージェント ---------------- */

async function scout(cat) {
  const res = await call('scout', {
    category: CATEGORIES[cat].name, categoryDesc: CATEGORIES[cat].desc, existing: existingTitles(cat),
  }, { webSearch: true });
  if (!res) return null;
  const out = path.join(Q, `keywords-${cat}.json`);
  write(out, JSON.stringify({ category: cat, createdAt: todayJst(), ...claude.lastJson(res.text) }, null, 2));
  return out;
}

async function brief(cat, pick = 0) {
  const kwFile = path.join(Q, `keywords-${cat}.json`);
  let c = { keyword: '（dry-run の仮キーワード）', title: '（仮タイトル）', intent: '（仮）' };
  if (fs.existsSync(kwFile)) c = JSON.parse(read(kwFile)).candidates[pick] || c;
  else if (!DRY) throw new Error(`${path.relative(ROOT, kwFile)} がありません。先に scout を実行してください`);

  const res = await call('brief', { category: CATEGORIES[cat].name, ...c }, { webSearch: true });
  if (!res) return null;
  const meta = claude.lastJson(res.text);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.slug || '')) throw new Error(`slug が不正です: ${meta.slug}`);
  const out = path.join(Q, 'briefs', `${meta.slug}.md`);
  const searched = res.sources.map(s => `- ${s.title || ''} ${s.url}`).join('\n');
  write(out, `<!-- category: ${cat} -->\n<!-- meta: ${JSON.stringify({ ...meta, category: cat })} -->\n\n${res.text}\n\n## 検索で参照したページ（出典候補。一次資料かは人が確認）\n\n${searched || '（なし）'}\n`);
  return out;
}

function todaysDrafts(cat) {
  const dir = path.join(ROOT, 'content', cat);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith(todayJst())).length : 0;
}

async function draft(briefFile) {
  const text = briefFile && fs.existsSync(briefFile) ? read(briefFile) : null;
  if (!text && !DRY) throw new Error('--brief にブリーフのファイルを指定してください');
  const meta = text ? JSON.parse((/<!-- meta: (.+?) -->/.exec(text) || [])[1] || '{}') : { category: 'saas', slug: 'dry-run' };
  const cat = meta.category;

  /* 大量生成とみなされないための上限。検索エンジンのスパムポリシー（大量生成コンテンツ）への備え */
  if (!FORCE && todaysDrafts(cat) >= 1) throw new Error(`${cat} は今日すでに下書きがあります（1領域1日1本まで。--force で超過）`);

  const catalog = aff.loadCatalog();
  const affIds = [...catalog.values()].filter(p => p.category === cat).map(p => p.id).join(', ') || 'なし';
  const res = await call('draft', { brief: text || '（dry-run）', experience: experienceText(cat), today: todayJst(), affIds });
  if (!res) return null;

  const date = todayJst();
  const body = res.text.replace(/^```(?:markdown)?\s*|\s*```$/g, '').trim();
  const pr = aff.idsIn(body).length > 0;
  const q = s => `"${String(s).replace(/"/g, '\\"')}"`;
  const fm = [
    '---',
    `title: ${q(meta.title)}`,
    `date: ${date}`,
    `description: ${q(meta.description)}`,
    `tags: [${(meta.tags || []).map(q).join(', ')}]`,
    `author: ${q(require('../site.config.json').author)}`,
    `pr: ${pr}`,
    'draft: true',
    'sources:',
    ...(meta.sources || []).flatMap(s => [
      `  - type: ${s.type}`, `    publisher: ${q(s.publisher)}`, `    title: ${q(s.title)}`, `    url: ${s.url}`,
    ]),
    '---',
    '',
  ].join('\n');
  const out = path.join(ROOT, 'content', cat, `${date}-${meta.slug}.md`);
  if (fs.existsSync(out)) throw new Error(`${path.relative(ROOT, out)} は既にあります`);
  write(out, fm + body + '\n');
  return out;
}

/** 事実確認（fact-checker）と公開前点検（compliance-gate）。どちらかで止まれば終了コード1 */
async function check(file) {
  if (!file || !fs.existsSync(file)) throw new Error('--file に記事ファイルを指定してください');
  const article = read(file);
  const cat = path.basename(path.dirname(file));
  const slug = path.basename(file, '.md');
  const lines = [`# 点検レポート: ${slug}`, '', `実行日: ${todayJst()}　モデル: ${DRY ? '（dry-run）' : claude.MODEL}`, ''];
  let blocked = false;

  /* 1. 機械検査（ビルドの検証と同じもの） */
  lines.push('## 1. 機械検査');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.js'), '--validate-only'], { cwd: ROOT, stdio: 'pipe' });
    lines.push('- build.js --validate-only: 通過');
  } catch (e) {
    blocked = true;
    lines.push('- build.js --validate-only: **失敗**', '', '```', String(e.stdout || '') + String(e.stderr || ''), '```');
  }
  for (const f of aff.lint(article)) {
    if (f.sev === 'error') blocked = true;
    lines.push(`- [${f.sev}] ${f.reason}「${f.hit}」（${f.basis}）`);
  }
  if (!aff.loadGuardrails()) lines.push('- [warn] guardrails.private.json がありません。未出願分野の禁止語は検査されていません');
  const pending = (article.match(/【要確認/g) || []).length;
  if (pending) { blocked = true; lines.push(`- [error] 【要確認】が ${pending} か所残っています（公開ビルドで止まります）`); }

  /* 2. 事実確認 */
  const fc = await call('factcheck', { article, experience: experienceText(cat) }, { webSearch: true });
  lines.push('', '## 2. 事実確認（fact-checker）');
  if (fc) {
    const r = claude.lastJson(fc.text);
    lines.push(r.summary || '', '', '| 判定 | 主張 | 根拠 | 修正案 |', '|---|---|---|---|');
    for (const c of r.claims || []) {
      if (c.verdict !== 'ok') blocked = true;
      const cell = s => String(s || '').replace(/\|/g, '／').replace(/\n/g, ' ');
      lines.push(`| ${c.verdict} | ${cell(c.text)} | ${cell(c.evidence)} | ${cell(c.fix)} |`);
    }
  } else lines.push('（dry-run のため未実行）');

  /* 3. 公開前点検 */
  const gt = await call('gate', { article }, { effort: 'high' });
  lines.push('', '## 3. 公開前点検（compliance-gate）');
  if (gt) {
    const r = claude.lastJson(gt.text);
    if (r.decision !== 'pass') blocked = true;
    lines.push(`判定: **${r.decision}**`, '');
    for (const i of r.issues || []) lines.push(`- [${i.severity}] 「${i.quote}」 ${i.reason} → ${i.fix}`);
  } else lines.push('（dry-run のため未実行）');

  lines.push('', '## 結論', DRY
    ? '**未完了（dry-run）。** 事実確認と公開前点検は実行していません。APIキーを設定して再実行してください。'
    : blocked
    ? '**差し戻し。** 上の指摘を直してから、もう一度 check を実行してください。'
    : '機械検査・事実確認・公開前点検を通過。**人のレビュー**を経て draft: true を外し、PRでマージしてください。');
  write(path.join(Q, 'reports', `${slug}.md`), lines.join('\n') + '\n');
  if (blocked) process.exitCode = 1;
}

/* ---------------- 実行 ---------------- */
(async () => {
  try {
    if (!DRY && !claude.hasKey()) throw new Error('ANTHROPIC_API_KEY が未設定です。動作確認は --dry-run で行えます');
    if (cmd === 'scout') await scout(needCat());
    else if (cmd === 'brief') await brief(needCat(), Number(opt('pick') || 0));
    else if (cmd === 'draft') await draft(opt('brief'));
    else if (cmd === 'check') await check(opt('file'));
    else if (cmd === 'pipeline') {
      const cat = needCat();
      await scout(cat);
      const b = await brief(cat, 0);
      const d = await draft(b);
      if (d) await check(d);
      else if (DRY) log('--dry-run: check は記事ファイルがないため省略（check --file で個別に確認できます）');
    } else {
      console.log(read(__filename).split('*/')[0].replace(/^#!.*\n\/\*\*?/, ''));
    }
  } catch (e) {
    console.error(`[agents] ${e.message}`);
    process.exitCode = 1;
  }
})();
