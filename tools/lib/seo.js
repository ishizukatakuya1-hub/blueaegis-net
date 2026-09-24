'use strict';
/**
 * 検索・共有まわりの機械化（blueaegis-site/tools/lib/seo.js から派生）。
 *
 * サイト固有の値はすべて site.config.json から読む。ここに URL や社名を直書きしない。
 * 構造化データに載せてよいのは、そのページに表示されている事実だけ。
 * 運営者の代表者名・所在地は載せない（法人番号のみ可。blueaegis-site の 2026-08-28 判断に揃える）。
 */

const path = require('path');
const CONFIG = require(path.resolve(__dirname, '..', '..', 'site.config.json'));

const BASE = CONFIG.base.replace(/\/$/, '');
const CATEGORIES = CONFIG.categories;
const SITE = { ja: { name: CONFIG.siteName, locale: 'ja_JP', home: 'ホーム' } };

/* パンくずと画面表示で使う区分の名前 */
const SECTION = { ja: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.name])) };

/* ---------------- 文字まわり ---------------- */

const escAttr = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function unesc(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** 全角を2、半角を1として数える */
function displayWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += ch.codePointAt(0) > 0xFF ? 2 : 1;
  return n;
}

function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

/* ---------------- ページの読み取り ---------------- */

function firstMatch(re, s) { const m = re.exec(s); return m ? m[1] : null; }

function describePage(html, relPath) {
  const rel = relPath.replace(/\\/g, '/').replace(/(^|\/)index\.html$/, '$1');
  const url = BASE + '/' + rel.split('/').map(encodeURIComponent).join('/');

  const postlist = [];
  const reItem = /<li>\s*<a href="([^"]+)">[\s\S]*?<h3>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = reItem.exec(html)) !== null) postlist.push({ href: m[1], title: unesc(m[2]) });

  const sourceBlock = firstMatch(/<div class="source">([\s\S]*?)<\/div>/, html) || '';
  const citations = [];
  const reCite = /href="(https?:\/\/[^"]+)"/g;
  while ((m = reCite.exec(sourceBlock)) !== null) citations.push(m[1]);

  return {
    relPath: relPath.replace(/\\/g, '/'),
    url,
    lang: 'ja',
    title: unesc(firstMatch(/<title>([\s\S]*?)<\/title>/, html) || ''),
    ogTitle: unesc(firstMatch(/<meta property="og:title" content="([^"]*)"/, html) || ''),
    description: unesc(firstMatch(/<meta name="description" content="([^"]*)"/, html) || ''),
    canonical: firstMatch(/<link rel="canonical" href="([^"]+)"/, html),
    ogType: firstMatch(/<meta property="og:type" content="([^"]+)"/, html) || 'website',
    h1: unesc(firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/, html) || ''),
    metaLine: unesc(firstMatch(/<p class="meta">([\s\S]*?)<\/p>/, html) || ''),
    alternates: {},
    postlist,
    citations: [...new Set(citations)],
  };
}

function isoDate(text) {
  if (!text) return null;
  const pad = n => String(n).padStart(2, '0');
  let m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return m ? m[0] : null;
}

function dateTimeJst(isoDay) {
  return isoDay ? `${isoDay}T00:00:00+09:00` : null;
}

/** 日本時間での「今日」。toISOString() をそのまま使うと UTC で前日になる */
function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------------- ページの区分 ----------------
   /<category>/index.html = 領域ハブ、/<category>/<slug>.html = 記事、
   /tags/*.html = タグ一覧、それ以外は固定ページ。 */

function classify(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'index.html') return { kind: 'home', lang: 'ja', section: null };
  if (p === '404.html') return { kind: 'notfound', lang: 'ja', section: null };
  if (p.startsWith('tags/')) return { kind: 'collection', lang: 'ja', section: 'tags' };
  const [head, rest] = p.split('/');
  if (rest && CATEGORIES[head]) {
    return { kind: rest === 'index.html' ? 'collection' : 'article', lang: 'ja', section: head };
  }
  return { kind: 'page', lang: 'ja', section: null };
}

/* ---------------- 構造化データ ---------------- */

const ORG_ID = `${BASE}/#organization`;

/** 運営者。住所・代表者名は足さないこと */
function organization() {
  const op = CONFIG.operator;
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: op.legalName,
    legalName: op.legalName,
    alternateName: op.alternateName,
    url: op.corporateSite,
    email: op.email,
    identifier: { '@type': 'PropertyValue', propertyID: '法人番号', value: op.corporateNumber },
    logo: { '@type': 'ImageObject', url: `${BASE}/og/logo.png`, width: 512, height: 512 },
  };
}

function breadcrumbs(desc, cls) {
  const root = `${BASE}/`;
  const items = [{ name: SITE.ja.home, item: root }];
  if (CATEGORIES[cls.section]) items.push({ name: SECTION.ja[cls.section], item: `${root}${cls.section}/` });
  const selfIsSection = cls.kind === 'collection' && CATEGORIES[cls.section];
  if (!selfIsSection) items.push({ name: desc.h1 || desc.title, item: desc.canonical || desc.url });
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.item })),
  };
}

