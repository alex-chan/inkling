#!/usr/bin/env python3
"""从 ECDICT 的 ecdict.csv（+ 可选 CMUdict）生成 extension/data/dict.tsv 与 forms.tsv。

用法: python3 -I tools/build_dict.py path/to/ecdict.csv [path/to/cmudict.dict]
ECDICT:  https://github.com/skywind3000/ECDICT (MIT License)
CMUdict: https://github.com/cmusphinx/cmudict (BSD-style License) —— 美式发音

dict.tsv : 词 \t 音标(ECDICT) \t 中文释义(最多4行, 行间用字面 \\n 分隔) \t 词频排名 \t 考试标签 \t 美式IPA
forms.tsv: 变形 \t 原形 \t 变形的美式IPA
"""
import csv
import os
import re
import sys

ALPHA = re.compile(r'^[A-Za-z]+$')
# 无词频时按考试标签 / 柯林斯星级估算排名
TAG_RANK = {'zk': 1500, 'gk': 3500, 'cet4': 4500, 'cet6': 6000, 'ky': 6500,
            'ielts': 8000, 'toefl': 8000, 'gre': 14000}
COLLINS_RANK = {5: 1000, 4: 2500, 3: 5000, 2: 9000, 1: 15000}
NO_RANK = 30000
VARIANT_TYPES = set('pdi3srt')
VARIANT_NOTE = re.compile(r'(的过去式|的过去分词|的现在分词|的复数|第三人称单数|的比较级|的最高级)')


# ---------- CMUdict ARPAbet -> 美式 IPA ----------

ARPA_VOWEL = {
    'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'aʊ', 'AY': 'aɪ', 'EH': 'ɛ', 'ER': 'ɝ',
    'EY': 'eɪ', 'IH': 'ɪ', 'IY': 'i', 'OW': 'oʊ', 'OY': 'ɔɪ', 'UH': 'ʊ', 'UW': 'u',
}
ARPA_CONS = {
    'B': 'b', 'CH': 'tʃ', 'D': 'd', 'DH': 'ð', 'F': 'f', 'G': 'ɡ', 'HH': 'h', 'JH': 'dʒ', 'K': 'k',
    'L': 'l', 'M': 'm', 'N': 'n', 'NG': 'ŋ', 'P': 'p', 'R': 'r', 'S': 's', 'SH': 'ʃ', 'T': 't',
    'TH': 'θ', 'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ',
}
# 合法词首辅音丛（用于把重音符号放在音节开头，最大首音原则）
ONSETS = {tuple(x.split()) for x in (
    'P R|P L|B R|B L|T R|D R|K R|K L|G R|G L|F R|F L|TH R|SH R|S P|S T|S K|S M|S N|S L|S W|S F|'
    'K W|T W|D W|G W|TH W|P Y|B Y|K Y|G Y|M Y|F Y|V Y|HH Y|S P R|S P L|S T R|S K R|S K W|S K L|S P Y|S K Y'
).split('|')} | {(c,) for c in ARPA_CONS if c != 'NG'}


def arpa_to_ipa(phones):
    vowels = [i for i, p in enumerate(phones) if p[-1].isdigit()]
    marks = {}
    if len(vowels) > 1:
        prev = -1
        seen_primary = False
        for v in vowels:
            stress = phones[v][-1]
            # 学习词典惯例：主重音之后的次重音不标（tomato → təˈmeɪtoʊ）
            if stress == '2' and seen_primary:
                stress = '0'
            seen_primary = seen_primary or stress == '1'
            if stress in '12':
                start = v
                if prev >= 0:
                    cons = phones[prev + 1:v]
                    for k in range(len(cons), 0, -1):
                        if tuple(cons[-k:]) in ONSETS:
                            start = v - k
                            break
                else:
                    start = 0
                marks[start] = 'ˈ' if stress == '1' else 'ˌ'
            prev = v
    out = []
    for i, p in enumerate(phones):
        out.append(marks.get(i, ''))
        if p[-1].isdigit():
            base, st = p[:-1], p[-1]
            if base == 'AH' and st == '0':
                out.append('ə')
            elif base == 'ER' and st == '0':
                out.append('ɚ')
            else:
                out.append(ARPA_VOWEL[base])
        else:
            out.append(ARPA_CONS[p])
    return ''.join(out)


