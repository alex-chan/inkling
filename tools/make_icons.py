#!/usr/bin/env python3
"""生成 extension/icons/icon{16,32,48,128}.png：墨色圆角方块 + 一大一小两个墨点。无第三方依赖。"""
import os, struct, zlib

BG = (43, 39, 36)        # 墨色
DOT = (240, 164, 106)    # 暖橙
SS = 4                   # 超采样


def png(path, w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def inside_rrect(x, y, s, r):
    cx = min(max(x, r), s - r)
    cy = min(max(y, r), s - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size):
    S = size * SS
    out = []
    radius = S * 0.22
    dots = [(S * 0.44, S * 0.56, S * 0.25), (S * 0.74, S * 0.28, S * 0.085)]
    for py in range(size):
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    x, y = px * SS + sx + .5, py * SS + sy + .5
                    if not inside_rrect(x, y, S, radius):
                        continue
                    col = BG
                    for (cx, cy, r) in dots:
                        if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                            col = DOT
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            n = SS * SS
            a = acc[3] / n
            if a:
                cov = acc[3] / 255
                out += [round(acc[0] / cov), round(acc[1] / cov), round(acc[2] / cov), round(a)]
            else:
                out += [0, 0, 0, 0]
    return out


here = os.path.dirname(os.path.abspath(__file__))
dst = os.path.join(here, '..', 'extension', 'icons')
os.makedirs(dst, exist_ok=True)
for s in (16, 32, 48, 128):
    png(os.path.join(dst, f'icon{s}.png'), s, s, render(s))

# 商店图标：128×128，图案 96×96 居中，四周 16px 透明留白（Chrome Web Store 规范）
art = render(96)
store = [0] * (128 * 128 * 4)
for y in range(96):
    for x in range(96):
        i, j = (y * 96 + x) * 4, ((y + 16) * 128 + x + 16) * 4
        store[j:j + 4] = art[i:i + 4]
store_dir = os.path.join(here, '..', 'store', 'assets')
os.makedirs(store_dir, exist_ok=True)
png(os.path.join(store_dir, 'store-icon-128.png'), 128, 128, store)

# Edge Add-ons 商店徽标：300×300（1:1）
png(os.path.join(store_dir, 'edge-logo-300.png'), 300, 300, render(300))
print('ok')
