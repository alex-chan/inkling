# 释义包数据许可 / Gloss pack data license

`ja/` 和 `ko/` 下的释义包由英文维基词典（English Wiktionary）中日语、韩语词条的英文释义反查生成，数据经由 [Wiktextract](https://github.com/tatuylonen/wiktextract) / [kaikki.org](https://kaikki.org/) 抽取。

- 许可：[知识共享 署名-相同方式共享 4.0（CC BY-SA 4.0）](https://creativecommons.org/licenses/by-sa/4.0/)
- 署名：Wiktionary contributors, https://en.wiktionary.org/
- 改动：只保留与 Inkling 英汉词典重合的英文词，每个词按规则挑选最多 3 个日语 / 韩语对应词（见 [tools/build_gloss_pack.py](../tools/build_gloss_pack.py)）

The gloss packs are derived from English Wiktionary (via Wiktextract / kaikki.org) and are licensed under CC BY-SA 4.0. The Inkling source code is MIT-licensed; these data files are not.
