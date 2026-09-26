# live-wallpaper

松山のライブ壁紙を、会社PCに重い取得処理をさせずに表示するための専用リポジトリです。

## 方針

- GitHub Actions: データ取得・整形
- GitHub Pages: 壁紙本体と生成済みJSONを配信
- 表示PC: Pagesを表示し、軽量JSONだけを定期読込
- 交通壁紙: 15秒ごとにJSON読込
- パタパタ/交通NOW: 10秒ごとに表示切替
- JRA勝利騎手一覧: 60秒ごとにJSON読込

## Pages

- 入口: https://ajiousama.github.io/live-wallpaper/
- 松山交通壁紙: https://ajiousama.github.io/live-wallpaper/transport/
- JRA勝利騎手一覧: https://ajiousama.github.io/live-wallpaper/jra/

## 移行対象

- JR松山駅
- JR市坪駅
- 松山空港（出発/到着）
- 空港バス
- 高速・中距離バス
- フェリー・高速船
- 松山交通NOW（鉄道/高速バス/飛行機/船）
- JRA 勝利騎手一覧

## 更新設計

data/transport.json を交通系の共通受け皿にしています。
各ソース取得アダプターは scripts/ に追加し、取得失敗時は直前の正常値を残す方式に統一します。
JRAは scripts/update_jra.py がJRA公式結果を取得し、jra/data.json を更新します。
