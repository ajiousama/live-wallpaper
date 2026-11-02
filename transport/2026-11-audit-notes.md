# 2026年11月 松山交通壁紙・監査記録
最終確認: 2026-11-03

## 件数
`schedule.js` と `schedule.json` に同一の558レコード。
JR松山88、市坪50、観光列車特別到着6、バス177、フェリー153、航空74、松山中央公園バス10。
11月1日～30日の30日×558レコード＝16,740件の適用条件をテスト。対象日・運行停止・終了済イベントの残存を検査。

## 修正反映
- 岡山行き7:40（松山駅）・7:48（市駅）：JR四国バスに訂正。
- 新居浜行き8:45（松山駅）：伊予鉄バスに訂正。他6便はせとうちバス。
- 今治「第二せきぜん」：月・木はフェリー出航・到着とも運休。旅客船「とびしま」は変更なし。
- 既存の11月対応：空港冬ダイヤ、伊予灘運転日、広島配船、国道九四増便、防予11/4休航、東京線運転日、神戸・きらら・久万高原線運休条件を維持。
- 2026年10月だけの臨時列車は11月に混入しないことを確認。
- 定期便の時刻表は当日の実運行や荒天欠航を保証しない。

## 注意・未確定事項
- 中島汽船三津浜発19:05（観光港ターミナル掲載）対19:10（愛媛県・乗換案内掲載）が不一致。19:10を暫定表示、確定扱いしない。
- JR大阪便15:30は公式「特定日、主に土日」。11月中の例外的な平日祝日運行日を断定できない。
- JR松山／市坪の公式公開駅PDFは2025年3月15日改正印字。2026年11月の列車時刻との照合を実施したが、11月すべての日に臨時変更が無いとは保証しない。
- 国際航空便は11月1日・2日の松山空港当日画面と冬ダイヤ情報で照合。航空会社別全日運休は別途確認が必要。
- 船舶の臨時差し替えや台風欠航など、未来の実運行は未確定。

以上のため `verifiedMonth` を2026-10から見かけ上だけ変更しない。`version` は `2026.11.03.R15-audit-in-progress`。職場画面では月次更新ポップアップを停止し、11月一部確認と表示する。

## 重要な公式資料
- https://www.jr-shikoku.co.jp/01_trainbus/jikoku/pdf/matsuyama.pdf
- https://www.jr-shikoku.co.jp/01_trainbus/jikoku/pdf/ichitsubo.pdf
- https://www.matsuyama-airport.co.jp/
- https://www.iyotetsu.co.jp/kousoku/okayama.html
- https://www.setouchibus.co.jp/rosen/niihama.html
- https://www.city.imabari.ehime.jp/kotsus/tosen/sekizen/
- https://www.kankoko.com/contents/timetable.html
- https://www.pref.ehime.jp/site/chuyo/4786.html
- https://www.koku94.jp/operation

## 次に解決すべき点
中島19:05/19:10の船社確認、JR大阪15:30の11月特定日カレンダー、国際航空便の冬期全日設定、職場Lively実画面テスト。
