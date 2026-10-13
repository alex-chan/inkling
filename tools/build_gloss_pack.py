#!/usr/bin/env python3
"""由维基词典的日语 / 韩语词条反查，生成「英文词 → 日语 / 韩语」释义包。

数据：kaikki.org 的 Wiktextract 抽取结果（英文维基词典中的日语、韩语词条，释义为英文），CC BY-SA 4.0。
  https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl
  https://kaikki.org/dictionary/Korean/kaikki.org-dictionary-Korean.jsonl

用法：python3 -I tools/build_gloss_pack.py <lang: ja|ko> <kaikki jsonl> [最大词频排名，默认 25000]
输出：glosspacks/<lang>/gloss-<lang>-<版本>.tsv，并更新 glosspacks/index.json

思路：日语词条「関税」的英文释义是 "tariff; customs duty"，反过来就得到 tariff → 関税。
一个英文词会对应多个候选，按下面的规则排序：
  - 释义条目里只有这个词（"tariff"）优于词组的一部分；靠前的义项、靠前的位置优先；
  - 跳过 "alternative form of"、"hanja form of" 之类的跳转条目，以及古语、罕用、方言、专名；
  - 候选词越短越常用（日语里纯片假名的外来语略降权）；
  - 多个义项、多个条目都指向同一个候选时加分。
"""
import collections
import datetime
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')

SKIP_POS = {'character', 'syllable', 'name', 'romanization', 'symbol', 'suffix', 'prefix', 'affix',
            'infix', 'interfix', 'circumfix', 'counter', 'soft-redirect', 'punct', 'combining_form'}
SKIP_TAGS = {'obsolete', 'archaic', 'rare', 'dialectal', 'historical', 'Middle-Korean', 'North-Korea',
             'vulgar', 'slang', 'derogatory', 'offensive', 'nonstandard', 'misspelling', 'form-of', 'alt-of',
             'abbreviation', 'Internet', 'Kansai', 'Okinawan'}
FORM_OF = re.compile(r'^(alternative|obsolete|archaic|dated|rare|hanja|kyūjitai|shinjitai|abbreviation|'
                     r'short|romanization|hiragana|katakana|nonstandard|honorific|humble|polite|clipping|'
                     r'eye dialect|contraction|misspelling|inflection|conjunctive|past|attributive)\b.*\bof\b', re.I)
PAREN = re.compile(r'\([^)]*\)|\[[^\]]*\]|“[^”]*”|"[^"]*"')
HANGUL = re.compile(r'[가-힣]')
KANA_KANJI = re.compile(r'[぀-ヿ一-鿿]')
KATAKANA_ONLY = re.compile(r'^[゠-ヿー・]+$')
ARTICLE = re.compile(r'^(to|a|an|the|be|one\'s|someone\'s|something)\s+')


def load_dict_ranks():
    ranks = {}
    with open(os.path.join(ROOT, 'extension', 'data', 'dict.tsv'), encoding='utf-8') as f:
        for line in f:
            p = line.split('\t')
            w = p[0]
            if w.isalpha() and w.islower():
                ranks[w] = int(p[3])
    return ranks


def native_ok(lang, w):
    if not w or len(w) > 12 or ' ' in w:
        return False
    if lang == 'ko':
        return bool(HANGUL.search(w)) and not re.search(r'[A-Za-z0-9]', w)
    return bool(KANA_KANJI.search(w)) and not re.search(r'[A-Za-z0-9]', w)


