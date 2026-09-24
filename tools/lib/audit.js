'use strict';
/**
 * 出来上がったサイトの検査。
 *
 * 検索と共有に効く要素が欠けていたり壊れていたりしたら、公開前に止める。
 * ここが通らない限り配信ワークフローは失敗するので、
 * 「いつの間にか canonical が消えていた」「リンクが切れていた」を
 * 人の目に頼らずに防げる。
 *
 * エラー＝配信を止める。警告＝直したほうがよいが止めない。
 */

const fs = require('fs');
const path = require('path');
const { describePage, classify, displayWidth, todayJst, BASE } = require('./seo');

/* 検索結果での見え方の目安（全角=2, 半角=1）。
   短すぎ・長すぎのどちらも取りこぼすので両側を見る。 */
const TITLE_MIN = 20, TITLE_MAX = 68;
const DESC_MIN  = 70, DESC_MAX  = 200;

/* 全ページのフッターから引く方針ページ。言語ごとに置き場が違う。
   フッターは手書きページと tools/build.js の page() の2経路にあるため、
   規制解説を手で足したときに実際ここが抜けた。人の目に頼らず止める。 */
const POLICY_PAGES = {
  ja: ['about.html', 'ad-policy.html', 'privacy.html', 'disclaimer.html'],
};

