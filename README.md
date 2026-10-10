# Inkling 墨点

Chrome 扩展（Manifest V3）：按你的词汇量给英文网页上的生词加中文注释、音标和发音，点词可调用大模型结合上下文解释。原生 JS，无构建步骤。

开源协议：[MIT](LICENSE) · 隐私政策：[PRIVACY.md](PRIVACY.md)

## 安装

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择本仓库的 **`extension/`** 目录。
3. 首次安装会自动打开设置页。

## 目录

```
extension/            ← 扩展本体（加载这个目录）
  manifest.json
  background.js       service worker（module）：消息路由、AI 流式解释、OAuth 回调兜底
  lib/
    settings.js       默认值、档位、滑杆刻度（options / popup / background 共用）
    dict.js           离线词典懒加载为 Map、词形还原、示例词、40 词小测
    ai.js             提示词、语境解释、段落自动注释（并发 2 + IndexedDB 缓存）
    openai-compat.js  A. API Key：OpenAI 兼容 Chat Completions（SSE）
    chatgpt.js        B. Sign in with ChatGPT：PKCE、JWKS 验签、串行刷新、撤销、Responses API
    sse.js            SSE 解析与错误对象
  content.js/.css     扫描正文、注释、词卡（Shadow DOM）、划词、复制去注释
  options.* popup.* callback.* ui.css
  data/dict.tsv       56,743 词，4.4 MB（ECDICT 精简 + CMUdict 美式 IPA）
  data/forms.tsv      37,891 个变形 → 原形（含变形本身的美式 IPA）
tools/
  build_dict.py       从 ecdict.csv 重新生成 data/
  make_icons.py       生成图标
  smoke-real-sites.js 真实新闻站点冒烟检查（需联网）
tests/                Playwright 端到端测试 + 本地 mock 服务器
```

## 重新生成词典

```bash
curl -L -o /tmp/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
curl -L -o /tmp/cmudict.dict https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict
python3 -I tools/build_dict.py /tmp/ecdict.csv /tmp/cmudict.dict
```

规则：只收纯字母词，且有词频（`frq`，没有则用 `bnc`）、考试标签或柯林斯星级；都没有排名的按考试标签/星级估算。释义最多 4 行，有通用释义时丢掉 `[计]`、`[网络]` 等专业释义。

格式在需求文档的基础上各加了一列：
- `dict.tsv`：`词 \t 音标(ECDICT) \t 释义 \t 词频排名 \t 考试标签 \t 美式IPA`
- `forms.tsv`：`变形 \t 原形 \t 变形的美式IPA`

美式 IPA 由 CMUdict 的 ARPAbet 转换而来，词频前 2 万的词覆盖 95%。重音符号按最大首音原则放在音节开头；按学习词典的惯例，主重音之后的次重音不标（tomato → /təˈmeɪtoʊ/）。ECDICT 自带的音标是老式写法、多偏英式，只在没有美式 IPA 时作为后备显示在词卡里。

## 测试

```bash
npm install
npm test                                  # 20 个端到端测试，约 1 分钟
HEADED=1 npm test                         # 有界面运行
node tools/smoke-real-sites.js /tmp/out   # 真实站点检查，输出截图和 report.json
```

测试用 Playwright 加载 `extension/`，通过 `chrome.storage.local.devConfig` 把 OAuth 和 API 端点指向 `tests/mock-server.js`（127.0.0.1:18080）。mock 服务器只用于测试，扩展运行时直接调用 LLM API，不需要任何服务器。

可覆盖的开发配置（写到 `storage.local` 的 `devConfig`）：`authBase`、`issuer`、`apiBase`、`resource`、`port`（回调端口，默认 14551），以及单独的 `authorizeUrl` / `tokenUrl` / `jwksUrl` / `discoveryUrl`。

## AI 优化注释（语境释义 + 难度分级）

接入大模型后，可在设置页或工具栏弹窗打开（默认关闭，用量会明显增加）。流程：

1. 词典照常先注释，即时显示；
2. 段落进入视口附近（约 1 屏）时，把段落原文、词典初筛的候选生词和读者水平一起发给模型，例如「词汇量约 4500 词，约四级水平，相当于 CEFR B1–B2」。相邻的短段落会合并，每次最多 4 段、2400 字符；
3. 模型返回 `{"items":[{p, text, gloss, level, kind}]}`，该段改按 AI 结果重新注释：
   - **去掉**：人名、地名、机构名，以及这个水平大概率认识或能猜出的词；
   - **保留**：确实超纲的候选，释义换成本句语境下的意思；
   - **补充**：熟词僻义（`kind: sense`，如 markets *brace* for → 准备应对）和短语动词、习语（`kind: phrase`，如 rule out、in the wake of），短语整体注释；
4. 词卡显示「语境义」、CEFR 等级（A1–C2）和类型（生词 / 熟词僻义 / 短语）。点开已有语境义的短语不会再自动请求；「我认识这个短语」会把短语加入熟词本。

规则：生词本里的词总会注释，即使模型没有选中；熟词本里的词和短语永不注释。模型返回的条目必须在原段落里原样出现，否则丢弃；同一表达重复返回时，保留更具体的类型。结果按「模型 + 水平档（每 500 一档）+ 段落 + 候选」缓存在 IndexedDB，水平变了会按新水平重新请求。关闭开关后回到纯词典注释。词卡里「AI 语境解释」的提示词也会带上读者水平。

## 释义颜色

设置页「显示方式」→「释义颜色」：默认黑色，提供 7 个预设色和自定义取色器，附实时预览。颜色作用于所有中文释义，包括「AI 优化注释」生成的释义；美式音标保留自己的颜色，便于区分。改动后已打开的页面立即生效。在深色背景的网页上，如果所选颜色与背景的对比度低于 3:1（比如默认的黑色），会自动改用浅灰 `#e8e8e8`；反过来，在浅色网页上选了很浅的颜色，会改用深灰。

