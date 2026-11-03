#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_ring_spans.py —— 由 ring_config.h 生成"圆环每段逐行跨度表" ring_seg_spans.h

为什么要这张表
--------------
    ring_paint_band() 重画一个 4° 的扇区时, 每个像素都要现算:
      角度 (atan2) → 段号 → 段内相位 → 段/缝颜色 → 两三次混色
    在 CW32L011 (M0+ @96MHz, 无硬件除法, 代码跑在 Flash) 上实测约 24~29us/像素,
    换一档(2 段)要 16ms —— 超过一帧(16.7ms), 面板扫描必 пересекать, 就是"黑带撕裂"。

    这张表把几何在编译期算好: 每段每行只留 {y, x0, 段体像素数, 缝像素数},
    运行期一个窗口一次写完, 不再有逐像素数学。表 ~4KB。

用法
----
    python tools/ring_sim/gen_ring_spans.py            # 生成 code/spi/ring_seg_spans.h
    python tools/ring_sim/gen_ring_spans.py --check    # 只校验现有文件是否最新 (Keil 预编译用)

参数全部取自 code/lcd/ring_config.h, 与 bsp_ring.c 里的 ring_seg_split() 同一套口径:
    P_Q8 = round(PITCH_X10000 * 256 / 10000), BODY_Q8 = round(BODY_X10000 * 256 / 10000)
    段号 = relQ8 / P_Q8,  段体 = (relQ8 - 段号*P_Q8) < BODY_Q8
