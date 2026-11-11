# 立面 / 屋面贴图（卡通渲染）

成都 · 龙泉驿这一版的「真实 3D 质感」靠这些贴图：渲染器把每张图当作**一块精确的模数**铺在墙面上
（`pipeline/page/renderer.ts` 的 `FACADE_MODULE` / `ROOF_MODULE`），光照、阴影、墨线仍由 shader 与后处理算，
所以贴图本身必须是**平光、无投影、无透视**、填满画面、四边能接的图案（不能是照片、3D 渲染、整栋楼、
带灭点的场景）。`pipeline/style/textures.json` 里的 `module` 就是这里的模数，两边必须一致。

## 生成方式

- 模型：**Qwen-Image 2.1**，本地 ComfyUI（`127.0.0.1:8188`），Apache-2.0，输出可商用。
- 工具：`node pipeline/tools/qwen-texture.mjs --name <名字>`，**一次只生成一张**，评审通过再做下一张
  （GPU 是共享的，另一条流水线可能正在用）。
  - 图谱：`UNETLoader(qwen-image-2.1-UC-int8)` → `ModelSamplingAuraFlow(3.1)` → `KSampler(26 步, cfg 4.0)`
    → `VAEDecode`；条件是 `CLIPLoader(qwen3vl_8b, type=qwen_image)` → `TextEncodeQwenImage21`。
  - 输出：`pipeline/style/facades/<名字>.png`（1024²）、`<名字>.tile.png`（2×2 平铺验收）、`raw/`（模型原图，
    留着做**免生成的再剪裁**：`--reuse --force`）。
- 平铺：shader 用 `MirroredRepeatWrapping`，镜像重复天然无缝；只要求画面四边**色调连续**，且格子/腰线
  落在模数边界上（切在墙垛、缝带的中间，不要在窗洞中间切）。
- 评审：看 `<名字>.tile.png`——接缝、线宽、色阶是否和 `pipeline/style/reference.png` 同一本画册；
  再按**真实视距**看一遍：0.25 m/px 时一个 20 m 模数只有 80 px。1024 px 的图被缩小 12.8 倍，
  所以只画大色块能活下来，细纹、小窗、细缝在图上等于消失（画细了只会变成噪点/摩尔纹）。

| 文件 | 用途（`scene.ts` style） | 模数 | 内容 |
|---|---|---|---|
| `factory-blue.png` | 4 厂房、物流园 | 20 × 20 m | 1 开间 × 1 层高：白色彩钢板竖楞 + 天蓝腰线（5.8–8.0 m）+ 条窗带（8.5–10.2 m） |
| `residential-cream.png` | 1 住宅 | 14 × 14 m | 2 开间 × 3 层，米黄抹灰、白窗框、阳台 |
| `office-glass.png` | 5 现代办公 | 16 × 16 m | **3 层 × 3 开间**，石墙垛 + 大玻璃 + 深灰层间带 |
| `tower-curtain.png` | 3 塔楼 | 12 × 12 m | 由 `office-glass` 派生：偏蓝幕墙 + 竖挺 |
| `bauhaus-white.png` | 0 白墙单位楼 | 16 × 16 m | 由 `residential-cream` 派生：退彩后近白的带形窗 |
| `public-stone.png` | 2 学校、场馆、政务 | 14 × 14 m | 由 `office-glass` 派生：石材分缝的米色版 |
| `roof-metal.png` | 屋面（银灰） | 8 × 8 m | 直立锁边银灰金属屋面 |
| `roof-blue.png` | 屋面（厂房蓝） | 8 × 8 m | **独立生成**：天蓝压型钢板，横向宽肋，无天窗/无器物 |
| `roof-concrete.png` | 屋面（平屋顶） | 8 × 8 m | 由 `roof-metal` 派生：卷材格子、灰化 |


## 色板（对照龙泉驿实景，数值为贴图里实测的主色）

