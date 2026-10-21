# フェリー時刻表照合・表示修正（2026-10-21）

## 公式資料と適用範囲

| 航路 | 照合元 | 反映 |
| --- | --- | --- |
| 中島東線・西線 | [愛媛県・令和9年度離島航路資料18頁](https://www.pref.ehime.jp/uploaded/attachment/183017.pdf#page=18)、[中予地方局](https://www.pref.ehime.jp/site/chuyo/4786.html)、[松山観光港](https://www.kankoko.com/contents/timetable.html) | 東西フェリー上下便の寄港順・時刻、高浜での発着。最終便の三津浜発のみ資料差異を明示 |
| とびしま・第二せきぜん | [今治市・令和8年4月1日表](https://www.city.imabari.ehime.jp/kotsus/tosen/sekizen/sekizen-r804.pdf)、[運休案内](https://www.city.imabari.ehime.jp/kotsus/tosen/sekizen/) | 上下便の全寄港時刻、第二せきぜん月木運休。とびしまは通常運航 |
| 松山・呉・広島 | [松山観光港](https://www.kankoko.com/contents/timetable.html)、[高速船](https://setonaikaikisen.co.jp/kouro/jet/)、[臨時便案内](https://setonaikaikisen.co.jp/archives/important_news/5790) | 通常上下便、呉時刻、高速船10/31～11/13・11/30～12/5の減便と初日最終日例外 |
| 広島クルーズフェリー12月減便 | [船社公式](https://setonaikaikisen.co.jp/kouro/cruise/) | 12/1～25平日の松山11:00/15:30、広島08:05/13:40を除外 |
| 芸予汽船 | [船社公式](https://geiyokisen.com/) | 平日・土日祝の全寄港、朝便岩城乗継。お盆・年末年始も公式休日扱い |
| 大三島ブルーライン | [船社公式](https://omishima-bl.net/#schedule) | 今治直通は木江10:50→宗方11:05→今治12:05、木江18:45→宗方19:00→今治19:55。木江07:40は宗方止まりであり今治到着便ではない |
| 防予フェリー | [2025/3/1改正・現行通常表](https://www.boyoferry.co.jp/c_timetable.html)、[船社運航案内](https://www.boyoferry.co.jp/) | 上下各11便に更新、伊保田着発両時刻、曜日制限、12/8～23の伊保田経由便運休 |
| 宇和島運輸 | [船社公式](https://www.uwajimaunyu.co.jp/timetable/)、[日月休航・ドックPDF](https://www.uwajimaunyu.co.jp/special/info/topfile/23.pdf) | 別府・臼杵の発着、臼杵深夜便の曜日制限を2027/3/29まで更新。11/30～12/9・1/12～20のドック便も適用 |
| 国道九四フェリー | [船社公式](https://www.koku94.jp/operation) | 70分の上下発着、通常便と公表臨時便の区別 |
| 東予・大阪、新居浜・神戸 | [ドック案内](https://www.orange-ferry.co.jp/6488.html)、同ページ公式PDF | 大阪発10/20～11/2休航を翌日の東予到着10/21～11/3にも適用。新居浜14:50発／神戸23:10発の実運航日、通常便除外日を補正 |
| 高松・神戸（ジャンボ） | [船社公式](https://ferry.co.jp/home/kobe-takamatsu/)、[土休日対象日](https://ferry.co.jp/news/holiday-schedule2022/)、[小豆島寄港時刻](https://ferry.co.jp/cn/sea_route/kobe-shodoshima/) | 静的・動的到着データの二重登録を解消、平日・土休日の出発と到着、坂手寄港、前日発の扱い |
| 興居島 | [船社公式](https://gogoshima-ferry.com/timetable_faretable/) | 出発時刻は公式。到着は公式の所要約10分／13分によるため「時刻表推定」と明示 |

## 未解決の資料差異

中島東線最終便の三津浜発について、松山観光港の現行掲載表は19:05、2026年公表の県資料は19:10。
中島汽船公式サイトは照合時に接続できず、改正実施を直接確認できなかった。
既存19:10を断定的な確定時刻に変えず、時刻欄に※、便詳細に「公式資料で三津浜発19:05／19:10の差異あり・出発時刻要確認」と明記した。
松山観光港19:30・睦月19:55・大浦20:14、および西線の各寄港時刻は資料間で一致。

## 表示とデータの保証

- 到着便の詳細は当該到着データの `time` を終点に使う。出発用の所要時間を加算しない。
- 中間時刻を均等補間しない。公式時刻がない場合は「途中寄港時刻は未確認」とする。
- 「寄港予定」は港の公表時刻を示す。着時刻・発時刻が分かれている伊保田は両方を表示。
- 出発・到着それぞれの実際の向きを保持し、前日発・翌日着を区別する。
- 各便の詳細スクロールは一定の読み取り速度を維持。船種名はスクロール複製を作らず、列内に収める。
- フェリー以外の時刻表レコード、画面寸法、配置、ページ送り設定は変更しない。

## 検証

```sh
node --check transport/r15-dev/app.js
node scripts/verify_ferry_timetable.cjs
git diff --check
```

静的到着便62件の表示終点一致、平日・週末・祝日の12画面、物理便の重複、木曜運休、ドック初日例外・終了復帰、日付またぎ、途中未確認時の非補間を検証する。

時刻表予定は実際の着岸・出航を確認したライブ位置情報ではない。臨時欠航などは船社の運航情報による。
