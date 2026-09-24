# CLAUDE.md — Blue Aegis Guide（blueaegis.net）

Blue Aegis株式会社のアフィリエイトメディア。**詳細の正本は `PUBLISHING.md`（記事の仕様）と `../blueaegis-net_private/docs/事業計画書.md`（事業。公開しないためリポジトリの外に置く）。**
ここには「読まずに触ると取り返しがつかないこと」だけを置く。

| 項目 | 値 |
|---|---|
| 公開URL（予定） | https://blueaegis.net/ |
| ビルド | `node tools/build.js` → `_site/`（検査込み。落ちたら配信されない） |
| ローカル確認 | `node tools/serve.js`（下書きも表示、port 4893） |
| エージェント | `node agents/run.js <scout|brief|draft|check|pipeline>`（`--dry-run` でAPIなし） |
| 依存 | **なし。Node.js 20 の標準ライブラリだけ。パッケージを増やさない** |

## ★書いてはいけないこと（blueaegis-site/CLAUDE.md §4 を継承）

1. **解決の仕組みを書かない。** 運営会社は特許出願を多数保有しており、公開した内容は将来の出願に対する先行技術になる。記事は規制・手続きの内容と事業者の課題まで。
2. **未出願案件の分野に触れない。** 分野名は `blueaegis-site/HANDOVER.private.md`。禁止語は `guardrails.private.json`（リポジトリに入れない）に `{"blockedTerms": [...]}` で置くと、ビルドとエージェントの両方が止める。**分野名をこのリポジトリのどこにも書かない。**
3. **一次資料で裏を取る。** 料金・仕様・条番号・施行日は公式資料で確認し、確認日を書く。確認できないことは書かない。`【要確認】` が残った記事は公開ビルドで止まる。
4. **体験を作らない。** 「使ってみた」「契約した」は `data/experience.json` に一次記録があるものだけ。
5. **トークン・パスワード・APIキーを受け取らない・書かない。** ASPの管理画面の操作やアカウント作成はユーザーが行う。
6. **代表者名・所在地を載せない。** 運営者表示は商号と法人番号のみ（blueaegis-site の 2026-08-28 判断に揃える）。

## 広告表示（景品表示法のステマ告示、令和5年10月1日施行）

- アフィリエイトリンクは本文に `{{aff:<id>}}` と書き、URL は `data/affiliates.json` にだけ置く。直リンクを手で貼らない。
- 広告を含む記事は frontmatter に `pr: true`。冒頭の広告表示と、リンク直前の「PR」は build.js が自動で入れる。
- 検査（`tools/lib/audit.js` の `auditAffiliate`）が、sponsored リンクがあるのに広告表示や PR 表記がない出力を止める。
- 報酬の有無で順位・評価を変えない（`content/pages/ad-policy.md` で公約している）。
- バナー（`type: "banner"`）と計測画像は、ページ表示の時点で提携先へ通信が発生する。追加・変更したら `content/pages/privacy.md` の「広告バナーと計測画像」の節（送信先・掲載記事）も直すこと。

## 公開の流れ

エージェントは **draft: true の下書きまで**。人が `queue/reports/<slug>.md` の点検結果と本文を確認し、draft を外してPRでマージしたときだけ公開される。自動マージは設定しない。1領域1日1本まで（`agents/run.js` が止める）。

## 触るときの決まり（blueaegis-site から継承）

- `style.css` のフェードイン対象と `script.js` の `SEL` を揃える（検査が止める）。
- 日付に `toISOString()` を使わない。`seo.todayJst()` を使う。
- シェルのヒアドキュメントで JavaScript を書かない。Write ツールを使う。
- 記事は1つのPRにつき1ファイル。ファイル名の日付と frontmatter の `date` を一致させる。