function listHtml(dir, root = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listHtml(p, root, out);
    else if (name.endsWith('.html')) out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

/** ページからの相対リンクを _site 起点のパスに直す。
 *  リンクは百分率符号化されているが、ファイル名は復号したものなので戻してから照合する。 */
function resolveLink(fromRel, href) {
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch (e) { /* 不正な符号化はそのまま照合して落とす */ }
  const base = path.posix.dirname('/' + fromRel);
  let p = decoded.startsWith('/') ? decoded : path.posix.normalize(path.posix.join(base, decoded));
  if (!p.startsWith('/')) p = '/' + p;
  if (p.endsWith('/')) p += 'index.html';
  return p.slice(1);
}

/**
 * フェードインの対象がCSSとJSでずれていないかを確かめる。
 *
 * style.css で opacity:0 にした要素に script.js が .in を付けなければ、
 * その要素は画面に出ないまま公開される。過去に一度これで全53要素が消えかけている。
 * CSS側は必ずJS側の部分集合でなければならない（JSが多いぶんには害がない）。
 */
function auditFadeSelectors(outDir, errors) {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');   // 注釈がセレクタに混ざらないように
  const css = strip(fs.readFileSync(path.join(outDir, 'style.css'), 'utf8'));
  const js = strip(fs.readFileSync(path.join(outDir, 'script.js'), 'utf8'));

  const block = /([^{}]*?)\{\s*opacity:0;\s*transform:translateY/.exec(css);
  if (!block) { errors.push('style.css: フェードインの初期状態を定めている規則が見つかりません'); return; }

  const hidden = block[1].split(',').map(s => s.trim().replace(/^\.js\s+/, '')).filter(Boolean);

  const decl = /var\s+SEL\s*=\s*((?:'[^']*'\s*\+?\s*)+);/.exec(js);
  if (!decl) { errors.push('script.js: フェードイン対象の SEL が見つかりません'); return; }

  const shown = new Set(
    (decl[1].match(/'[^']*'/g) || []).map(s => s.slice(1, -1)).join('')
      .split(',').map(s => s.trim()).filter(Boolean));

  for (const sel of hidden) {
    if (!shown.has(sel)) {
      errors.push(`style.css で隠している "${sel}" が script.js の対象に入っていません（表示されないまま公開されます）`);
    }
  }
}

/**
 * 広告表示の検査（景表法ステマ告示への備え）。出来上がったHTMLで見るので、
 * 記事の書き方や展開処理がどう変わっても、公開物そのものが基準を満たすかで判定できる。
 *   - 報酬が発生するリンク（rel に sponsored）が1本でもあれば、冒頭の広告表示が必須
 *   - その各リンクの直前に「PR」表記が必須
 *   - 展開されずに残った {{aff:...}} は不可
 *   - 既知のASPドメインへのリンクに sponsored が無いものは不可（手書きで直リンクを貼った場合）
 */
const ASP_HOSTS = /(px\.a8\.net|af\.moshimo\.com|ck\.jp\.ap\.valuecommerce\.com|t\.afi-b\.com|h\.accesstrade\.net|hb\.afl\.rakuten\.co\.jp|amzn\.to|amazon\.co\.jp\/[^"]*[?&]tag=)/;

function auditAffiliate(html, rel, errors) {
  const at = msg => `${rel}: ${msg}`;
  if (/\{\{aff:/.test(html)) errors.push(at('展開されていない {{aff:...}} が残っています'));

  const anchors = html.match(/<a\b[^>]*>/g) || [];
  const sponsored = anchors.filter(a => /rel="[^"]*sponsored/.test(a));
  for (const a of anchors) {
    const href = (/href="([^"]+)"/.exec(a) || [])[1] || '';
    if (ASP_HOSTS.test(href) && !/rel="[^"]*sponsored/.test(a)) {
      errors.push(at(`広告リンクに rel="sponsored" がありません: ${href.slice(0, 60)}`));
    }
  }
  if (!sponsored.length) return;
  if (!/<p class="prnotice">/.test(html)) errors.push(at('広告リンクがあるのに冒頭の広告表示（prnotice）がありません'));
  const marked = (html.match(/<span class="prmark">PR<\/span><a\b[^>]*rel="[^"]*sponsored/g) || []).length;
  if (marked < sponsored.length) errors.push(at(`広告リンク ${sponsored.length} 本のうち ${sponsored.length - marked} 本の直前に PR 表記がありません`));
}

function audit(outDir) {
  const errors = [];
  const warnings = [];
  const files = listHtml(outDir).sort();

  auditFadeSelectors(outDir, errors);

  const pages = new Map();      // relPath -> { html, desc, cls, ids }
  for (const rel of files) {
    const html = fs.readFileSync(path.join(outDir, rel), 'utf8');
    const ids = new Set();
    const reId = /\sid="([^"]+)"/g;
    let m;
    while ((m = reId.exec(html)) !== null) ids.add(m[1]);
    pages.set(rel, { html, desc: describePage(html, rel), cls: classify(rel), ids });
  }

  const seenTitle = new Map();
  const seenDesc = new Map();

  for (const [rel, page] of pages) {
    const { html, desc, cls } = page;
    const at = msg => `${rel}: ${msg}`;
    const skipIndexable = cls.kind === 'notfound';

    auditAffiliate(html, rel, errors);

    /* --- canonical --- */
    if (!skipIndexable) {
      if (!desc.canonical) errors.push(at('canonical がありません'));
      else if (desc.canonical !== desc.url) {
        errors.push(at(`canonical が自身のURLと違います（${desc.canonical} ≠ ${desc.url}）`));
      }
    }

    /* --- title / description --- */
    if (!desc.title) errors.push(at('title がありません'));
    if (!desc.description) errors.push(at('meta description がありません'));

    if (!skipIndexable && desc.title) {
      if (seenTitle.has(desc.title)) errors.push(at(`title が ${seenTitle.get(desc.title)} と重複しています`));
      else seenTitle.set(desc.title, rel);
      const w = displayWidth(desc.title);
      if (w > TITLE_MAX) warnings.push(at(`title が長い（表示幅 ${w}／目安 ${TITLE_MAX} 以内）`));
      if (w < TITLE_MIN) warnings.push(at(`title が短い（表示幅 ${w}／目安 ${TITLE_MIN} 以上）`));
    }
    if (!skipIndexable && desc.description) {
      if (seenDesc.has(desc.description)) errors.push(at(`description が ${seenDesc.get(desc.description)} と重複しています`));
      else seenDesc.set(desc.description, rel);
      const w = displayWidth(desc.description);
      if (w > DESC_MAX) warnings.push(at(`description が長い（表示幅 ${w}／目安 ${DESC_MAX} 以内）`));
      if (w < DESC_MIN) warnings.push(at(`description が短い（表示幅 ${w}／目安 ${DESC_MIN} 以上）`));
    }

    /* --- 見出し --- */
    const h1s = html.match(/<h1[\s>]/g) || [];
    if (h1s.length === 0 && cls.kind !== 'home' && cls.kind !== 'notfound') {
      warnings.push(at('h1 がありません'));
    }
    if (h1s.length > 1) errors.push(at(`h1 が ${h1s.length} 個あります（1個にすること）`));

    /* --- 画像の代替テキスト --- */
    const reImg = /<img\b[^>]*>/g;
    let im;
    while ((im = reImg.exec(html)) !== null) {
      if (!/\salt="/.test(im[0])) errors.push(at(`img に alt がありません: ${im[0].slice(0, 60)}`));
    }

    /* --- 構造化データが壊れていないか --- */
    const reLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let ld, ldCount = 0;
    while ((ld = reLd.exec(html)) !== null) {
      ldCount++;
      try { JSON.parse(ld[1].replace(/\\u003c/g, '<')); }
      catch (e) { errors.push(at(`構造化データが JSON として不正です: ${e.message}`)); }
    }
    if (!skipIndexable && ldCount === 0) errors.push(at('構造化データ（JSON-LD）がありません'));
    /* --- 掲載日が未来でないか ---
       未来日付は表示・JSON-LD・sitemap の lastmod・RSS の pubDate の4経路すべてに乗る。
       手書きの規制解説は frontmatter を持たないので build.js の検証を通らず、
       掲載日を見ている場所が他に無かった。実際、2026-09-05 に10本をまとめて足したとき、
       日付だけを2〜5日おきに未来へ振った6本がそのまま公開された。
       datePublished は finish() が全ページに入れるので、日英・手書き・生成の別なく
       ここ1か所で捕まえられる。予約公開の仕組みは無い（公開は push した時点で走る）。 */
    {
      const md = /"datePublished":"(\d{4}-\d{2}-\d{2})/.exec(html);
      if (md && md[1] > todayJst()) {
        errors.push(at(`掲載日が未来です（${md[1]}／今日 ${todayJst()}）。先の日付で予約公開はできない`));
      }
    }

    /* --- 共有カード --- */
    const og = /<meta property="og:image" content="([^"]+)"/.exec(html);
    if (!skipIndexable && !og) errors.push(at('og:image がありません'));
    if (og) {
      const local = og[1].startsWith(BASE) ? og[1].slice(BASE.length + 1) : null;
      if (local && !fs.existsSync(path.join(outDir, local))) {
        errors.push(at(`og:image のファイルがありません: ${local}`));
      }
    }

    /* --- リンク --- */
    const reHref = /(?:href|src)="([^"]+)"/g;
    const linked = new Set();
    let h;
    while ((h = reHref.exec(html)) !== null) {
      const raw = h[1];
      if (/^(https?:|mailto:|data:|tel:)/.test(raw)) continue;
      if (raw.startsWith('#')) {
        if (raw.length > 1 && !page.ids.has(raw.slice(1))) {
          warnings.push(at(`ページ内リンク先の id が見つかりません: ${raw}`));
        }
        continue;
      }
      const [pathPart, frag] = raw.split('#');
      if (!pathPart) continue;
      const target = resolveLink(rel, pathPart.split('?')[0]);
      if (!fs.existsSync(path.join(outDir, target))) {
        errors.push(at(`リンク切れ: ${raw} → ${target}`));
        continue;
      }
      linked.add(target);
      if (frag && target.endsWith('.html')) {
        const t = pages.get(target);
        if (t && !t.ids.has(frag)) warnings.push(at(`リンク先に id がありません: ${raw}`));
      }
    }

    /* --- 方針ページへの導線 ---
       同じ言語のプライバシーポリシーと免責事項へ、必ず1本は引けること。
       方針ページ自体が無い構成では課さない（消したなら、リンク切れの側で落ちる）。 */
    for (const target of POLICY_PAGES[cls.lang] || []) {
      if (!pages.has(target)) continue;
      if (!linked.has(target)) {
        errors.push(at(`${target} へのリンクがありません（フッターに入れること）`));
      }
    }

    /* --- 言語の相互宣言 --- */
    for (const [lg, href] of Object.entries(desc.alternates)) {
      if (lg === 'x-default') continue;
      if (!href.startsWith(BASE)) continue;
      const target = resolveLink('', href.slice(BASE.length + 1) || 'index.html');
      const t = pages.get(target.endsWith('/') ? target + 'index.html' : target);
      if (!t) { errors.push(at(`hreflang="${lg}" の指す先がありません: ${href}`)); continue; }
      if (t.desc.alternates[desc.lang] !== desc.url) {
        errors.push(at(`hreflang="${lg}" の相手（${target}）がこちらを指し返していません`));
      }
    }
  }

  return { errors, warnings, count: files.length };
}

module.exports = { audit };
