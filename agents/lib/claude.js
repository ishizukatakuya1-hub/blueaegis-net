'use strict';
/**
 * Claude Messages API の最小クライアント（Node 20 標準の fetch のみ）。
 *
 * 公式SDKではなく fetch を使うのは、このリポジトリが依存パッケージを持たない方針のため
 * （blueaegis-site と同じ。自動掲載の経路に供給網の攻撃面を持ち込まない）。
 *
 * - APIキーは環境変数 ANTHROPIC_API_KEY からのみ読む。ファイル・ログには書かない。
 * - 既定モデルは claude-opus-5。環境変数 BA_MODEL で上書きできる。
 * - 安全分類器による辞退（stop_reason: "refusal"）に備え、server-side fallback を有効にしている。
 * - Web検索（サーバーツール）が反復上限に達したとき（pause_turn）は、そのまま再送して続きを受け取る。
 */

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.BA_MODEL || 'claude-opus-5';
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESUME = 5;

const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 8 };

function hasKey() { return Boolean(process.env.ANTHROPIC_API_KEY); }

async function post(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error ? `${json.error.type}: ${json.error.message}` : `HTTP ${res.status}`;
    const err = new Error(`Claude API エラー（${res.status}）${msg}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return json;
}

/**
 * 1回の依頼。戻り値は { text, sources, usage }。
 * sources は Web検索で得たURL（出典候補。本文で使うかは人と fact-checker が判断する）。
 */
async function ask({ system, prompt, webSearch = false, effort = 'high', maxTokens = 16000 }) {
  if (!hasKey()) throw new Error('ANTHROPIC_API_KEY が設定されていません（--dry-run で実行してください）');

  const messages = [{ role: 'user', content: prompt }];
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    fallbacks: 'default',
    messages,
    ...(webSearch ? { tools: [WEB_SEARCH] } : {}),
  };

  let res;
  for (let i = 0; ; i++) {
    res = await withRetry(() => post(body));
    if (res.stop_reason !== 'pause_turn' || i >= MAX_RESUME) break;
    messages.push({ role: 'assistant', content: res.content });   // 追記のみ（履歴は書き換えない）
  }

  if (res.stop_reason === 'refusal') {
    const cat = res.stop_details && res.stop_details.category;
    throw new Error(`モデルが依頼を辞退しました（category: ${cat || '不明'}）。依頼内容を見直してください`);
  }
  if (res.stop_reason === 'max_tokens') throw new Error('出力が上限で途切れました。対象を小さく分けてください');

  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const sources = [];
  for (const b of res.content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) sources.push({ title: r.title, url: r.url });
    }
  }
  return { text, sources, usage: res.usage };
}

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (!e.retryable || i >= tries) throw e;
      await new Promise(r => setTimeout(r, 2000 * i * i));
    }
  }
}

/** 応答の最後にある JSON（```json ... ``` か素の {...}）を取り出す */
function lastJson(text) {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = fenced.length ? fenced[fenced.length - 1][1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch (e) { throw new Error(`JSON を読み取れませんでした: ${e.message}`); }
}

module.exports = { ask, hasKey, lastJson, MODEL };