def load_cmudict(path):
    ipa = {}
    if not path:
        return ipa
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.split('#')[0].strip()
            if not line:
                continue
            word, *phones = line.split()
            if '(' in word or not ALPHA.match(word):
                continue  # 只取第一个读音
            try:
                ipa[word.lower()] = arpa_to_ipa(phones)
            except KeyError:
                pass
    return ipa


def to_int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return 0


def clean_translation(raw):
    lines = [l.strip() for l in raw.replace('\\r', '').split('\\n') if l.strip()]
    general, domain = [], []
    for l in lines:
        l = l.replace('\t', ' ')
        if len(l) > 90:
            l = l[:88].rstrip('，,；; ') + '…'
        (domain if l.startswith('[') else general).append(l)
    # 有通用释义时丢掉 [计] [医] [网络] 等专业/网络释义，减少噪音
    out = general or [l for l in domain if not l.startswith('[网络]')]
    if not out:
        out = [l.replace('[网络] ', '').replace('[网络]', '') for l in domain]
    return out[:4]


def estimate_rank(frq, bnc, tags, collins):
    if frq > 0:
        return frq
    if bnc > 0:
        return bnc
    est = [TAG_RANK[t] for t in tags if t in TAG_RANK]
    if est:
        return min(est)
    if collins in COLLINS_RANK:
        return COLLINS_RANK[collins]
    return NO_RANK


def main(src, outdir, cmu_path=None):
    us = load_cmudict(cmu_path)
    entries = {}      # word(原样) -> row tuple
    exchanges = []    # (word, exchange)
    with open(src, encoding='utf-8', newline='') as f:
        for row in csv.DictReader(f):
            w = row['word']
            if not ALPHA.match(w):
                continue
            frq, bnc, collins = to_int(row['frq']), to_int(row['bnc']), to_int(row['collins'])
            tags = row['tag'].split()
            if row['exchange']:
                exchanges.append((w, row['exchange']))
            if not (frq > 0 or bnc > 0 or tags or collins > 0):
                continue
            if len(w) > 1 and w.isupper():
                continue  # 全大写缩写不注释，也不需要收录
            tr = clean_translation(row['translation'])
            if not tr:
                continue
            ph = row['phonetic'].replace('\t', ' ').strip()
            rank = estimate_rank(frq, bnc, tags, collins)
            entries[w] = (w, ph, '\\n'.join(tr), rank, ' '.join(tags), us.get(w.lower(), ''))

    lower_words = {w for w in entries if w.islower()}
    rank_of = {w: e[3] for w, e in entries.items()}

    forms = {}

    def add(variant, lemma):
        v, l = variant.lower(), lemma.lower()
        if v == l or not ALPHA.match(v) or l not in lower_words:
            return
        old = forms.get(v)
        if old is None or rank_of[l] < rank_of[old]:
            forms[v] = l

    for w, ex in exchanges:
        parts = dict(p.split(':', 1) for p in ex.split('/') if ':' in p)
        if w.islower():
            for t, v in parts.items():
                if t in VARIANT_TYPES:
                    for one in v.split(','):
                        add(one, w)
        if '0' in parts:
            add(w, parts['0'])

    # 变形词条本身若只是"…的过去式"之类，排名不应比原形更"常见"——交给运行时取 min 即可。
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, 'dict.tsv'), 'w', encoding='utf-8', newline='\n') as f:
        for w in sorted(entries, key=lambda k: (entries[k][3], k)):
            f.write('\t'.join(str(x) for x in entries[w]) + '\n')
    with open(os.path.join(outdir, 'forms.tsv'), 'w', encoding='utf-8', newline='\n') as f:
        for v in sorted(forms):
            f.write(f'{v}\t{forms[v]}\t{us.get(v, "")}\n')
    covered = sum(1 for e in entries.values() if e[5])
    common = [e for e in entries.values() if e[3] <= 20000 and e[0].islower()]
    print(f'dict.tsv: {len(entries)} entries ({covered} with US IPA; '
          f'{sum(1 for e in common if e[5]) * 100 // max(1, len(common))}% of rank<=20000), '
          f'forms.tsv: {len(forms)} forms')


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    main(sys.argv[1], os.path.join(here, '..', 'extension', 'data'), sys.argv[2] if len(sys.argv) > 2 else None)
