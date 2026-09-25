#!/usr/bin/env node
/**
 * Blue Aegis アフィリエイトメディア（blueaegis.net）のビルド
 *
 * blueaegis-site/tools/build.js から派生。外部ライブラリに依存しない。
 *
 *   node tools/build.js                  ビルド（_site/ を生成。検査で落ちたら配信しない）
 *   node tools/build.js --validate-only  記事の検証のみ（PRのCIで使用）
 *   node tools/build.js --drafts         下書きも出力する（ローカル確認専用。noindex と「下書き」帯が付く）
 *
 * 記事の規約は PUBLISHING.md を正とする。ここを変えたら向こうも直すこと。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const seo = require('./lib/seo');
const aff = require('./lib/affiliate');
const { ogCard, logoPng } = require('./lib/ogimage');
const { audit } = require('./lib/audit');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(ROOT, '_site');
const VALIDATE_ONLY = process.argv.includes('--validate-only');
const WITH_DRAFTS = process.argv.includes('--drafts');

const { BASE, CONFIG, CATEGORIES } = seo;
const CATS = Object.keys(CATEGORIES);
const SUFFIX = `｜${CONFIG.siteName}`;

const TAG_PAGE_MIN = 3;
const RELATED_MAX = 3;
const HOME_LATEST = 9;

/* ビルド出力に含めない。直下の .md / .json は社内向けなので配信しない */
const SKIP = new Set(['content', 'tools', 'agents', 'data', 'docs', 'queue', '_site', 'node_modules',
                      '.git', '.github', '.claude', 'package.json', 'package-lock.json']);
const SKIP_TOP = /\.(md|json)$/i;

const errors = [];
const warnings = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

/* ---------------- frontmatter（blueaegis-site と同じ簡易YAML） ---------------- */
function parseFrontmatter(raw, file) {
  raw = raw.replace(/\r\n/g, '\n');
  if (!raw.startsWith('---')) { fail(file, 'frontmatter が見つかりません'); return [null, raw]; }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) { fail(file, 'frontmatter が閉じられていません'); return [null, raw]; }
  const head = raw.slice(4, end);
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);

  const data = {};
  let listKey = null, listItem = null;
  for (const line of head.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (t.startsWith('- ')) {
      if (!listKey) { fail(file, `対応するキーのないリスト要素: ${t}`); continue; }
      listItem = {};
      data[listKey].push(listItem);
      const rest = t.slice(2).trim();
      if (rest) { const [k, v] = splitKV(rest); if (k) listItem[k] = v; }
      continue;
    }
    const [k, v] = splitKV(t);
    if (!k) continue;
    if (indent > 0 && listItem) { listItem[k] = v; continue; }
    listItem = null;
    if (v === '') { listKey = k; data[k] = []; } else { listKey = null; data[k] = v; }
  }
  return [data, body];
}

function splitKV(s) {
  const i = s.indexOf(':');
  if (i === -1) return [null, null];
  const k = s.slice(0, i).trim();
  let v = s.slice(i + 1).trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map(x => unquote(x.trim())).filter(Boolean);
  else if (v === 'true' || v === 'false') v = v === 'true';
  else v = unquote(v);
  return [k, v];
}
const unquote = s => (typeof s === 'string' && /^(".*"|'.*')$/.test(s)) ? s.slice(1, -1) : s;

/* ---------------- 検証 ---------------- */
const FILENAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

