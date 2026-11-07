# 哪里找完整曲谱与 MIDI

核验日期：**2026-11-07**。以下数量来自项目官方页面或官方元数据，通常表示文件、谱面或演奏记录数，不等于同样数量的不同作品。

日常按曲名找谱，优先用 **Mutopia**；以后扩展可搜索的大曲库，优先研究 **PDMX 的无许可冲突子集**。下载 MIDI 后，在「曲谱工坊」选择旋律音轨，并试听核对。

| 来源 | 已核验规模与下载方式 | 许可与使用范围 | 对卡林巴及完整曲目的适合程度 |
| --- | --- | --- | --- |
| [Mutopia Project](https://www.mutopiaproject.org/) | 首页列出 **2,124** 个音乐条目；逐曲提供 PDF、MIDI 和可编辑 LilyPond 源码，可按曲名、作曲家、乐器查找。 | 逐曲标注 Public Domain、CC BY 或 CC BY-SA；需保留相应署名与同许可要求。[官方许可说明](https://www.mutopiaproject.org/legal.html)明确允许下载、修改及分发。 | **最适合先用起来**。人工排版的谱面便于核对旋律和曲式。条目可能是一首独立作品、一个乐章或某种编配，须看作品页确定完整范围。 |
| [PDMX](https://github.com/pnlong/PDMX) · [官方下载](https://zenodo.org/records/15571083) | 官方称 **超过 250,000 份谱面**；推荐的 `no_license_conflict` 子集为 **222,856** 条。提供 MusicXML、MIDI、PDF 及元数据；MIDI 压缩包约 **214 MB**。 | GitHub 工具代码为 MIT，Zenodo 数据集为 **CC BY 4.0**，二者不能相互替代。项目按公开平台的公版标记收集谱面；官方已披露 **31,221 条（12.29%）**内外许可元数据冲突，并建议使用无冲突子集。 | **最适合以后建设大曲库**。结构化乐谱比演奏录音转写更方便保留节奏与声部。先取 `no_license_conflict` 与 `all_valid` 的交集，再去重、核对来源及作品范围；仍不能把每份用户上传谱都叫完整原作。 |
| [Lakh MIDI Dataset](https://colinraffel.com/projects/lmd) | **176,581** 个按文件校验值去重的 MIDI，其中 **45,129** 个匹配到 Million Song Dataset。官方提供 `LMD-full`、`LMD-matched`、`LMD-aligned` 及文件名索引。 | 数据集发布声明为 **CC BY 4.0**；作者同时说明文件来自公开互联网，无法一致识别每个文件的原作者。这不等于其中所有歌曲的作曲和编曲权利都已开放。 | 适合作为**研究与检索候选集合**。曲种广，但官方说明有数千个疑似损坏文件，曲名也可能不准。`full` 指完整数据集合，不保证每个文件都是完整歌曲；`aligned` 针对音频预览片段对齐。 |
| [MAESTRO v3.0.0](https://magenta.tensorflow.org/datasets/maestro) | **1,276** 条钢琴演奏，合计 **198.7 小时**；官方单独提供 **56 MB** MIDI 压缩包及 CSV / JSON 元数据，无需下载百 GB 的音频包。 | 数据集为 **CC BY-NC-SA 4.0**，含非商业和相同方式共享条件。演奏记录与底层作品是不同层面的材料。 | MIDI 由演奏钢琴直接采集，音符时间质量较好；但包含双手和声、踏板和自由速度，通常需改编。官方说按单个音乐片段 / 曲目分割，实际标题也包含指定乐章、练习曲选段，**不保证整部多乐章作品**。 |
| [GiantMIDI-Piano](https://github.com/bytedance/GiantMIDI-Piano) | **10,855** 个 MIDI、**2,786** 位作曲家；按作曲家姓氏筛选的子集有 **7,236** 个 MIDI、**1,787** 位作曲家。官方提供约 **193 MB** 下载包和少量预览。 | README 标注 **CC BY 4.0**；MIDI 来自网上现场录音的自动转写，项目不保证准确性或不侵权。数据集声明不能代替逐作品的来源核对。[官方下载说明](https://github.com/bytedance/GiantMIDI-Piano/blob/master/disclaimer.md)。 | 适合钢琴研究与扩充候选旋律。完整程度取决于源录音，自动转写可能有错音，筛选子集也不是人工校订全集；对卡林巴通常比人工编谱更需要整理。 |

官方依据中的关键表述：Mutopia 首页写明 “2124 pieces of music”；Lakh 写明 “176,581 unique MIDI files”；MAESTRO v3 的统计表为 “Total 1276 / 198.7”；GiantMIDI README 写明 “10,855 MIDI files”；PDMX 的 Zenodo 发布说明明确推荐包含 “222,856 songs” 的 `no_license_conflict` 子集。

## PDMX 的实际下载入口

先查看[发布页面与说明](https://zenodo.org/records/15571083)。这里列出的是该版本的官方文件地址，只需要 MIDI 时无需下载整套 PDF 和 MusicXML：

- [PDMX.csv 元数据索引](https://zenodo.org/api/records/15571083/files/PDMX.csv/content)：约 **225 MB**，包含许可冲突等筛选信息。
- [subset_paths.tar.gz 子集路径](https://zenodo.org/api/records/15571083/files/subset_paths.tar.gz/content)：约 **29 MB**，用于按官方子集筛选。
- [mid.tar.gz MIDI 文件](https://zenodo.org/api/records/15571083/files/mid.tar.gz/content)：**214,395,208 字节**，约 **214 MB**。
- [mxl.tar.gz MusicXML 文件](https://zenodo.org/api/records/15571083/files/mxl.tar.gz/content)：约 **1.89 GB**，适合以后增加保留原谱声部、调号、反复记号的导入功能。

这些是待整理的源资料；文件数量、用户评级或无许可元数据冲突，都不能单独证明一份谱的音乐完整性。对公开曲库，应记录原作品名、来源、版本 / 编配范围和相应许可。

## 怎样判断“完整”

“完整导入一个 MIDI”表示保留该文件提供的全段内容；“完整作品”还需要确认源文件没有只收录主题、选段或单独乐章。应对照原谱的结尾、反复段、乐章名称和版本说明，不以文件名中的 `full`、文件大小或时长作唯一判断。

**完整旋律也不等于完整原配器。** 把钢琴或合唱谱变成单旋律卡林巴谱，会保留所选声部的完整乐段，但省略其他声部和伴奏；橙色标记仍表示当前琴型无法直接弹奏的音。

《欢乐颂》示例采用的是 [Mutopia 第 528 号谱](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=528)的完整高音声部，并移至 C 调。该来源明确标注 **Voice (SATB)、Hymn、Public Domain**；[官方 LilyPond 源码](https://www.mutopiaproject.org/ftp/BeethovenLv/ode/ode.ly)设为 4/4 拍，并以 `\skip 1*16` 标明 **16 小节**。这里的“完整”指这份 16 小节赞美诗编配的旋律，不指贝多芬《第九交响曲》的整个第四乐章。

需要另一份可按标题直接下载的例子，可看 [Mutopia《致爱丽丝》WoO 59](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=931)：作品页标注 **Public Domain**，提供[官方 MIDI](https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.mid)与原谱，便于核对乐段。

## MAESTRO 的轻量入口

- [MIDI-only 下载包](https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0-midi.zip)
- [官方 CSV 元数据](https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0.csv)

本次核验实际读取了 CSV，确认有 **1,276** 条演奏记录。其中可见 `Sonata No. 1, 2nd, 3rd and 4th movements`、`Sonata in A Major, D. 664, I. Allegro moderato` 等标题，因此不能把全部记录宣传为完整奏鸣曲。
