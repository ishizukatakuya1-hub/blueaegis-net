# PUBLISHING.md — 記事の仕様（blueaegis.net）

記事を書く人・エージェントは毎回これを読む。仕様を変えたら `tools/build.js` の検証も直すこと。

## 置き場所とURL

```
content/saas/YYYY-MM-DD-<slug>.md   → https://blueaegis.net/saas/<slug>.html   バックオフィスSaaS
content/ip/YYYY-MM-DD-<slug>.md     → https://blueaegis.net/ip/<slug>.html     知財・商標サービス
content/ai/YYYY-MM-DD-<slug>.md     → https://blueaegis.net/ai/<slug>.html     AI・業務ツール
content/pages/<name>.md             → https://blueaegis.net/<name>.html        固定ページ
```

`<slug>` は英小文字・数字・ハイフンのみ。日付は公開日（JST）で、frontmatter の `date` と一致させる。未来の日付は検査で止まる。

## frontmatter

```yaml
---
title: "記事タイトル"
seoTitle: "検索結果用の短いタイトル"   # 任意
date: 2026-09-24
updated: 2026-10-01                    # 任意。料金・仕様を再確認したら更新
description: "検索結果に出る説明（全角35〜100字）"
tags: ["電子帳簿保存法", "会計ソフト"]
author: "Blue Aegis Guide 編集部"
pr: true                               # 必須。アフィリエイトリンクを含むなら true
draft: true                            # 任意。true の間は公開ビルドに載らない
sources:                               # 必須。type: primary を1件以上
  - type: primary
    publisher: "国税庁"
    title: "資料名"
    url: https://www.nta.go.jp/...
    published: 2024-01-01              # 任意
---
```

## 本文

- 見出しは `##` から（H1 は title から生成）。目安 1,500〜3,000字。
- 料金・仕様には確認日を添える（例:「2026年9月24日時点、公式サイトで確認」）。
- 確認できない事実は `【要確認】` と書く。残ったままでは公開ビルドが通らない。
- アフィリエイトリンクは `{{aff:<id>}}`。id は `data/affiliates.json`。公開記事では url 未設定の案件を使えない。
- 使える記法: 段落、`##`/`###`、箇条書き、番号付きリスト、表、引用、`**強調**`、リンク `[文字](https://...)`、サイト内リンク `[文字](../saas/xxx.html)`。

## 検証で止まるもの（抜粋）

frontmatter の欠落／一次出典なし／`pr` の宣言なし／affリンクがあるのに `pr: true` でない／url 未設定の案件（公開時）／`【要確認】` の残存（公開時）／断定的な効果保証の表現／社内ガードレールの禁止語／広告表示・PR表記・rel="sponsored" の欠落（出力HTMLで検査）