function validate(cat, file, fm, body, catalog) {
  const at = `${cat}/${file}`;
  const m = FILENAME.exec(file);
  if (!m) { fail(at, 'ファイル名は YYYY-MM-DD-slug.md 形式（slug は英小文字・数字・ハイフン）'); return null; }
  const [, fileDate, slug] = m;
  if (!fm) return null;

  for (const key of ['title', 'date', 'description', 'author']) if (!fm[key]) fail(at, `frontmatter に ${key} がありません`);
  if (fm.date && String(fm.date) !== fileDate) fail(at, `date（${fm.date}）とファイル名の日付（${fileDate}）が一致しません`);
  if (!Array.isArray(fm.tags) || fm.tags.length === 0) fail(at, 'tags が空です');
  if (typeof fm.pr !== 'boolean') fail(at, 'pr: true / false を必ず書くこと（広告を含むかの宣言）');

  if (!Array.isArray(fm.sources) || fm.sources.length === 0) {
    fail(at, 'sources がありません。出典の明記は必須です');
  } else {
    if (!fm.sources.some(s => s.type === 'primary')) fail(at, 'sources に type: primary（一次出典）が1件もありません');
    fm.sources.forEach((s, i) => {
      for (const key of ['type', 'publisher', 'title', 'url']) if (!s[key]) fail(at, `sources[${i}] に ${key} がありません`);
      if (s.url && !/^https?:\/\//.test(s.url)) fail(at, `sources[${i}] の url が不正です`);
      if (s.type && !['primary', 'secondary'].includes(s.type)) fail(at, `sources[${i}] の type は primary か secondary`);
    });
  }

  aff.checkLinks(at, fm, body, catalog, fail, warn);

  /* 【要確認】が残った原稿は公開させない（推測で埋めない運用の最後の砦） */
  if (fm.draft !== true && /【要確認】/.test(body)) fail(at, '【要確認】が残っています。確認して埋めるか削除すること');

  for (const f of aff.lint(`${fm.title}\n${fm.description}\n${body}`)) {
    (f.sev === 'error' ? fail : warn)(at, `${f.reason}「${f.hit}」（${f.basis}）`);
  }

  const text = body.replace(/\s/g, '');
  if (text.length < 800) warn(at, `本文が短い（約${text.length}字。目安1,500〜3,000字）`);
  if (text.length > 6000) warn(at, `本文が長い（約${text.length}字）`);
  if (/^#\s/m.test(body)) fail(at, '本文の見出しは H2（##）から。H1 は title から生成されます');
  if (fm.title) {
    const w = seo.displayWidth(`${fm.seoTitle || fm.title}${SUFFIX}`);
    if (w > 68) warn(at, `検索結果に出る title が長い（表示幅 ${w}／目安 68）。seoTitle で短い版を持てます`);
  }
  if (fm.description) {
    const w = seo.displayWidth(fm.description);
    if (w > 200) warn(at, `description が長い（表示幅 ${w}／目安 200）`);
    if (w < 70) warn(at, `description が短い（表示幅 ${w}／目安 70 以上）`);
  }
  return { slug, date: fileDate };
}

/* ---------------- Markdown（規約で許す範囲のみ） ---------------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\(((?:\.\.\/|\/)?[a-z0-9/-]+\.html(?:#[a-z0-9-]+)?)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[^"=>])\b(https?:\/\/[^\s<]+)/g, '$1<a href="$2" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdown(md, file) {
  const out = [];
  for (const raw of md.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split('\n');
    if (/^###\s/.test(block)) { out.push(`<h3>${inline(block.replace(/^###\s+/, ''))}</h3>`); continue; }
    if (/^##\s/.test(block))  { out.push(`<h2>${inline(block.replace(/^##\s+/, ''))}</h2>`); continue; }
    if (lines.every(l => /^>\s?/.test(l))) { out.push(`<blockquote>${inline(lines.map(l => l.replace(/^>\s?/, '')).join(' '))}</blockquote>`); continue; }
    if (lines.every(l => /^[-*]\s+/.test(l))) { out.push('<ul>' + lines.map(l => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('') + '</ul>'); continue; }
    if (lines.every(l => /^\d+\.\s+/.test(l))) { out.push('<ol>' + lines.map(l => `<li>${inline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('') + '</ol>'); continue; }
    if (lines.length >= 2 && lines.every(l => l.includes('|')) && /^[\s|:-]+$/.test(lines[1])) {
      const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      out.push('<div class="scroller"><table><tr>' + cells(lines[0]).map(c => `<th>${c}</th>`).join('') + '</tr>'
        + lines.slice(2).map(cells).map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table></div>');
      continue;
    }
    if (/^(#{1,6})\s/.test(block)) { fail(file, `対応していない見出し記法: ${block.slice(0, 20)}`); continue; }
    out.push(`<p>${inline(lines.join('\n'))}</p>`);
  }
  return out.join('\n  ');
}

/* ---------------- ページの型 ---------------- */
const LOGO = `<svg viewBox="0 0 380 130" role="img" aria-label="${esc(CONFIG.siteName)}">
        <defs>
          <path id="sh1" d="M60 8 L108 26 V62 C108 92 88 116 60 134 C32 116 12 92 12 62 V26 Z"/>
          <clipPath id="cl1"><use href="#sh1"/></clipPath>
        </defs>
        <g transform="translate(0,6) scale(0.82)">
          <g clip-path="url(#cl1)">
            <rect x="0" y="8" width="120" height="22" fill="#0A2A4F"/>
            <rect x="0" y="36" width="120" height="22" fill="#0A2A4F"/>
            <rect x="0" y="64" width="120" height="22" fill="#4FB3D9"/>
            <rect x="0" y="92" width="120" height="22" fill="#0A2A4F"/>
            <rect x="0" y="120" width="120" height="20" fill="#0A2A4F"/>
          </g>
        </g>
        <text x="110" y="68" font-family="Arial,Helvetica,sans-serif" font-size="44" font-weight="bold" letter-spacing="-1" fill="#0A2A4F">blue<tspan fill="#1E5FA8">aegis</tspan></text>
        <text x="112" y="97" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="bold" letter-spacing="5.5" fill="#0A2A4F">GUIDE</text>
      </svg>`;

const ANALYTICS = CONFIG.analyticsToken
  ? `<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${esc(CONFIG.analyticsToken)}"}'></script><!-- End Cloudflare Web Analytics -->`
  : '';

const PR_NOTICE = `<p class="prnotice">本記事には広告（アフィリエイトリンク）が含まれます。詳しくは<a href="../ad-policy.html">広告掲載ポリシー</a>をご覧ください。</p>`;
const DRAFT_BANNER = `<p class="draftbanner">下書き（ローカル確認用）。公開ビルドには含まれません。</p>`;

/** up はサイト直下までの相対（'../' など）。404 だけは '/' */
function page({ title, description, canonical, ogType, main, up = '../', robots }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robots ? `<meta name="robots" content="${robots}">\n` : ''}<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${canonical}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="${up}favicon.svg" type="image/svg+xml">
<script>document.documentElement.classList.add('js')</script>
<link rel="stylesheet" href="${up}style.css">
</head>
<body>

<header>
  <div class="wrap headbar">
    <a href="${up || './'}index.html" style="display:block">
      ${LOGO}
    </a>
    <nav>
${CATS.map(c => `      <a href="${up}${c}/index.html">${esc(CATEGORIES[c].name)}</a>`).join('\n')}
    </nav>
  </div>
</header>

${main}

<footer>
  <div class="wrap">
    <div>© 2026 Blue Aegis Inc.　運営：<a href="${esc(CONFIG.operator.corporateSite)}" rel="noopener">${esc(CONFIG.operator.legalName)}</a></div>
    <div class="legal">
      <a href="${up}about.html">運営者情報</a>
      <a href="${up}ad-policy.html">広告掲載ポリシー</a>
      <a href="${up}privacy.html">プライバシーポリシー</a>
      <a href="${up}disclaimer.html">免責事項</a>
    </div>
  </div>
</footer>

<script src="${up}script.js"></script>
${ANALYTICS}
</body>
</html>
`;
}

function sourcesHtml(sources) {
  const group = (type, label) => {
    const list = (sources || []).filter(s => s.type === type);
    if (!list.length) return '';
    return `<p><strong>${label}</strong></p>\n    <ul>` + list.map(s =>
      `<li>${esc(s.publisher)}「${esc(s.title)}」${s.published ? `（${esc(String(s.published))}）` : ''}<br>` +
      `<a href="${esc(s.url)}" rel="noopener">${esc(s.url)}</a></li>`).join('') + '</ul>';
  };
  return group('primary', '一次出典') + group('secondary', '参考');
}

function tagSlug(tag) {
  return /^[\x20-\x7E]+$/.test(tag) ? tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : tag;
}

function tagLine(tags, tagPages) {
  return (tags || []).map(x => tagPages.has(x)
    ? `<a href="../tags/${encodeURIComponent(tagSlug(x))}.html">${esc(x)}</a>` : esc(x)).join('・');
}

function articleHtml(post, tagPages, catalog) {
  const isDraft = post.fm.draft === true;
  const body = aff.expand(post.html, catalog);
  return page({
    title: `${post.fm.seoTitle || post.fm.title}${SUFFIX}`,
    description: post.fm.description || '',
    canonical: `${BASE}/${post.cat}/${post.slug}.html`,
    ogType: 'article',
    robots: isDraft ? 'noindex' : null,
    main: `<main class="wrap article">
  ${isDraft ? DRAFT_BANNER : ''}<p class="kicker">${esc(CATEGORIES[post.cat].name)}</p>
  <h1>${esc(post.fm.title)}</h1>
  <p class="meta">${esc(post.date)}${post.fm.updated ? `（更新 ${esc(post.fm.updated)}）` : ''}　${tagLine(post.fm.tags, tagPages)}</p>
  ${post.fm.pr ? PR_NOTICE : ''}

  ${body}

  <div class="source">
    ${sourcesHtml(post.fm.sources)}
    <p>本記事は公表資料と運営者の確認できた範囲に基づく整理であり、法的・税務的な助言ではありません。料金・仕様は変わることがあるため、お申し込み前に必ず各社の公式情報をご確認ください。</p>
  </div>

  <p class="backlink"><a href="index.html">← ${esc(CATEGORIES[post.cat].name)}の記事一覧へ</a></p>
</main>`,
  });
}

function postListHtml(posts, hrefOf) {
  return posts.map(p => `      <li>
        <a href="${hrefOf(p)}">
          <span class="date">${esc(p.date)}　${esc(CATEGORIES[p.cat].name)}${p.fm.pr ? '　<span class="prmark">PR</span>' : ''}</span>
          <h3>${esc(p.fm.title)}</h3>
          <p>${esc(p.fm.description || '')}</p>
        </a>
      </li>`).join('\n');
}

function categoryHtml(cat, posts) {
  const c = CATEGORIES[cat];
  return page({
    title: `${c.name}の記事${SUFFIX}`,
    description: c.desc,
    canonical: `${BASE}/${cat}/`,
    ogType: 'website',
    main: `<section>
  <div class="wrap">
    <h1 class="lead">${esc(c.name)}</h1>
    <p class="intro">${esc(c.desc)}</p>
    <ul class="postlist">
${postListHtml(posts, p => `${p.slug}.html`) || '      <li><p style="padding:28px 0">まだ記事がありません。</p></li>'}
    </ul>
  </div>
</section>`,
  });
}

function tagPageHtml(tag, posts) {
  return page({
    title: `${tag}の記事${SUFFIX}`,
    description: `${tag}に関する記事を新しい順に並べています。いずれも一次資料に当たって確かめた事実をもとに書いた、${CONFIG.siteName}の記事です。`,
    canonical: `${BASE}/tags/${encodeURIComponent(tagSlug(tag))}.html`,
    ogType: 'website',
    main: `<section>
  <div class="wrap">
    <h1 class="lead">${esc(tag)}</h1>
    <ul class="postlist">
${postListHtml(posts, p => `../${p.cat}/${p.slug}.html`)}
    </ul>
  </div>
</section>`,
  });
}

function homeHtml(all) {
  const cards = CATS.map(c => `      <a class="card" href="${c}/index.html">
        <h3>${esc(CATEGORIES[c].name)}</h3>
        <p>${esc(CATEGORIES[c].desc)}</p>
      </a>`).join('\n');
  return page({
    up: '',
    title: `${CONFIG.siteName}｜${CONFIG.shortTagline}`,
    description: `${CONFIG.tagline}。運営は知的財産と規制対応技術を扱う Blue Aegis株式会社。広告を含む記事には冒頭に明記しています。`,
    canonical: `${BASE}/`,
    ogType: 'website',
    main: `<section>
  <div class="wrap">
    <h1 class="lead">${esc(CONFIG.siteName)}</h1>
    <p class="intro">${esc(CONFIG.tagline)}。</p>
    <div class="cards">
${cards}
    </div>
    <h2>新着記事</h2>
    <ul class="postlist">
${postListHtml(all.slice(0, HOME_LATEST), p => `${p.cat}/${p.slug}.html`) || '      <li><p style="padding:28px 0">まだ記事がありません。</p></li>'}
    </ul>
  </div>
</section>`,
  });
}

function staticPageHtml(slug, fm, html) {
  return page({
    up: '',
    title: `${fm.title}${SUFFIX}`,
    description: fm.description,
    canonical: `${BASE}/${slug}.html`,
    ogType: 'website',
    main: `<main class="wrap article">
  <h1>${esc(fm.title)}</h1>
  ${fm.updated ? `<p class="meta">最終更新 ${esc(fm.updated)}</p>` : ''}
  ${html}
</main>`,
  });
}

function notFoundHtml() {
  return page({
    up: '/', robots: 'noindex',
    title: `ページが見つかりません${SUFFIX}`,
    description: 'お探しのページは見つかりませんでした。',
    canonical: `${BASE}/404.html`, ogType: 'website',
    main: `<main class="wrap article">
  <h1>ページが見つかりません</h1>
  <p>URLが変わったか、削除された可能性があります。<a href="/index.html">トップページ</a>からお探しください。</p>
</main>`,
  });
}

/* ---------------- 静的ファイルの複製 ---------------- */
function copyDir(from, to, top = true) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (top && (SKIP.has(name) || SKIP_TOP.test(name))) continue;
    if (name.startsWith('.') && name !== '.nojekyll') continue;
    const s = path.join(from, name), d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, false);
    else fs.copyFileSync(s, d);
  }
}

function listHtml(dir, root = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listHtml(p, root, out);
    else if (name.endsWith('.html')) out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

/* ---------------- 仕上げ（全ページ共通の要素を足す） ---------------- */
const OG_KICKER = { saas: 'Back-office SaaS', ip: 'IP & Trademark', ai: 'AI & Business Tools', tags: 'Blue Aegis Guide', null: 'Blue Aegis Guide' };

function ogName(relPath) {
  const stem = relPath.replace(/\.html$/, '').replace(/\//g, '-');
  const safe = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (safe === stem) return `og/${stem}.png`;
  let h = 0x811c9dc5;
  for (let i = 0; i < stem.length; i++) { h ^= stem.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `og/${safe || 'page'}-${h.toString(36)}.png`;
}

function crumbsHtml(desc, cls) {
  const up = '../';
  const parts = [`<a href="${up}index.html">ホーム</a>`];
  if (CATEGORIES[cls.section]) parts.push(`<a href="index.html">${esc(CATEGORIES[cls.section].name)}</a>`);
  parts.push(`<span aria-current="page">${esc(desc.h1 || desc.title)}</span>`);
  return `<nav class="crumbs" aria-label="現在地">${parts.join('<span class="sep" aria-hidden="true">/</span>')}</nav>\n  `;
}

function relatedHtml(desc, siblings, tagsOf) {
  const mine = tagsOf(desc.relPath);
  const scored = siblings
    .filter(s => s.relPath !== desc.relPath)
    .map(s => ({ s, shared: mine.filter(t => tagsOf(s.relPath).includes(t)).length, date: seo.isoDate(s.metaLine) || '' }))
    .sort((a, b) => b.shared - a.shared || (a.date < b.date ? 1 : -1))
    .slice(0, RELATED_MAX);
  if (!scored.length) return '';
  const here = path.posix.dirname(desc.relPath);
  const items = scored.map(({ s, date }) => {
    const href = path.posix.relative(here, s.relPath).split('/').map(encodeURIComponent).join('/');
    return `      <li><a href="${href}">${date ? `<span class="date">${esc(date)}</span>` : ''}<span class="t">${esc(s.h1 || s.title)}</span></a></li>`;
  }).join('\n');
  return `<aside class="related">
    <h2>関連する記事</h2>
    <ul>
${items}
    </ul>
  </aside>

  `;
}

function finish(posts) {
  const buildDate = new Date();
  const files = listHtml(OUT).sort();
  const byPath = new Map(posts.map(p => [`${p.cat}/${p.slug}.html`, p]));
  const tagsOf = rel => (byPath.get(rel) ? byPath.get(rel).fm.tags || [] : []);

  const pages = files.map(rel => {
    const html = fs.readFileSync(path.join(OUT, rel), 'utf8');
    return { rel, html, desc: seo.describePage(html, rel), cls: seo.classify(rel) };
  });

  fs.mkdirSync(path.join(OUT, 'og'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'og', 'logo.png'), logoPng());

  const assetV = {};
  for (const file of ['style.css', 'script.js']) {
    assetV[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, file))).digest('hex').slice(0, 8);
  }
  const stampAssets = html => html.replace(/(href|src)="(\/|(?:\.\.\/)*)(style\.css|script\.js)"/g,
    (m, attr, up, file) => `${attr}="${up}${file}?v=${assetV[file]}"`);

  const sitemap = [];
  for (const pg of pages) {
    const { rel, desc, cls } = pg;
    let html = pg.html;
    const post = byPath.get(rel);
    const img = ogName(rel);
    fs.writeFileSync(path.join(OUT, img), ogCard({
      kicker: OG_KICKER[cls.section] || OG_KICKER.null,
      line: post ? post.date : '',
      seed: rel,
    }));

    if (cls.kind === 'article') {
      html = html.replace(/<main class="wrap article">\s*/, m => m + crumbsHtml(desc, cls));
      const siblings = pages.filter(p => p.cls.kind === 'article' && p.cls.section === cls.section).map(p => p.desc);
      const block = relatedHtml(desc, siblings, tagsOf);
      if (block) html = html.replace('<p class="backlink">', block + '<p class="backlink">');
    }

    html = stampAssets(html);
    html = seo.enhanceHead(html, desc, cls, {
      ogImage: `${BASE}/${img}`,
      datePublished: post ? post.date : null,
      dateModified: post ? post.fm.updated : null,
      author: post ? post.fm.author : null,
      keywords: post ? post.fm.tags : null,
    });
    fs.writeFileSync(path.join(OUT, rel), html);

    const noindex = /<meta name="robots" content="noindex"/.test(html);
    if (cls.kind !== 'notfound' && !noindex) {
      sitemap.push({ desc, lastmod: post ? (post.fm.updated || post.date) : seo.todayJst(buildDate) });
    }
  }

  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), seo.buildSitemap(sitemap));
  fs.writeFileSync(path.join(OUT, 'feed.xml'), seo.buildFeed(posts.filter(p => p.fm.draft !== true).map(p => ({
    title: p.fm.title, url: `${BASE}/${p.cat}/${p.slug}.html`, date: p.date,
    description: p.fm.description || '', categories: [CATEGORIES[p.cat].name, ...(p.fm.tags || [])],
  })), buildDate));
  fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${BASE}/sitemap.xml\n`);
  return pages.length;
}