"""
import re, sys, os, math

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = HERE
while not os.path.exists(os.path.join(ROOT, 'code', 'lcd', 'ring_config.h')):
    _up = os.path.dirname(ROOT)
    if _up == ROOT:
        raise SystemExit('找不到 code/lcd/ring_config.h')
    ROOT = _up
CFG = os.path.join(ROOT, 'code', 'lcd', 'ring_config.h')
OUT = os.path.join(ROOT, 'code', 'spi', 'ring_seg_spans.h')


def load_tables():
    """从 ring_tables.h 读 ringAtanTab / ringRecip, 用来**原样复刻**固件的
    ring_tab_atan2(): 段边界必须和引擎用同一套 0.5° 量化, 否则边界会差 1px,
    上板就是"段比原来窄一点/缝宽一点"。"""
    src = open(os.path.join(ROOT, 'code', 'spi', 'ring_tables.h'),
               encoding='utf-8', errors='ignore').read()

    def arr(name):
        m = re.search(r'%s\s*\[[^\]]*\]\s*=\s*\{(.*?)\}' % name, src, re.S)
        return [int(x, 0) for x in re.findall(r'-?\d+', m.group(1))]

    return arr('ringAtanTab'), arr('ringRecip')


def tab_atan2(dy, dx, atan, recip):
    """== bsp_ring.c 的 ring_tab_atan2(), 返回 0.5° 单位 (0..719)"""
    ax, ay = abs(dx), abs(dy)
    if ax == 0 and ay == 0:
        return 0
    if ay <= ax:
        maj = ax if ax < 129 else 128
        t = min((ay * recip[maj]) >> 8, 256)
        b = atan[t]; phi = b
    else:
        maj = ay if ay < 129 else 128
        t = min((ax * recip[maj]) >> 8, 256)
        b = atan[t]; phi = 180 - b
    if dx < 0: phi = 360 - phi
    if dy < 0: phi = -phi
    phi += 720
    if phi >= 720: phi -= 720
    if phi >= 720: phi -= 720
    return phi


def mac(src, name, default=None):
    m = re.search(r'^#define\s+%s\s+([^\s/]+)' % name, src, re.M)
    if not m:
        if default is None:
            raise SystemExit('ring_config.h 缺少 %s' % name)
        return default
    return m.group(1)


def main():
    src = open(CFG, encoding='utf-8', errors='ignore').read()
    CX = int(mac(src, 'RING_CX')); CY = int(mac(src, 'RING_CY'))
    RIN = int(mac(src, 'RING_R_IN')); ROUT = int(mac(src, 'RING_R_OUT'))
    START = int(mac(src, 'RING_ARC_START_DEF'))
    RANGE = int(mac(src, 'RING_ARC_SPAN_DEF'))
    N = int(mac(src, 'RING_SEG_N'))
    PITCH = int(mac(src, 'RING_SEG_PITCH_X10000'))
    BODY = int(mac(src, 'RING_SEG_BODY_X10000'))

    P_Q8 = (PITCH * 256 + 5000) // 10000
    BODY_Q8 = (BODY * 256 + 5000) // 10000
    ANG = 720

    atan_tab, recip_tab = load_tables()
    W, H = 240, 240
    rows = [{} for _ in range(N)]          # seg -> {y: [(x, is_body)...]}
    RIN2, ROUT2 = RIN * RIN, ROUT * ROUT
    for y in range(H):
        dy = y - CY
        for x in range(W):
            dx = x - CX
            r2 = dx * dx + dy * dy
            if r2 < RIN2 or r2 > ROUT2:
                continue
            a = int(round(math.degrees(math.atan2(dy, dx)) * 2)) % ANG
            rel = (a - START) % ANG
            if rel * 128 >= RANGE * 128:
                continue
            seg = (rel * 128) // P_Q8
            if seg >= N:
                continue
            rows[seg].setdefault(y, []).append((x, (rel * 128) - seg * P_Q8 < BODY_Q8))

    body = []
    ofs = [0] * (N + 1)
    n = 0
    maxn = 1
    for s in range(N):
        for y in sorted(rows[s]):
            px = sorted(rows[s][y])
            runs = []            # [(kind, x0, n)] kind: 1=body 0=gap
            i = 0
            while i < len(px):
                j = i
                while j + 1 < len(px) and px[j + 1][0] == px[j][0] + 1 and px[j + 1][1] == px[i][1]:
                    j += 1
                runs.append((1 if px[i][1] else 0, px[i][0], j - i + 1))
                i = j + 1
            b = next((r for r in runs if r[0] == 1), None)
            g = next((r for r in runs if r[0] == 0), None)
            if b is None and g is None:
                continue
            # 该行可能只有缝 (段体在这一行还没开始/已结束): 也要进表,
            # 否则点亮这一段时那一小块缝不会上暗槽色, 环上会出现 1~4px 的黑点。
            body.append((y, b[1] if b else 0, b[2] if b else 0,
                            g[1] if g else 0, g[2] if g else 0))
            maxn = max(maxn, (b[2] if b else 0) + (g[2] if g else 0))
            n += 1
        ofs[s + 1] = n

    total = len(body)
    size = total * 5 + (N + 1) * 2
    hdr = []
    hdr.append('/* ring_seg_spans.h —— 由 tools/ring_sim/gen_ring_spans.py 生成, 请勿手改。')
    hdr.append(' *')
    hdr.append(' * 圆环每段的逐行几何: 段体 (xb,nb) + 缝/分隔线 (xg,ng)。')
    hdr.append(' * 段体色随点亮状态变 (ringGrad70[seg] / arcTrack), 缝色同理 (暗槽色 / arcTrack)。')
    hdr.append(' *')
    hdr.append(' * 生成参数 (来自 ring_config.h): C=(%d,%d) R=%d..%d 起始=%d(0.5°) 跨度=%d(0.5°)'
               % (CX, CY, RIN, ROUT, START, RANGE))
    hdr.append(' *                               N=%d PITCH=%d BODY=%d (x0.0001°)' % (N, PITCH, BODY))
    hdr.append(' * 表大小: %d 行 × 5B + 偏移 %d × 2B = %d B' % (total, N + 1, size))
    hdr.append(' */')
    hdr.append('#ifndef __RING_SEG_SPANS_H__')
    hdr.append('#define __RING_SEG_SPANS_H__')
    hdr.append('')
    hdr.append('#include <stdint.h>')
    hdr.append('')
    hdr.append('/* 几何指纹: bsp_ring.c 编译期核对, 表过期(改了 ring_config.h 却没重跑')
    hdr.append(' * gen_ring_spans.py) 直接 #error, 不会画出错位的环。 */')
    hdr.append('#define RING_SPAN_CFG_CX      %d' % CX)
    hdr.append('#define RING_SPAN_CFG_CY      %d' % CY)
    hdr.append('#define RING_SPAN_CFG_RIN     %d' % RIN)
    hdr.append('#define RING_SPAN_CFG_ROUT    %d' % ROUT)
    hdr.append('#define RING_SPAN_CFG_START   %d' % START)
    hdr.append('#define RING_SPAN_CFG_RANGE   %d' % RANGE)
    hdr.append('#define RING_SPAN_CFG_N       %d' % N)
    hdr.append('#define RING_SPAN_CFG_PITCH   %d' % PITCH)
    hdr.append('#define RING_SPAN_CFG_BODY    %d' % BODY)
    hdr.append('')
    hdr.append('#define RING_SPAN_SEGS      %d' % N)
    hdr.append('#define RING_SPAN_ROWS      %d' % total)
    hdr.append('#define RING_SPAN_MAX_N     %d      /* 单行最长跨度 (运行期缓冲大小) */' % maxn)
    hdr.append('')
    hdr.append('typedef struct {')
    hdr.append('    uint8_t y;      /* 行 */')
    hdr.append('    uint8_t xb;     /* 段体起始列 */')
    hdr.append('    uint8_t nb;     /* 段体像素数: 点亮 = ringGrad70[seg], 熄灭 = arcTrack */')
    hdr.append('    uint8_t xg;     /* 缝(分隔线)起始列, ng==0 时无意义 */')
    hdr.append('    uint8_t ng;     /* 缝像素数: 点亮 = 暗槽色, 熄灭 = arcTrack */')
    hdr.append('} RingSegRow;')
    hdr.append('')
    hdr.append('extern const RingSegRow  ringSegRows[RING_SPAN_ROWS];')
    hdr.append('extern const uint16_t    ringSegRowOfs[RING_SPAN_SEGS + 1];')
    hdr.append('')
    hdr.append('#endif')
    body_txt = []
    body_txt.append('')
    body_txt.append('const uint16_t ringSegRowOfs[RING_SPAN_SEGS + 1] = {')
    for i in range(0, N + 1, 12):
        body_txt.append('    ' + ', '.join('%4d' % v for v in ofs[i:i + 12]) + ',')
    body_txt.append('};')
    body_txt.append('')
    body_txt.append('const RingSegRow ringSegRows[RING_SPAN_ROWS] = {')
    for s in range(N):
        body_txt.append('    /* seg %2d: %d 行 */' % (s, ofs[s + 1] - ofs[s]))
        for k in range(ofs[s], ofs[s + 1]):
            y, xb, nb, xg, ng = body[k]
            body_txt.append('    { %3d, %3d, %2d, %3d, %2d },' % (y, xb, nb, xg, ng))
    body_txt.append('};')
    txt = '\n'.join(hdr) + '\n' + '\n'.join(body_txt) + '\n'
    new = txt
    if '--check' in sys.argv:
        cur = open(OUT, encoding='utf-8').read() if os.path.exists(OUT) else ''
        if cur != new:
            print('ring_seg_spans.h 过期, 请重新生成'); sys.exit(1)
        print('ring_seg_spans.h 是最新的 (%d 行, %d B)' % (total, size)); return
    open(OUT, 'w', encoding='utf-8').write(new)
    print('生成 %s: %d 段 %d 行, %d B' % (OUT, N, total, size))


main()
