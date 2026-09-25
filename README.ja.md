<p align="center">
  <img src="resources/icon.png" width="180" alt="PiX logo">
</p>

<h1 align="center">PiX</h1>

<p align="center">非線形の AI エージェントワークベンチ — セッションはグラフ：いつでも分岐でき、コンテキストはブランチに追従します</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh.md">中文</a> · 日本語</p>

---

<p align="center">
  <img src="assets/images/pix-session-tree.png" alt="左から右へブランチが伸びていく PiX のセッショングラフ">
</p>

PiX のセッションは一本の線ではなく、成長し続けるグラフです。会話の各ターンがノードとなり、どのノードからでもいつでも新しいブランチを伸ばせます。

## 非線形セッション

従来の AI チャットは一本のタイムラインです。方向を変えたければ最初からやり直すか、コンテキストがぐちゃぐちゃになるまで同じスレッドに質問を積み重ねるしかありません。

PiX はセッションを左から右へ成長するグラフとして整理します。

- 各ターン（あなたのプロンプトと、アシスタントの返答およびツール呼び出し）がグラフ上のノードになります。
- 複数の方向性を同じグラフ上に共存させられます。いつでも別のブランチに切り替えて、互いに干渉することなく続行できます。
- うまくいった道はさらに深掘りし、行き止まりはグラフ上に残しておけます。いつでも戻って別のルートを試せます。
- セッションは本物の Pi セッションであり、新しいフォーマットではありません。そのため PiX の外でも引き続き利用できます。

## いつでも分岐

PiX において分岐は日常的な操作であり、事前に計画しておく必要はありません。

- **任意のユーザーメッセージからフォーク**：回答に満足できませんか？ そのターンから別のプロンプトやアプローチで新しいブランチをフォークできます。元のブランチはそのまま残ります。
- **ターンから続行**：グラフ上の過去の任意のノードを選択し、その時点から会話を再開できます。
- **アクティブなブランチを複製**：現在のブランチをセーブポイントとして複製し、自由に実験できます。すべてのブランチはグラフ上に表示され続け、いつでも切り替えて戻れます。

## コンテキストはブランチに追従

ブランチを切り替えても、コンテキストを設定し直す必要はありません。コンテキストはブランチの一部です。

- **ブランチチャットパネル**には、アクティブなブランチのメッセージだけが表示されます。別のブランチに切り替えると、チャットも一緒に切り替わります。
- シングルクリックはどのパネルにも触れずにグラフ上のノードをハイライトします（/fork などのグラフコマンドはハイライトされたノードに作用します）。ダブルクリックするとプライマリチャットパネルがそのノードに合わせて移動します。
- グラフ上のノードをダブルクリックすると、その会話がプライマリチャットパネルで開きます。Ctrl+ダブルクリック（または右クリックメニューの「Open in chat panel」）でそのブランチを 2 列目・3 列目の横並びチャット列にピン留めでき、最大 3 列を同時に並べてブランチを比較できます。各ブランチが持てるパネルは 1 つだけで、すでにピン留めされたブランチの別のノードを開くと、その列の対象が切り替わります。各列はそれぞれ独立してスクロール・返信できます。ピン留めした列から返信すると、そのブランチがその場で伸びます。列は新しく作成されたノードに追従し、プライマリ列は現在の選択を維持します。最後のピン留め列を閉じる（または次回起動する）と、チャットの幅が元に戻ります。
- **ブランチコンテキストパネル**は選択中のノードに追従し、そのターンの経過（思考、ツール呼び出し、所要時間、ステップ数）を表示します。選択中のノードへの返信もそこから直接行えます。

<p align="center">
  <img src="assets/images/pix-multi-chat-panels.png" alt="複数チャットパネル：異なるブランチのノードを Ctrl+ダブルクリックして、最大 3 つのチャット列を横並びにピン留めして比較">
</p>

## 組み込み拡張機能

PiX には 2 つの組み込み拡張機能が同梱されており、どちらも Pi の拡張機構を通じて読み込まれます。これらはネイティブバイナリを含むため、拡張機能本体とそのランタイム依存関係はインストーラーに同梱されています。別途インストールする必要はなく、Pi 経由で npm からインストールしたものがあればそちらが優先されます。