## 音标与发音设置

设置页「音标与发音」：
- **在注释中显示美式音标**（默认关）：注释显示为 `/ˈtɛrəfs/ 关税`，按页面上实际出现的词形注音，比如 tariffs 而不是 tariff。词卡里总会显示音标，标着「美」。
- **打开词卡时自动朗读**（默认关），以及**声音**（列出本机的英语声音，默认自动优先美式英语）、**语速**（0.5–1.5×）和「试听」。

「词上方小字」模式开启音标后注释会变宽。为了不把原文字距撑开，注释左对齐、可以向右溢出；同一行两个注释可能重叠时，才把后一个词往右推开，刚好够用为止。

## 设计说明

**谁来判断"生词"**：默认由本地词频排名 + 阈值 N + 熟词本/生词本判断，不经过大模型。这样即时、免费、离线可用、结果稳定，滑杆拖动立即生效。开启「AI 优化注释」后，词典结果作为初筛和兜底，最终取舍按模型的语境判断（见上文）。

**懒处理**：保留。词典注释很快，但长页面、无限滚动页面一次性改整页 DOM 没有必要，所以用 IntersectionObserver，上下各预取约 1.5 屏。AI 优化注释必须懒处理，否则一开页面就把整篇文章发给模型；它提前约 1 屏触发，用来掩盖模型延迟。动态内容用 MutationObserver 补扫。

**专有名词**：以下情况不注释：
- 词典里只有大写词条（London），或释义是人名、姓氏；
- 句中大写，且同时满足以下任一：词典里有同名大写词条（Turkey、Reeves）、词频超过 2 万、全页从未以小写出现；
- 和相邻的大写词连在一起（Matt Spivey、Mr. Trump）；
- 句首大写，且页面上多次以大写出现、从未以小写出现。

另外，Title Case 标题（NYT 风格）里的词按普通词判断。少量新闻高频、又恰好是普通英文词的人名（trump、pence、barr、xi）写死在 `NAME_HINTS` 里。

**OAuth 回调拦截**：用 declarativeNetRequest 动态规则把 `http://127.0.0.1:14551/auth/callback?…` 重定向到 `callback.html`。规则只在登录过程中存在，登录完成后移除。另外用 webNavigation 的 `onBeforeNavigate` 和 `onErrorOccurred` 兜底，按 `state` 去重。两条路径都有单独的测试。

## 与需求文档不同的地方

- `agent_name_hint` 用 **Inkling**，没有沿用文档里的 `LexiNote`（看起来是旧名字）。
- 按 OpenAI 官方文档补充了以下处理：
  - 授权回调 `error=access_denied` 时提示"未开启套餐用量共享"；
  - 再次登录时，如果回调返回的 `client_id` 与已保存的不一致，就拒绝；
  - 再次登录时校验账号 `sub` 一致；需要换账号时用「使用其他账号登录」重新注册；
  - 退出登录后不再发送 `id_token_hint`（只发 `login_hint`）；令牌失效后重新登录时，会带上 `id_token_hint`；
  - 对 503 类错误（`usage_unavailable` / `user_unavailable`）有限次退避重试。
- 推理返回 401 时，先强制刷新一次令牌再重试；仍然 401（含 `subscription_sharing_invalid_user`）才清除令牌、要求重新登录。官方文档要求"确认失效后才要求重新登录"，这样做兼顾了两边。
- 用量超限后，AI 优化注释暂停 15 分钟；手动点「AI 语境解释」不受影响。

## 已知限制

- **AI 优化注释的效果没有用真实模型验证过**：测试里由 mock 返回固定结果，只验证了请求格式、取舍、渲染和缓存逻辑。提示词对真实模型的取舍效果（漏注 / 多注）需要接上你的 Key 后实际看看。
- **真实的 ChatGPT 登录没有实测**：所有 OAuth 测试都跑在 mock 上，按官方文档的参数和行为编写。这个功能还处于 preview 阶段，文档没有说明是否支持浏览器扩展；第一次用真实账号登录时，最可能出问题的是授权页对动态注册或回调的校验。
- **NYT 和 Reuters**：它们对自动化浏览器显示"Verifying the device"人机验证，所以只用仿照它们 DOM 结构的本地页面做了测试，真实页面需要你手动验证。BBC 和 The Guardian 的真实文章页已检查：导航、页脚、代码块零注释，词卡正常，点链接里的词不会跳转。
- 「词上方小字」模式会增大有注释那几行的行高，这是 `<ruby>` 本身的特性；介意的话可以选「词后括注」或「只加下划线」。
- API Key 和令牌按需求存放在 `chrome.storage.local`。Chrome 默认允许 content script 读取这块存储，不过 content script 只读取设置相关的 key。
- 朗读效果取决于系统里有没有 en-US 语音。
- 少数生僻词 CMUdict 没有收录，这些词在注释里不显示音标，词卡里显示 ECDICT 的音标。

## 打包与上架

```bash
./tools/package.sh              # → dist/inkling-<version>.zip，manifest.json 位于根目录
node store/make-assets.mjs      # 重新生成商店截图与宣传图（store/assets/）
```

商店后台要填的各项内容（说明、权限理由、数据使用声明、隐私政策网址）见 [store/listing.md](store/listing.md)。

## 第三方数据与许可

- [ECDICT](https://github.com/skywind3000/ECDICT)：英汉词典数据，MIT License，见 `extension/data/LICENSE-ECDICT.txt`
- [CMUdict](https://github.com/cmusphinx/cmudict)：美式发音数据，BSD-style License，见 `extension/data/LICENSE-CMUdict.txt`
