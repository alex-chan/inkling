// 默认支持的网站（与 manifest.json 的 content_scripts.matches 保持一致，由测试校验）
// 其他网站需要用户在弹窗里点「在此网站启用」单独授权。

export const DEFAULT_SITES = [
  ['CNN', ['*://*.cnn.com/*']],
  ['NBC News', ['*://*.nbcnews.com/*']],
  ['CNBC', ['*://*.cnbc.com/*']],
  ['Reuters', ['*://*.reuters.com/*']],
  ['BBC', ['*://*.bbc.com/*', '*://*.bbc.co.uk/*']],
  ['Google 新闻', ['*://news.google.com/*']],
  ['The Wall Street Journal', ['*://*.wsj.com/*']],
  ['YouTube', ['*://*.youtube.com/*']],
  ['The New York Times', ['*://*.nytimes.com/*']],
  ['The Guardian', ['*://*.theguardian.com/*']],
  ['AP News', ['*://*.apnews.com/*']],
  ['Bloomberg', ['*://*.bloomberg.com/*']],
  ['The Washington Post', ['*://*.washingtonpost.com/*']],
  ['Financial Times', ['*://*.ft.com/*']],
  ['The Economist', ['*://*.economist.com/*']],
  ['NPR', ['*://*.npr.org/*']],
  ['Al Jazeera', ['*://*.aljazeera.com/*']],
  ['ABC News', ['*://abcnews.go.com/*']],
  ['CBS News', ['*://*.cbsnews.com/*']],
  ['Fox News', ['*://*.foxnews.com/*']],
  ['Politico', ['*://*.politico.com/*']],
  ['Axios', ['*://*.axios.com/*']],
  ['The Atlantic', ['*://*.theatlantic.com/*']],
  ['The New Yorker', ['*://*.newyorker.com/*']],
  ['TIME', ['*://time.com/*']],
  ['USA Today', ['*://*.usatoday.com/*']],
  ['Forbes', ['*://*.forbes.com/*']],
  ['Business Insider', ['*://*.businessinsider.com/*']],
];

export const DEFAULT_MATCHES = DEFAULT_SITES.flatMap(([, m]) => m);

// Chrome match pattern → RegExp（scheme://host/path，host 可为 *.example.com）
export function patternToRegExp(pattern) {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return /$^/;
  const [, scheme, host, path] = m;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const s = scheme === '*' ? 'https?' : scheme;
  const h = host === '*' ? '[^/]+' : host.startsWith('*.') ? `(?:[^/]+\\.)?${esc(host.slice(2))}` : esc(host);
  const p = esc(path).replace(/\*/g, '.*');
  return new RegExp(`^${s}://${h}(?::\\d+)?${p}$`);
}

export function matchesAny(url, patterns) {
  return patterns.some((p) => patternToRegExp(p).test(url));
}

// 某个网页地址对应的授权模式：https://example.com/*
export function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
