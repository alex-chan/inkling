# Inkling 墨点 隐私政策 / Privacy Policy

最后更新：2026-10-14

Inkling 是一个开源浏览器扩展（[源代码](https://github.com/alex-chan/inkling)）。开发者**不运营任何服务器**，不收集、不接收、不出售任何用户数据，也没有统计、广告或追踪代码。

## 在你的设备上处理和保存的数据

- **网页内容**：扩展在本机读取你浏览的网页文字，用离线词典判断并注释生词。这一步不联网。
- **设置与词表**：词汇水平、显示偏好、熟词本、生词本，保存在本机的 `chrome.storage.local`，不会同步到其他设备。
- **API Key 与登录令牌**：你填写的 API Key，以及用 ChatGPT 登录后得到的访问令牌、刷新令牌和账号信息（姓名、邮箱，仅用于在设置页显示当前账号），只保存在本机的 `chrome.storage.local`。
- **AI 结果缓存**：AI 返回的注释结果缓存在本机的 IndexedDB 中，用来避免重复请求。

## 释义包下载

在设置中把释义语言选为日语或韩语时，扩展会从 GitHub Pages（`alex-chan.github.io`）下载对应的释义包，下载完成后存放在本机。这只是普通的文件下载，请求里不含任何个人数据或浏览内容。和访问任何网站一样，GitHub 会看到请求来源的 IP 地址。

## 只在你使用 AI 功能时才会发送的数据

AI 功能默认不启用。只有在你配置了大模型，并主动点击「AI 语境解释」或开启「AI 优化注释」后，扩展才会把以下内容**直接**发给**你自己选择的服务**，中间不经过开发者：

- 你点选或划选的词语，以及它所在的句子和前后各一句；
- 开启「AI 优化注释」时：当前阅读附近段落的文字、词典初筛出的候选生词，以及你设定的词汇水平。

数据去向：
- **API Key 方式**：发往你在设置里填写的接口地址，比如 OpenAI 或其他兼容服务；
- **ChatGPT 登录方式**：发往 OpenAI（`api.openai.com`），计入你的 ChatGPT 套餐用量。

这些数据的处理受相应服务商的隐私政策约束。

## Sign in with ChatGPT

登录通过 OpenAI 的 OAuth（PKCE）流程完成，你的密码只在 OpenAI 页面输入，扩展看不到。退出登录时，扩展会先请求 OpenAI 撤销刷新令牌，再清除本机保存的令牌。你也可以随时在 ChatGPT 设置中断开 Inkling。

## 朗读

朗读使用浏览器自带的语音合成（Web Speech API）。所用声音由浏览器和操作系统提供，具体是否联网取决于你选择的声音。

## 联系

问题和建议请提交到 [GitHub Issues](https://github.com/alex-chan/inkling/issues)。

---

**English summary.** Inkling has no backend and collects no data. Settings, word lists, your API key and OAuth tokens are stored only in `chrome.storage.local` on your device. Page text is processed locally with an offline dictionary. AI features are off by default. When you use them, the selected word with nearby sentences, or nearby paragraph text if "AI-optimized annotation" is on, is sent directly to the AI provider you configured: your OpenAI-compatible endpoint, or OpenAI when you sign in with ChatGPT. Choosing Japanese or Korean glosses downloads that gloss pack from GitHub Pages (alex-chan.github.io); the request carries no personal data or browsing content. Nothing is sent to the developer. Nothing is sold or used for advertising or tracking.
