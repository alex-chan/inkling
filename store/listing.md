# Chrome Web Store 上架资料（逐项粘贴到开发者后台）

包：`dist/inkling-1.0.2.zip`（`./tools/package.sh` 生成）
素材：`store/assets/`（`node store/make-assets.mjs` 重新生成）

---

## 商品详情（Store listing）

**语言**：中文（简体）

**名称**：Inkling 墨点（取自 manifest）

**摘要**（取自 manifest，≤132 字符）：
按你的词汇量给 CNN、BBC、Reuters、YouTube 等英文新闻和视频网站上的生词加中文注释、美式音标和发音，可接入大模型解释。

**类别**：教育（Education）

**详细说明**：

读英文新闻、看英文视频时，总有几个词不认识、不会读？Inkling 按你的词汇量，只给超出你水平的生词加注释，其余原文一字不动。

【支持的网站】
默认在这些英文新闻和视频网站上运行：CNN、NBC News、CNBC、Reuters、BBC、Google 新闻、华尔街日报、YouTube（含视频字幕）、纽约时报、卫报、AP、Bloomberg、华盛顿邮报、金融时报、经济学人、NPR、半岛电视台、ABC News、CBS News、Fox News、Politico、Axios、The Atlantic、纽约客、TIME、USA Today、Forbes、Business Insider。
其他网站可在工具栏弹窗中点「在此网站启用」，按网站单独授权。

【按水平注释生词】
• 词汇水平可选：初中 / 高中 / 四级 / 六级 / 考研 / 雅思托福 / 专八 / GRE，也可以用滑杆自由调节；提供 40 词小测，帮你估算自己的词汇量
• 注释方式三选一：词上方小字、词后括注、只加下划线；同一段里同一个词只在第一次出现时显示释义
• 自动还原词形（tariffs → tariff，went → go），自动跳过人名地名、缩写、导航栏、代码块和输入框
• 熟词本、生词本：点「我认识这个词」，以后不再注释；加进生词本的词总会注释

【词卡：释义、美式音标、发音】
• 点击被注释的词，弹出词卡：美式 IPA 音标、中文释义、词频排名和考试标签
• 🔊 一键朗读，可以选择声音、调节语速，也可以设置打开词卡时自动朗读
• 选中任意词或短语，点「注」按钮即可查词

【接入大模型（可选）】
• 「AI 语境解释」：结合所在句子讲清这个词在本句的意思、读音、用法和背景
• 「AI 优化注释」：按你的水平重新判断每段该注释什么，释义按上下文给出；会补上熟词僻义（如 markets brace for… 里的 brace 表示「准备应对」）和习语短语（如 in the wake of），并标出 CEFR 难度等级
• 两种接入方式：填 OpenAI 兼容接口的 API Key，或用 ChatGPT 账号登录（消耗 Plus / Pro 套餐用量）

【隐私】
离线词典，不联网也能注释。开发者不运营服务器、不收集任何数据；只有在你使用 AI 功能时，相关文字才会直接发往你自己选择的模型服务。开源：github.com/alex-chan/inkling

**图标**：`store/assets/store-icon-128.png`
**截图**（1280×800）：
1. `screenshot-1-card.png`：词卡与 AI 语境解释
2. `screenshot-2-phonetic.png`：美式音标注释
3. `screenshot-3-ai.png`：AI 优化注释（熟词僻义、短语、CEFR 等级）
4. `screenshot-4-settings.png`：词汇水平设置
**小型宣传图块**（440×280）：`promo-small-440x280.png`
**顶部宣传图块**（1400×560）：`promo-marquee-1400x560.png`

**官方网址**：https://alex-chan.github.io/inkling/（已在 Google Search Console 验证，可在后台「官方网址」下拉框中选择）
**首页网址**：https://github.com/alex-chan/inkling
**支持网址**：https://github.com/alex-chan/inkling/issues

---

## 隐私权规范（Privacy practices）

**单一用途说明**：
帮助中文母语读者阅读英文网页：按用户设定的词汇水平，为网页上的生词添加中文注释、音标和发音，并可选地调用用户自己配置的大模型解释词语在上下文中的含义。

**权限理由**：

- `storage`：在本机保存用户设置、熟词本和生词本、用户填写的 API Key，以及 ChatGPT 登录令牌。
- `scripting`：用户在弹窗中对某个非默认网站点「在此网站启用」并授权后，用它在该网站注册内容脚本，并立即注入当前标签页。只作用于用户授权过的网站。
- `webNavigation`：仅用于「用 ChatGPT 登录」。OAuth 授权完成后，OpenAI 会把浏览器重定向到本地回调地址 http://127.0.0.1:14551/auth/callback（OpenAI 对开源/本地应用的要求）。扩展通过 webNavigation 识别这次跳转，读取授权码完成登录，作为下面重定向规则的兜底。不读取其他任何导航。
- `declarativeNetRequestWithHostAccess`：仅在登录进行期间添加一条动态规则，把上述本地回调地址重定向到扩展自带的 callback.html 页面，登录结束后立即删除。不拦截、不修改任何其他请求。
- 主机权限（必需）：
  - 列出的英文新闻和视频网站（CNN、BBC、Reuters、YouTube、WSJ 等）：内容脚本在这些网站上识别并注释生词；
  - `https://api.openai.com/*`、`https://auth.openai.com/*`：默认的模型接口和「用 ChatGPT 登录」；
  - `http://127.0.0.1/*`：仅用于拦截 ChatGPT 登录的本地回调地址（见上一条）。
- 可选主机权限 `https://*/*`、`http://*/*`：安装时不申请。只在两种情况下，经用户点击按钮后按单个网站申请：①用户在弹窗中对当前网站点「在此网站启用」；②用户在设置页填写了自定义的 OpenAI 兼容接口地址并点「测试连接」。

**是否使用远程代码**：否。所有代码都在扩展包内，没有 eval，也不加载远程脚本。

**数据使用**（勾选）：
- [x] 个人身份信息：用 ChatGPT 登录后得到的姓名和邮箱，只保存在本机，用于显示当前账号
- [x] 身份验证信息：用户的 API Key 和 OAuth 令牌，只保存在本机，只发往对应的服务
- [x] 网站内容：用户使用 AI 功能时，相关词句或段落文字直接发往用户配置的模型服务
- 其余类型（健康、财务、通信、位置、网络记录、用户活动）都不勾选

**三项声明**都勾选：不向第三方出售或转让用户数据（核准用途除外）；不将数据用于与单一用途无关的目的；不将数据用于判断信用或发放贷款。

**隐私权政策网址**：https://alex-chan.github.io/inkling/PRIVACY.html

---

## 给审核人员的测试说明（Test instructions，可选）

无需账号即可测试核心功能：安装后打开 BBC、CNN 或 Reuters 的任意英文文章页（如 https://www.bbc.com/news 里的一篇文章），生词会被注释；点击被注释的词可弹出词卡并朗读。在默认列表以外的网站上点工具栏图标，会看到「在此网站启用」按钮。AI 功能需要用户自己的 OpenAI 兼容 API Key（设置页 → 大模型），默认关闭。
