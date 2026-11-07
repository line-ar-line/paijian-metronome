# 《欢乐颂》完整示例的来源

采用 [Mutopia 第 528 号 Ode to Joy](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=528)，编制为 SATB 合唱、4/4 拍、16 小节的赞美诗版本。该版本的排版作者为 Peter Chubb，来源与排版均标注 **Public Domain**。

- 原始源码：`mutopia-528-ode.ly`，来自 [Mutopia GitHub 固定版本](https://github.com/MutopiaProject/MutopiaProject/blob/2144afd6f52d56c5b6995b8b589ef1268b3139f0/ftp/BeethovenLv/ode/ode.ly)。保留了原作者、出处与公版说明。
- 原始完整 MIDI：`mutopia-528-ode-original.mid`，来自[官方文件](https://www.mutopiaproject.org/ftp/BeethovenLv/ode/ode.mid)，包括高、低两个谱表中的全部 SATB 声部，时长为 64 个四分音符拍。
- 拍间内置版：完整采用 `sop` 高声部的 16 小节旋律，整体从 G 调升 5 个半音到 C 调，使低属音 G4 至最高音 G5 都可在 17 音 C 调卡林巴上弹奏。没有删除中段、结尾或音符。

这个“完整”指上述完整 16 小节赞美诗版本的旋律。作品页仍明确保留来源与编配范围，不把它称为《第九交响曲》整个第四乐章。

核验日期：2026-11-07。

## 双音伴奏示例

`score/examples.js` 的 `ode-duet` 保留上述完整 62 个旋律音，另加拍间编写的 32 个简易伴奏音，仍为 16 小节、64 拍。其伴奏不是 Mutopia 原谱的 SATB 声部；用于 17 音 C 调卡林巴双音练习，最多两音同时持续，所有音高均在 C4–E6 自然音内。可下载 `examples/ode-duet.mid` 导入检验。