/* ---------------- 実行 ---------------- */
function loadPosts(catalog) {
  const posts = [];
  let total = 0, drafts = 0;
  for (const cat of CATS) {
    const dir = path.join(CONTENT, cat);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse()) {
      total++;
      const [fm, body] = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'), `${cat}/${file}`);
      const meta = validate(cat, file, fm, body, catalog);
      if (!meta || !fm) continue;
      if (fm.draft === true) { drafts++; if (!WITH_DRAFTS) continue; }
      posts.push({ ...meta, cat, fm, html: renderMarkdown(body, `${cat}/${file}`) });
    }
  }
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { posts, total, drafts };
}

function loadPages() {
  const dir = path.join(CONTENT, 'pages');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const [fm, body] = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'), `pages/${file}`);
    if (!fm) continue;
    for (const key of ['title', 'description']) if (!fm[key]) fail(`pages/${file}`, `frontmatter に ${key} がありません`);
    out.push({ slug: file.replace(/\.md$/, ''), fm, html: renderMarkdown(body, `pages/${file}`) });
  }
  return out;
}

function main() {
  const catalog = aff.loadCatalog();
  const { posts, total, drafts } = loadPosts(catalog);
  const pages = loadPages();

  if (warnings.length) { console.log('警告:'); warnings.forEach(w => console.log('  ' + w)); }
  if (errors.length) { console.error('検証エラー:'); errors.forEach(e => console.error('  ' + e)); process.exit(1); }
  console.log(`記事 ${total} 件を検証（公開 ${total - drafts} / 下書き ${drafts}${WITH_DRAFTS ? '・下書きも出力' : ''}）`);
  if (VALIDATE_ONLY) { console.log('検証のみ。ビルドは行いません。'); return; }

  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(ROOT, OUT);

  const byTag = new Map();
  for (const p of posts) for (const t of p.fm.tags || []) { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(p); }
  const tagPages = new Map([...byTag].filter(([, l]) => l.length >= TAG_PAGE_MIN));

  for (const cat of CATS) {
    const dir = path.join(OUT, cat);
    fs.mkdirSync(dir, { recursive: true });
    const list = posts.filter(p => p.cat === cat);
    for (const p of list) fs.writeFileSync(path.join(dir, `${p.slug}.html`), articleHtml(p, tagPages, catalog));
    fs.writeFileSync(path.join(dir, 'index.html'), categoryHtml(cat, list));
  }
  if (tagPages.size) {
    fs.mkdirSync(path.join(OUT, 'tags'), { recursive: true });
    for (const [tag, list] of tagPages) fs.writeFileSync(path.join(OUT, 'tags', `${tagSlug(tag)}.html`), tagPageHtml(tag, list));
  }
  for (const pg of pages) fs.writeFileSync(path.join(OUT, `${pg.slug}.html`), staticPageHtml(pg.slug, pg.fm, pg.html));
  fs.writeFileSync(path.join(OUT, 'index.html'), homeHtml(posts));
  fs.writeFileSync(path.join(OUT, '404.html'), notFoundHtml());

  const count = finish(posts);
  console.log(`_site/ を生成（HTML ${count} ページ、タグ一覧 ${tagPages.size}）`);

  const result = audit(OUT);
  if (result.warnings.length) { console.log('検査の警告:'); result.warnings.forEach(w => console.log('  ' + w)); }
  if (result.errors.length) { console.error('検査エラー:'); result.errors.forEach(e => console.error('  ' + e)); process.exit(1); }
  console.log(`検査 ${result.count} ページ：問題なし`);
}

main();
