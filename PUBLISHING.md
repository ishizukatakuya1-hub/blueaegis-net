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
- **運営者の視点は必須**（2026-09-29 ユーザー決定）。`## 運営者の視点` の節を1つ置き、120字以上書く（既存記事の「運営者の場合」「当媒体での使い方」も可）。中身は、`data/experience.json` に記録がある実体験、または運営者の判断とその理由。体験のように読める書き方で記録のない体験を書かない。**記録がないときに「購入した記録がありません」「台帳に記録がありません」「体験は書いていません」のような断り書きを書かない**（2026-10-09 ユーザー決定）。記録がなければ、断らずに判断と理由から書き始める。公開ビルドは、この節がないと止まる。
- 確認できない事実は `【要確認】` と書く。残ったままでは公開ビルドが通らない。
- アフィリエイトリンクは `{{aff:<id>}}`。id は `data/affiliates.json`。公開記事では url 未設定の案件を使えない。
- 使える記法: 段落、`##`/`###`、箇条書き、番号付きリスト、表、引用、`**強調**`、リンク `[文字](https://...)`、サイト内リンク `[文字](../saas/xxx.html)`。

## 写真と図解（2026-10-07 追加。意匠はコーポレートサイト blueaegis.co.jp に合わせる）

### 冒頭写真（任意）

frontmatter に4行を足すと、広告表示の下に、紺を重ねた写真の帯が出る。一覧にも小さく出る。

```yaml
hero: backup.webp                      # img/hero/ 直下のファイル名（英小文字・数字・ハイフン。jpg / png / webp）
heroAlt: "ノートパソコンの横に置かれた銀色の外付けドライブ"   # 写っているものをそのまま書く
heroCredit: "Siyuan Hu（Unsplash）"
heroCreditUrl: https://unsplash.com/photos/xEK3FiK6H3o
```

- 写真は **Unsplash License の無料写真だけ**（Unsplash+ は使わない）。`images.unsplash.com/<photo>?fm=webp&q=70&fit=crop&w=1280&h=720` で取得して `img/hero/` に同梱する。外部の画像を直接読み込まない（プライバシーポリシーに書いた通信先が増えるため）。
- **Unsplash の無料写真は、自動実行でも取得してよい**（2026-10-07 ユーザー決定）。条件は、写真ページのタイトルが「…Unsplashに収録の無料写真」であること、画像の URL が `images.unsplash.com/photo-…` で始まること（`premium_photo-` は Unsplash+）。確かめられなければ取得しない。Unsplash 以外から取得するときは、ユーザーの承認を得る。
- 人物の顔、他社の画面、記事の内容と食い違うものが写った写真は選ばない。

### 図解ブロック

本文の事実を並べ直して見せる部品。画像ではなく HTML で出る。ブロックの前後は空行、中には空行を入れない。

```
:::points キャプション（任意。出典を書く）
アイコン名 | 大きく見せる語（数値や一言） | 説明
:::

:::steps キャプション
見出し | 説明（省略可）
:::

:::compare キャプション
= 列の見出し | アイコン名（省略可）
- 項目
= 列の見出し | アイコン名
- 項目
:::
```

- points は2〜4行、steps は2〜6行、compare は2〜3列。
- アイコン名：`doc calendar shield drive cloud mail stamp yen check globe pen clock search alert building spark laptop link people x`
- **図解に書いてよいのは、その記事の本文にすでに書いてある事実だけ。** 条件付きの数値は条件も書く。広告リンク・商品の推奨は入れない。「運営者の視点」の節には入れない。
- 目安は、「## 結論」の節の最後に points を1つ。文章だけで手順や対比を説明している箇所があれば、steps か compare をもう1つ。すでに表やリストがある箇所には足さない。

## 検証で止まるもの（抜粋）

frontmatter の欠落／一次出典なし／`pr` の宣言なし／affリンクがあるのに `pr: true` でない／url 未設定の案件（公開時）／`【要確認】` の残存（公開時）／断定的な効果保証の表現／社内ガードレールの禁止語／広告表示・PR表記・rel="sponsored" の欠落（出力HTMLで検査）／hero の画像・説明・出どころの欠落／図解ブロックの書式の誤り・不明なアイコン名
