# Watch2 — SolarWatch high-accuracy control

このリポジトリは卒業制作 SolarWatch の A/B 対照実験における **高精度候補 CONTROL** と、その実測修正版を管理します。

## 基準

- 元リポジトリ: `nukemono/Watch`
- 元PR: `#36 DO NOT MERGE: Watch2 high-accuracy control snapshot`
- 測定ロジック基準コミット: `fa45d6915e354bd6cb09b38640278ae6cc122c0f`
- 元CONTROL: `iphone-field.html`
- 実測修正版: `iphone-field-flex.html`

## 元CONTROLで固定する重要仕様

- iPhone屋外検証では背面カメラの **3D optical-axis elevation** を高度の主値として使用する。
- `DeviceOrientation beta` をそのまま太陽高度の主値にはしない。
- iPhone方位は `webkitCompassHeading` と180°ジャンプ/parity補正を使用する。
- 10秒 / 50msサンプリングを維持する。
- 元CONTROLの測定ロジックは比較用として保存し、明示的な指示なしに変更しない。

## v2.1 実測修正

実機確認で以下の問題が見つかったため、`iphone-field-flex.html` で必要箇所だけ修正した。

1. カメラ高度角が水平時に約 -90°となっていたため、光軸高度の基準を **水平=0°** に補正する。
2. 姿勢安定性・方位SD・回転速度は引き続き取得・表示・CSV保存するが、測定開始の必須条件にはしない。
3. 測定中に手ブレや回転があっても10秒間のサンプリングを継続する。
4. 結果の有効/無効判定では、手ブレや安定サンプル率を必須条件にしない。GPS・観測値・サンプル数など最低限の取得条件を主に確認する。

現行方式との比較実験では、元CONTROLとv2.1の両方を残し、変更の影響を追跡できる状態を維持する。
