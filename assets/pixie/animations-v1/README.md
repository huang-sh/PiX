# Pixie 动画素材 v1

基于 `../pixie-concept-v6.png`，使用内置 imagegen 绘制五组动作关键帧。每组 8 帧，循环播放；这是关键帧风格的第一版动画，非骨骼动画或高帧率视频。不同动作间可能有轻微造型差异。

直接打开 `preview.html`，可以切换动作、拖动桌宠、调整尺寸、查看深浅背景和暂停。预览会遵循系统的减少动态效果设置。

| 文件名 | 动作 |
| --- | --- |
| idle | 漂浮、眨眼 |
| wave | 招手 |
| think | 托腮思考 |
| happy | 开心举手 |
| sleep | 闭眼休息 |

每组包含：透明动画 `.webp`、透明动画 `.gif`、静态首帧 `.png`、横向 8 帧序列 `-strip.png`。画布均为 256×256，显示尺寸建议 96–160 px。优先用 WebP，GIF 只有二值透明，边缘效果较弱。

`manifest.json` 记录文件路径、帧数和逐帧毫秒时长。`sources/` 保留 imagegen 原始四列两行帧表和完整提示词。`build.py` 使用 Pillow 提取帧、清理孤立透明杂点、统一画布并编码动图，没有调用其他图像生成模型。

重建：在已安装 Pillow 的 Python 环境运行 `python build.py`。脚本会验证两种格式的帧数、循环标记、尺寸、透明角点、帧差异及 GIF 时长，并自动把 `.webp` 与 `.png` 同步到 `../../../resources/pixie/`，无需手动复制。

PiX 已接入本素材：渲染层使用的是 `../../../resources/pixie/` 下的 `.webp` 动画与 `.png` 首帧（悬浮桌宠 `PixieSprite.vue` 根据助手状态切换，减少动态效果时显示静态 PNG），`build.py` 每次重建后自动同步这两个格式。