| 风格（`scene.ts` 的 style） | 对象 | 主色 | 说明 |
|---|---|---|---|
| 4 厂房 | 一汽-大众/丰田/沃尔沃厂区、物流园 | 白 `#fcfcf4` + 天蓝腰线 `#44a4f4` + 条窗玻璃 `#9cd4d4` | 白色彩钢板 + 蓝色腰线是经开区最常见的厂房配色；屋面银灰直立锁边或蓝色彩钢 |
| 1 住宅 | 员工宿舍、2000 年代小区 | 米黄 `#fcf4d4` + 浅灰 `#cfcabd` | 3.3 m 层高、5.4 m 开间，白窗框 + 淡蓝绿玻璃，屋顶太阳能热水器 |
| 5 现代办公 | 研发楼、4S 店上部 | 暖灰墙垛 `#c8c4bc` + 玻璃 `#b4d4cc` + 层间带 `#4c4c54` | 大玻璃 + 石墙垛，粗格（3 层 × 3 开间 / 16 m），细格在图上会摩尔纹 |
| 3 塔楼 | 城区 90 m+ 住宅/办公 | 淡蓝绿幕墙 `#a9c6cc` | 竖挺 + 层间梁带 |
| 0 白墙 | 80-90 年代单位楼 | 白 `#f4f2ec` | 连续带形窗 |
| 2 公共 | 学校、场馆、政务 | 米色石材 `#ddd2bd` | 石材分缝 + 高窄窗 |
| 屋面 | 平屋顶 / 厂房 | 混凝土 `#cbc6ba` / 银灰 `#c9cbcc` / 天蓝 `#7cc4fc`（谷部 `#4c9cdc`） | 防水卷材分格、直立锁边、压型钢板；屋面在 shader 里再混 30% 建筑色，落到砖上约 `#8ab5dc` |

- 墨线：`rgba(58,62,66,0.55)`（`ground.ts` 的 `INK`），贴图里的线宽在 1024 像素上约 8–14 px
  （换算到 20 m 模数是 0.15–0.3 m，缩到地图尺度还剩 1 px 左右；原来 3–5 px 的线在图上根本看不见）。
- 纸底：`#ded6c5`；后处理再加纸纹，所以贴图不必自带纸感。

## 两张图的排版经验（改 prompt 之前先读）

- **模数 = 一张图，图里只放一个模数。** 20 m 模数里塞两个腰线周期，缩到 80 px 就成了斑马纹。
- **只有建筑高度范围内的下部会被看到。** 模数 20 m、厂房 10 m（`scene.ts` 默认）时，一面墙只采样
  贴图**下面一半**；14 m 的墙采样下面 70%。所以腰线和窗带必须落在 0–10 m 内。
  `factory-blue` 的模型原图把腰线画在了 13–15 m（等于看不见），因此它**按下面是这种方式出图**：
  原图（腰线偏上）→ `crop 0,0.17,1,0.82` 把腰线放大到 2.3 m → `--rotate 180` 翻到 5.8–8.0 m。
  复现命令（`crop` 已在 `textures.json` 里，`--rotate` 只能走命令行）：

  ```sh
  node pipeline/tools/qwen-texture.mjs --name factory-blue --force --rotate 180
  ```

  若要免生成再剪裁：`node pipeline/tools/qwen-texture.mjs --name factory-blue --reuse --force --rotate 180`。
- **`office-glass` 是 3 层 × 3 开间 / 16 m**（原来 7 层 × 6 开间），格线切在墙垛和层间带中间
  （`crop 0.0303,0.0303,0.9336,0.9336`），镜像后接缝正好落在墙垛里，不成倍宽。
- **`roof-blue` 现在是自己生成的**，不再是 `roof-metal` 的蓝色洗色。`pipeline/tools/derive-textures.mjs`
  里还留着一条 `build("roof-blue", "roof-metal", …)`：重跑派生脚本会把它盖掉，跑之前先删那一行
  （同理，`public-stone` / `tower-curtain` 是从 `office-glass` 派生的，`office-glass` 改成粗格后重跑派生
  会把它们也变成粗格——想要就重跑，不想要就别动）。

## 实景参考（只看配色与构造，不进产物）

- Luoyang 厂房航拍（金属屋面拼色）— <https://www.pexels.com/photo/aerial-view-of-industrial-building-roofs-in-luoyang-35045250/>
- Serang 仓储区航拍 — <https://www.pexels.com/photo/warehouses-in-a-city-5115940/>
- Wilson 大型仓库金属屋面 — <https://www.pexels.com/photo/an-aerial-view-of-a-large-warehouse-with-a-roof-27793722/>
- 成都经开区（龙泉驿）官方介绍 — <https://www.chengdu.gov.cn/cdsrmzf/c178924/2025-01/20/content_6500a1a65aeb45268e01e0818851236f.shtml>

地图几何仍全部来自 OpenStreetMap + Copernicus DEM；这些照片只用于确定配色与构造，不进任何输出。
