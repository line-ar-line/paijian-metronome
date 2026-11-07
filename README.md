# 拍间 · 卡林巴练习工具

一个可离线使用的卡林巴练习工具，提供节拍器和 MIDI 数字谱工坊，使用原生 HTML、CSS、JavaScript 和 Web Audio API。无需安装依赖，也不需要账户。

**在线使用：[打开拍间节拍器](https://line-ar-line.github.io/paijian-metronome/)**

**曲谱工坊：[MIDI 转卡林巴数字谱](https://line-ar-line.github.io/paijian-metronome/score.html)**

**找曲谱：[开放 MIDI 与乐谱来源](https://line-ar-line.github.io/paijian-metronome/library.html)**，提供 Mutopia 搜索，以及 PDMX、Lakh、MAESTRO、GiantMIDI 官方入口。规模、授权与完整性说明见 [MIDI_SOURCES.md](MIDI_SOURCES.md)。

用电脑或手机浏览器打开链接，点击“开始练习”即可。可以直接把这个地址分享给朋友，无需登录 GitHub。

![拍间节拍器桌面界面](preview-desktop.png)

## MIDI 数字谱工坊

导入完整的 `.mid` / `.midi` 文件，选择主旋律音轨，即可生成适合卡林巴练习的数字谱。默认是 **17 音 C 调**，也可切换为 21 音 C 调。内置完整的《小星星》12 小节、《欢乐颂》16 小节主题和原创《指尖小练习》4 小节；也可下载 [小星星 MIDI](examples/twinkle.mid) 或 [欢乐颂完整主题 MIDI](examples/ode.mid) 体验导入。

[直接打开《欢乐颂》完整版](https://line-ar-line.github.io/paijian-metronome/score.html?example=ode)。该编配逐音对应 Mutopia 第 528 号公版赞美诗版本的完整高声部，包含中段与再现，共 **62 个音、16 小节、64 拍**。来源、原始完整 MIDI 和完整 LilyPond 原谱见 [sources/README.md](sources/README.md)。

生成结果示例：[小星星数字谱 PNG](examples/twinkle-score.png) · [SVG](examples/twinkle-score.svg)；[欢乐颂完整主题 PNG](examples/ode-score.png) · [SVG](examples/ode-score.svg)。

![曲谱工坊界面](preview-score.png)

1. 打开 `score.html` 或在线曲谱工坊，选择或拖入 MIDI 文件。
2. 多轨曲子请选择主旋律音轨，鼓轨会自动排除；试听确认选对了旋律。
3. 选择琴型、拍号和整体移调。点击“寻找更适合琴键的调”，可以寻找能覆盖更多音符的移调方案。此操作会整体改变旋律的实际音高。
4. 长曲按页浏览，页码会显示对应小节范围；试听自动翻页可关闭。修改谱面设置会停止试听，再次播放从头开始。
5. “全谱图片”和“全谱 SVG”始终导出所有页；单页直接下载，多页打包为 ZIP。“打印 / PDF”也包含全部谱页，在浏览器对话框中选择保存 PDF。

数字使用固定的 **1 = C4** 琴键对应关系，并保留高低八度圆点、升号、休止符、时值下划线、附点、小节线和延音线。17 音 C 调音域为 C4–E6 的自然音，21 音版为 F3–E6 的自然音。当前琴型没有的半音或超出音域的音会标为橙色，试听保留该音高，不会悄悄替换音符或折叠八度。

### 转谱范围

- 接受标准 MIDI 格式 0 / 1、PPQ 时间单位，文件最大 20 MB；最多 100,000 个输入音符、2048 小节。超限时整份拒绝，不生成部分乐谱。格式 2 和 SMPTE 时间单位会给出明确提示。
- 保留源 MIDI 所有音轨的总时间线，包括开头休止、旋律结束后的其他声部、End-of-Track 结束标记前的尾部休止。分页只改变显示，导出和打印不会丢失后半首。最后一个不完整小节可补休止用于排版，试听按源时长结束。
- 完整文件不等于完整原曲。原文件如果只有主题、单独乐章或选段，程序无法恢复源文件没有提供的部分；请通过原谱、反复段、版本和结尾核对。《欢乐颂》的“完整”明确指来源发布的 16 小节赞美诗主题编配。
- 输出为**单旋律练习谱**。同一位置的和弦保留最高音，重叠延音会截短到下一个音符，并在页面说明。所选音轨是否真的是主旋律，需要试听确认。
- 起止时间按十六分音符网格规整；断奏、三连音与自由节奏可能改变，会提示校对。MIDI 踏板延音不参与转换，也会提示。
- 全曲采用一个拍号和均匀的练习速度，初始值来自 MIDI。原文件中途的变拍、变速会显示提示，当前版本不重现完整速度曲线。
- 本地文件只在浏览器内解析，不上传、不保存到 GitHub。导出的谱图下载到当前设备。
- 多页导出使用无依赖的标准 ZIP；完整归档上限为 256 MiB，超限时整份停止，不下载残缺页集。长曲优先使用 SVG 或打印 / PDF。
- 试听采用合成拨弦音；浏览器严重挂起或音频中断时会停止，保持页面在前台使用更稳妥。

曲谱工坊的主要实现分别位于 `score/midi.js`（解析）、`score/score-model.js`（转谱）、`score/renderer.js`（分页与 SVG 排版）、`score/export.js`（全谱归档）、`score/player.js`（试听）和 `score/workshop.js`（交互）。示例 MIDI 可通过 `node tools/export-examples.cjs` 从内置示例音符重新生成。

## 本地使用

用 Chrome、Edge 或 Safari 打开本文件夹里的 `index.html` 使用节拍器，或打开 `score.html` 使用曲谱工坊。浏览器需要用户点击后才允许播放声音。

也可以在本文件夹执行 `python3 -m http.server 8765 --bind 127.0.0.1`，访问 `http://127.0.0.1:8765`。

## 发布与更新

本项目通过 GitHub Pages 从 `main` 分支根目录发布，不需要构建或部署依赖。修改网页文件后提交并推送到 `main`，GitHub 会自动更新在线页面，通常需要几分钟。

自行 Fork 后，可在仓库的 **Settings → Pages** 中选择 **Deploy from a branch**，再选择 **main / (root)** 并保存。发布完成后，以该页面显示的网址为准。

## 使用

- 速度：30–240 BPM；直接输入、拖动滑块，或使用加减按钮。默认 60 BPM，4/4 拍，木质音色。
- 常用速度：60、72、84、96 BPM。建议先从 60 BPM 一拍拨一次，稳定后每次提高 4 BPM。
- 拍号：2/4、3/4、4/4、6/8。6/8 模式以八分音符为 BPM 单位，显示六个拍点，并把第 1、4 个拍点设为重拍，形成 3 + 3 分组。例如八分音符 180 BPM 对应附点四分音符 60 BPM；第 4 个拍点与第 1 个拍点音色强度相同，可自行切换。
- 细分：每拍一下、二等分、三连音、四等分。卡林巴左右手交替练习可选择二等分：一次点击对应一次拨弦。
- 拍点：点击在“重拍 → 静音 → 轻拍”之间循环。静音拍会把这一拍的细分声一起静音，视觉拍点仍继续运行。
- 敲击测速：跟着旋律点击“敲击测速”，或按 T。连续敲 4–7 次更稳定；间隔超过 2.4 秒会开始新一组。
- 音色：木质、电子、清铃；支持音量调整与一键静音。
- 本次练习：只累计播放期间的时间；暂停后保留。小节数在下一小节第一拍响起时增加，停止前未完整结束的小节不计入。更换拍号或细分时从第一拍重新开始。
- 设置会保存在当前浏览器。浏览器禁止本地存储时仍可使用，只是无法跨页面保留设置。练习计时不会跨刷新保存。

## 快捷键

| 按键 | 功能 |
| --- | --- |
| Space | 开始 / 暂停（焦点在按钮上时，遵循按钮本身的键盘操作） |
| ← / → | 降低 / 提高 1 BPM |
| Shift + ← / → | 降低 / 提高 4 BPM |
| T | 敲击测速 |

编辑输入框或选择拍号时，不触发全局快捷键。

## 实现与限制

`engine.js` 负责使用音频时钟提前调度声音，`app.js` 负责交互、练习计时与设置保存，`styles.css` 负责响应式布局。声音全部本地合成，没有外部音频、字体或网络请求。

声音按 AudioContext 的时间轴安排，页面的定时器仅负责提前补充未来的拍点，不决定声音的实际开始时间。拍点高亮跟随音频时钟；显示帧率、设备音频延迟和蓝牙耳机仍可能造成视听延迟。练习时推荐设备扬声器或有线耳机。

变速会作用于尚未安排的拍点，已提前安排的短段节奏会先完成；更换拍号或细分会清除旧声音，从第一拍重新开始。系统休眠、切换音频设备或浏览器严重暂停调度时，会停止播放并提示重新开始，避免恢复后连续补播。后台播放和手机锁屏播放取决于浏览器及系统；练习时建议保持页面在前台。在支持 Screen Wake Lock 的浏览器中，播放期间会尽量保持屏幕唤醒。

## 验证

音频、MIDI、转谱和谱面测试使用 Node 内置测试工具，无需安装包：

```sh
node --test tests/engine.test.cjs tests/midi.test.cjs tests/score-model.test.cjs tests/score-renderer.test.cjs tests/score-player.test.cjs tests/score-export.test.cjs tests/complete-examples.test.cjs
```

另外提供了 `tests/browser.test.cjs`。开发时安装 Playwright 并准备 Chrome 后，可运行 `node --test tests/browser.test.cjs`，验证实际音频输出、节拍间隔、暂停、快捷键、设置持久化、后台小节计数和窄屏布局。此项验证会更新两张 `preview-*.png` 截图；使用节拍器本身不需要 Playwright 或 Node。

曲谱工坊的浏览器集成验证：`node --test tests/workshop.browser.cjs`，使用同样的 Playwright 和 Chrome 环境，覆盖 MIDI 上传、音轨选择、谱面渲染、试听、导出与移动端布局。

完整谱验证：`node --test tests/full-score.browser.cjs`，覆盖 300 小节 MIDI 的最后音符与尾部时间、全页遍历、全部 PNG/SVG ZIP 文件、完整打印、曲库搜索入口及移动端布局。
