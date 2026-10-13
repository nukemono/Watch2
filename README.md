# Watch2 — SolarWatch high-accuracy control

このリポジトリは卒業制作 SolarWatch の A/B 対照実験における **高精度候補 CONTROL** を固定するためのリポジトリです。

## 基準

- 元リポジトリ: `nukemono/Watch`
- 元PR: `#36 DO NOT MERGE: Watch2 high-accuracy control snapshot`
- 測定ロジック基準コミット: `fa45d6915e354bd6cb09b38640278ae6cc122c0f`
- スナップショット元: `experiment/watch2-high-accuracy-control`

## CONTROLで固定する重要仕様

- iPhone屋外検証では背面カメラの **3D optical-axis elevation** を高度の主値として使用する。
- `DeviceOrientation beta` をそのまま太陽高度の主値にはしない。
- iPhone方位は `webkitCompassHeading` と180°ジャンプ/parity補正を使用する。
- 測定前の安定待ち、測定中の品質監視、GPS精度ゲートを維持する。
- 10秒 / 50msサンプリングを維持する。
- CONTROLの測定ロジックは、明示的な指示なしに変更しない。

現行方式との比較実験では、このリポジトリを基準側として使用します。
