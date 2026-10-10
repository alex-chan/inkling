# Microsoft Edge Add-ons 上架资料（Partner Center）

后台：https://partner.microsoft.com/dashboard/microsoftedge/overview
包：`dist/inkling-1.0.1.zip`，与 Chrome 应用商店用同一个包（`./tools/package.sh` 生成）。
素材：`store/assets/`

整套端到端测试也在 Microsoft Edge 155 上跑过（`BROWSER_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" npm test`）。

---

## 1. 软件包（Packages）

上传 `inkling-1.0.1.zip`。

## 2. 可用性（Availability）

- **可见性**：公开（Public）
- **市场**：全部市场（中文用户主要在中国大陆、台湾、香港、新加坡，不需要限制）

## 3. 属性（Properties）

- **类别**：教育（Education）
- **隐私政策要求**：是。扩展会访问个人信息：用 ChatGPT 登录时的姓名和邮箱、用户的 API Key，均只保存在本机。
- **隐私政策网址**：https://alex-chan.github.io/inkling/PRIVACY.html
- **网站网址**：https://alex-chan.github.io/inkling/
- **支持联系方式**：https://github.com/alex-chan/inkling/issues
- **成人内容**：否

## 4. 商品详情（Store listings）→ 添加语言：中文（简体）

**名称 / 简短说明**：取自 manifest，上传包后自动带出。

**说明**（≥250 字符）：与 Chrome 应用商店相同，复制 [listing.md](listing.md) 中「详细说明」整段即可。

**扩展徽标**（1:1，建议 300×300）：`store/assets/edge-logo-300.png`

**小型宣传磁贴**（440×280，可选）：`store/assets/promo-small-440x280.png`
**大型宣传磁贴**（1400×560，可选）：`store/assets/promo-marquee-1400x560.png`
**屏幕截图**（1280×800，可选，最多 10 张）：`store/assets/screenshot-1-card.png` … `screenshot-4-settings.png`

**搜索词**（最多 7 个，每个 ≤30 字符，合计 ≤21 个词；用户看不到）：
1. 英语生词注释
2. 英文新闻阅读
3. 单词翻译
4. 美式音标
5. English vocabulary
6. YouTube 字幕翻译
7. ChatGPT 英语学习

## 5. 给认证人员的说明（Notes for certification）

```
Inkling annotates English words above the user's vocabulary level with Chinese glosses on major English news/video sites (CNN, BBC, Reuters, YouTube, WSJ, NYT, etc.). No account is needed to test the core feature: open any article on https://www.bbc.com/news, unknown words get small Chinese annotations; click one to open a word card with US IPA and text-to-speech.

Permissions: host permissions are limited to the listed news/video sites, api.openai.com / auth.openai.com, and http://127.0.0.1/* (only to intercept the OAuth loopback redirect http://127.0.0.1:14551/auth/callback used by "Sign in with ChatGPT", via a temporary declarativeNetRequest rule that is removed after sign-in). Other sites are opt-in per site from the toolbar popup via optional host permissions. AI features are optional, off by default, and require the user's own OpenAI-compatible API key or ChatGPT sign-in. No remote code. Source: https://github.com/alex-chan/inkling (MIT).
```

## 提交

点「发布」（Publish）。Edge 审核通常最多 7 个工作日。通过后商店链接形如 `https://microsoftedge.microsoft.com/addons/detail/<扩展ID>`。