- **`@ff-labs/pi-fff` — 高速なファイル・内容検索**：組み込みの `find` / `grep` ツールを FFF（Rust ネイティブ、SIMD 高速化）に置き換えます。`fffind` によるファイル名のあいまい検索、`ffgrep` による内容検索、`fff-multi-grep` による複数パターン検索を提供します。セッション開始時にバックグラウンドでファイルを事前インデックスするため、検索結果は即座に返ります。結果は frecency（使用頻度と最近性）順に並び（よく使うファイルが先頭）、git で変更されたファイルや未追跡のファイルは優先度が上がります。
- **`@injaneity/pi-computer-use` — デスクトップアプリの操作**：macOS、Windows、Linux でエージェントがデスクトップアプリを観察・操作できるようにします。開いているアプリやウィンドウの検出、画面上のテキストやコントロールの読み取り、クリック、入力、スクロール、UI の変化の待機が可能です。API がなく画面上のインターフェースしかないアプリで役立ちます（macOS ヘルパーには macOS 14 以降が必要です）。

`pi-web-access` はインストーラーには同梱されていません。設定 → 拡張機能ページからワンクリックでインストールでき、`pi update` で最新の状態に保てます。これによりエージェントは Web 検索、URL の取得、PDF の抽出、GitHub の調査が行えるようになります。Web 検索サービスには引き続きご自身の設定と認証情報が使用されます。

PiX 自体も内部拡張機能 `file-changes` を 1 つ追加します（削除不可）。これはエージェントがファイルを編集・書き込みする前後のスナップショットを取得し、「Changes」パネルを実現します。

## ダウンロード

お使いのプラットフォーム向けのインストーラーを [GitHub Releases](https://github.com/huang-sh/PiX/releases) から入手してください。

- **Windows**：`PiX-Setup-x.y.z.exe`（インストーラー）または `PiX-Portable-x.y.z.exe`（ポータブル版）、x64。
- **macOS**：`PiX-x.y.z-arm64.dmg` または `PiX-x.y.z-x64.dmg`。zip アーカイブもあります。
- **Linux**：`PiX-x.y.z-x86_64.AppImage`（ポータブル版）、`PiX-x.y.z-amd64.deb`、`PiX-x.y.z-x86_64.rpm`、および tar.gz。x64。

インストーラーには署名がありません。Windows SmartScreen の警告が表示された場合は「実行」を選択してください。macOS では初回起動時に、システム設定 → プライバシーとセキュリティ でアプリを許可してください。

<details>
<summary>ソースから実行</summary>

Node.js 22.19 以降が必要です。

```bash
npm install
npm run dev
```

`npm run verify` は型チェック、テスト、起動スモークテストの一式を実行します。

`npm run test:fff` は同梱のファイル検索を、`npm run test:web` は Web 拡張機能のインストール構成（実際に npm install を行うためネットワークが必要）とページ取得をチェックします。どちらも分離された設定で実行されます。macOS では `npm run dist:mac` で現在のマシンのアーキテクチャ向けにパッケージ化し、Linux では `npm run dist:linux` で AppImage、deb、rpm、tar.gz をパッケージ化します。CI は対応するネイティブライブラリを含めるため、Apple Silicon、Intel、Ubuntu の各ランナーで個別にビルドします。

</details>

## コミュニティ

WeChat グループに参加しましょう：

<p>
  <img src="assets/images/Weixin.png" width="220" alt="PiX WeChat グループの QR コード">
</p>

## コントリビューター

PiX に貢献してくださったすべての方に感謝します：

<!-- CONTRIBUTORS:START -->
<a href="https://github.com/huang-sh"><img src="https://avatars.githubusercontent.com/u/24741118?v=4&s=80" width="80" height="80" alt="huang-sh"></a>
<a href="https://github.com/mugpeng"><img src="https://avatars.githubusercontent.com/u/52995448?v=4&s=80" width="80" height="80" alt="mugpeng"></a>
<a href="https://github.com/github-actions[bot]"><img src="https://avatars.githubusercontent.com/in/15368?v=4&s=80" width="80" height="80" alt="github-actions[bot]"></a>
<a href="https://github.com/kindredzhang"><img src="https://avatars.githubusercontent.com/u/120791467?v=4&s=80" width="80" height="80" alt="kindredzhang"></a>
<a href="https://github.com/xxnuo"><img src="https://avatars.githubusercontent.com/u/54252779?v=4&s=80" width="80" height="80" alt="xxnuo"></a>
<a href="https://github.com/jinjianghao"><img src="https://avatars.githubusercontent.com/u/147498917?v=4&s=80" width="80" height="80" alt="jinjianghao"></a>
<!-- CONTRIBUTORS:END -->

コントリビューションを歓迎します。バグやアイデアは [issue](https://github.com/huang-sh/PiX/issues) を立てるか、プルリクエストを送ってください。