def candidates(lang, o, ranks):
    """产出 (英文词, 母语词, 分数)，分数越小越好"""
    if o.get('pos') in SKIP_POS:
        return
    w = o.get('word', '')
    if not native_ok(lang, w):
        return
    length_pen = max(0, len(w) - 2) * 0.6
    if lang == 'ja' and KATAKANA_ONLY.match(w):
        length_pen += 1.5
    senses = o.get('senses') or []
    # 词条里有粗俗 / 俚语义项的，其他义项也降权（避免把俚语词当成常用译法）
    if any(set(s.get('tags') or []) & {'slang', 'vulgar', 'derogatory', 'offensive'} for s in senses):
        length_pen += 1
    si = 0
    for s in senses:
        tags = set(s.get('tags') or [])
        if tags & SKIP_TAGS or s.get('form_of') or s.get('alt_of'):
            continue
        pen = length_pen
        if tags & {'colloquial', 'informal', 'figuratively', 'dated', 'literary', 'formal'}:
            pen += 1.5
        if s.get('topics'):  # 专业领域义项（体育、医学……）
            pen += 3
        seen = set()
        for g in s.get('glosses') or []:
            if FORM_OF.search(g):
                continue
            items = [x.strip() for x in re.split(r'[;,]', PAREN.sub('', g)) if x.strip()]
            for ii, item in enumerate(items):
                item = item.lower()
                while True:  # "to be sluggish" → "sluggish"
                    stripped = ARTICLE.sub('', item)
                    if stripped == item:
                        break
                    item = stripped
                item = item.strip(' .!?')
                if not re.fullmatch(r'[a-z]+', item) or item not in ranks:
                    continue
                seen.add(item)
                yield item, w, si * 2.5 + ii * 1.2 + (0 if len(items) == 1 else 0.8) + pen
        # 较长释义里链接到的关键英文词（如 "a state of being sluggish" 链接 sluggish），分数较低
        for link in s.get('links') or []:
            item = (link[0] if link else '').lower()
            if item in seen or not re.fullmatch(r'[a-z]+', item) or item not in ranks:
                continue
            seen.add(item)
            yield item, w, si * 2.5 + 6 + pen  # 永远排在精确匹配之后
        si += 1


def main(lang, src, max_rank=25000):
    ranks = load_dict_ranks()
    best = collections.defaultdict(dict)  # en -> native -> 最好分数（越小越好）
    support = collections.defaultdict(lambda: collections.defaultdict(set))  # en -> native -> 不同释义
    for line in open(src, encoding='utf-8'):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get('lang_code') != lang:
            continue
        for en, nat, sc in candidates(lang, o, ranks):
            if ranks[en] > max_rank:
                continue
            cur = best[en].get(nat)
            best[en][nat] = sc if cur is None else min(cur, sc)
            support[en][nat].add(round(sc, 1))
    # 多个不同义项都指向同一候选时加分（同一释义的异体词条不重复计分），最多加 1.2
    for en in best:
        for nat in best[en]:
            best[en][nat] -= min(1.2, 0.6 * (len(support[en][nat]) - 1))

    lines = []
    for en in sorted(best, key=lambda k: (ranks[k], k)):
        ranked = sorted(best[en].items(), key=lambda kv: (kv[1], len(kv[0])))
        top = [n for n, _ in ranked[:3]]
        sep = '、' if lang == 'ja' else ', '
        lines.append(f'{en}\t{top[0]}\t{sep.join(top)}')
    common = [w for w, r in ranks.items() if r <= 20000]
    covered = sum(1 for w in common if w in best)
    version = datetime.date.today().strftime('%Y%m%d')
    header = f'# Inkling gloss pack en→{lang} v{version}. Data: English Wiktionary via Wiktextract/kaikki.org, CC BY-SA 4.0.\n'
    body = (header + '\n'.join(lines) + '\n').encode('utf-8')

    outdir = os.path.join(ROOT, 'glosspacks', lang)
    os.makedirs(outdir, exist_ok=True)
    for old in os.listdir(outdir):
        if old.startswith(f'gloss-{lang}-') and old.endswith('.tsv'):
            os.remove(os.path.join(outdir, old))
    name = f'gloss-{lang}-{version}.tsv'
    with open(os.path.join(outdir, name), 'wb') as f:
        f.write(body)

    index_path = os.path.join(ROOT, 'glosspacks', 'index.json')
    index = json.load(open(index_path, encoding='utf-8')) if os.path.exists(index_path) else {'packs': {}}
    index['packs'][lang] = {
        'version': version, 'file': f'{lang}/{name}', 'size': len(body),
        'sha256': hashlib.sha256(body).hexdigest(), 'entries': len(lines),
        'coverage_rank_le_20000': round(covered / len(common), 3),
        'license': 'CC BY-SA 4.0', 'source': 'English Wiktionary (Wiktextract, kaikki.org)',
    }
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{lang}: {len(lines)} entries, {len(body) / 1e6:.2f} MB, coverage of rank<=20000: {covered / len(common):.1%}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 25000)