function structuredData(desc, cls, extra) {
  const graph = [organization()];

  graph.push({
    '@type': 'WebSite',
    '@id': `${BASE}/#website`,
    url: BASE + '/',
    name: SITE.ja.name,
    inLanguage: 'ja',
    publisher: { '@id': ORG_ID },
  });

  if (cls.kind !== 'notfound' && cls.kind !== 'home') graph.push(breadcrumbs(desc, cls));

  if (cls.kind === 'article') {
    const published = extra.datePublished || isoDate(desc.metaLine);
    graph.push({
      '@type': 'Article',
      '@id': desc.url + '#article',
      mainEntityOfPage: desc.url,
      url: desc.url,
      headline: desc.h1 || desc.title,
      description: desc.description,
      inLanguage: 'ja',
      isAccessibleForFree: true,
      ...(published ? { datePublished: dateTimeJst(published),
                        dateModified: dateTimeJst(extra.dateModified || published) } : {}),
      author: extra.author ? { '@type': 'Organization', name: extra.author, url: BASE + '/' } : { '@id': ORG_ID },
      publisher: { '@id': ORG_ID },
      image: { '@type': 'ImageObject', url: extra.ogImage, width: 1200, height: 630 },
      ...(extra.keywords && extra.keywords.length ? { keywords: extra.keywords.join(', ') } : {}),
      ...(desc.citations.length ? { citation: desc.citations.map(u => ({ '@type': 'CreativeWork', url: u })) } : {}),
    });
  }

  if (cls.kind === 'collection') {
    graph.push({
      '@type': 'CollectionPage',
      '@id': desc.url + '#collection',
      url: desc.url,
      name: desc.h1 || desc.title,
      description: desc.description,
      inLanguage: 'ja',
      isPartOf: { '@id': `${BASE}/#website` },
      ...(desc.postlist.length ? {
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: desc.postlist.length,
          itemListElement: desc.postlist.map((p, i) => ({
            '@type': 'ListItem', position: i + 1, name: p.title, url: new URL(p.href, desc.url).href,
          })),
        },
      } : {}),
    });
  }

  if (cls.kind === 'home') {
    graph.push({
      '@type': 'WebPage',
      '@id': desc.url + '#webpage',
      url: desc.url,
      name: desc.title,
      description: desc.description,
      inLanguage: 'ja',
      isPartOf: { '@id': `${BASE}/#website` },
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

/* ---------------- head への注入 ---------------- */

function enhanceHead(html, desc, cls, extra) {
  const add = [];
  const has = re => re.test(html);
  const site = SITE.ja;

  if (!has(/property="og:site_name"/)) add.push(`<meta property="og:site_name" content="${escAttr(site.name)}">`);
  if (!has(/property="og:locale"/))    add.push(`<meta property="og:locale" content="${site.locale}">`);

  if (!has(/property="og:image"/)) {
    add.push(`<meta property="og:image" content="${extra.ogImage}">`);
    add.push(`<meta property="og:image:width" content="1200">`);
    add.push(`<meta property="og:image:height" content="630">`);
    add.push(`<meta property="og:image:alt" content="${escAttr(site.name)}">`);
  }
  if (!has(/name="twitter:card"/)) {
    add.push(`<meta name="twitter:card" content="summary_large_image">`);
    add.push(`<meta name="twitter:title" content="${escAttr(desc.ogTitle || desc.title)}">`);
    add.push(`<meta name="twitter:description" content="${escAttr(desc.description)}">`);
    add.push(`<meta name="twitter:image" content="${extra.ogImage}">`);
  }

  if (cls.kind === 'article') {
    const published = extra.datePublished || isoDate(desc.metaLine);
    if (published && !has(/property="article:published_time"/)) {
      add.push(`<meta property="article:published_time" content="${dateTimeJst(published)}">`);
    }
    for (const t of extra.keywords || []) add.push(`<meta property="article:tag" content="${escAttr(t)}">`);
  }

  if (!has(/type="application\/rss\+xml"/)) {
    add.push(`<link rel="alternate" type="application/rss+xml" title="${escAttr(site.name)}" href="${feedUrl()}">`);
  }

  if (cls.kind !== 'notfound') add.push(jsonLd(structuredData(desc, cls, extra)));

  return html.replace('</head>', add.map(t => t + '\n').join('') + '</head>');
}

/* ---------------- サイトマップ・RSS ---------------- */

function buildSitemap(pages) {
  const entry = p => `  <url>\n    <loc>${p.desc.url}</loc>\n` +
    (p.lastmod ? `    <lastmod>${p.lastmod}</lastmod>\n` : '') + `  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    pages.map(entry).join('\n') + `\n</urlset>\n`;
}

function feedUrl() { return `${BASE}/feed.xml`; }

function buildFeed(items, buildDate) {
  const esc = s => escAttr(s);
  const body = items.map(it => `    <item>
      <title>${esc(it.title)}</title>
      <link>${it.url}</link>
      <guid isPermaLink="true">${it.url}</guid>
${it.date ? `      <pubDate>${new Date(`${it.date}T00:00:00+09:00`).toUTCString()}</pubDate>\n` : ''}      <description>${esc(it.description || '')}</description>
${(it.categories || []).map(t => `      <category>${esc(t)}</category>`).join('\n')}
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(CONFIG.siteName)}</title>
    <link>${BASE}/</link>
    <atom:link href="${feedUrl()}" rel="self" type="application/rss+xml"/>
    <description>${esc(CONFIG.tagline)}</description>
    <language>ja</language>
    <lastBuildDate>${buildDate.toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>
`;
}

module.exports = {
  CONFIG, BASE, SITE, SECTION, CATEGORIES,
  describePage, classify, structuredData, enhanceHead,
  buildSitemap, buildFeed, feedUrl, isoDate, dateTimeJst, todayJst, displayWidth, unesc, escAttr,
};
