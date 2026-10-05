#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
砍到天亮 · BGM 合成器（纯代码，零外部素材 / 零模型）

为什么要这样合成：
  小游戏的 BGM 需要「无缝循环」。拿现成曲子剪一段通常有两处接不上 ——
  ① 混响/延迟的尾巴被截断，循环点每圈都「咔」一下
  ② 乐句不落在整小节上，接回去像少了一拍
  这里两条都正面解决：
  · 布局按「整小节」排（BPM × 小节数 = 精确秒数，128BPM × 16 小节 = 30.000s）
  · 渲染时多渲一段尾巴，再把尾巴**折回开头**（wrap-around），所以混响跨圈连续

编排（16 小节 = 4 个 4 小节循环，i–i–VI–VII）：
  1-2   起手：底鼓 + 低音铺底（清场感）
  3-4   加入八分踩镲 + 低音律动
  5-8   主歌：四踩底鼓 + 军鼓/拍手 + 16分踩镲 + 拨弦主音
  9-12  推进：换一句应答句，拉高
  13-16 顶点：主音回来，最后一拍桶鼓过门接回开头

用法：
  python3 tools/make-bgm.py                 # 出 30 秒循环（wav + mp3 + 循环点检测）
  python3 tools/make-bgm.py --stats         # 只打统计数据，不写文件
  python3 tools/make-bgm.py --bpm 140 --bars 16
  python3 tools/make-bgm.py --repeat 3      # 额外出一个连播 3 遍的版本（听循环点用）
"""
import argparse, json, math, os, sys
import numpy as np

SR = 44100

# ==================== 音高表 ====================
NOTE = {
    'F1': 43.65, 'G1': 49.00, 'A1': 55.00, 'C2': 65.41, 'D2': 73.42, 'E2': 82.41,
    'F2': 87.31, 'G2': 98.00, 'A2': 110.00, 'C3': 130.81, 'D3': 146.83, 'E3': 164.81,
    'F3': 174.61, 'G3': 196.00, 'A3': 220.00, 'B3': 246.94,
    'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23, 'G4': 392.00,
    'A4': 440.00, 'C5': 523.25, 'D5': 587.33, 'E5': 659.25, 'G5': 783.99, 'A5': 880.00,
}


# ==================== 基础工具 ====================
def env_exp(n, tau, atk=0.002, sr=SR):
    """指数衰减包络（atk 秒起振，tau 秒时间常数）。"""
    t = np.arange(n) / sr
    return np.exp(-t / max(tau, 1e-6)) * np.minimum(1.0, t / max(atk, 1e-6))


def one_pole_lp(x, fc, sr=SR):
    """一阶低通（只用于很短的打击音，长buffer别用这个）。"""
    a = 1.0 - math.exp(-2.0 * math.pi * fc / sr)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(x.shape[0]):
        acc += a * (x[i] - acc)
        y[i] = acc
    return y


def add_saw(x, start, dur, freq, amp, sr=SR, harmonics=None, atk=0.004, tau=0.35, detune=0.0):
    """加法合成锯齿（限谐波数，省事又不会有混叠），累加进 buffer。"""
    n = int(dur * sr)
    if n <= 0 or start >= x.shape[0]:
        return
    n = min(n, x.shape[0] - start)
    t = np.arange(n) / sr
    K = harmonics or max(1, int(1500.0 / max(freq, 20.0)))
    K = max(1, min(K, 32))
    ph = 2.0 * math.pi * (1.0 + detune) * freq * t
    y = np.zeros(n)
    for k in range(1, K + 1):
        y += np.sin((k * ph) + (k * 0.11)) / k
    y *= 1.0 / (1.0 + 0.35 * K / 12.0)
    x[start:start + n] += y * env_exp(n, tau, atk, sr) * amp


def add_sine(x, start, dur, freq, amp, sr=SR, tau=0.3, atk=0.004, pitch_to=None, pitch_tau=0.03):
    """正弦（可选音高下滑，用来做底鼓/桶鼓）。"""
    n = int(dur * sr)
    if n <= 0 or start >= x.shape[0]:
        return
    n = min(n, x.shape[0] - start)
    t = np.arange(n) / sr
    if pitch_to:
        f = pitch_to + (freq - pitch_to) * np.exp(-t / pitch_tau)
    else:
        f = np.full(n, float(freq))
    ph = 2.0 * math.pi * np.cumsum(f) / sr
    x[start:start + n] += np.sin(ph) * env_exp(n, tau, atk, sr) * amp


# ==================== 打击乐 ====================
def add_kick(x, t, amp=1.0, sr=SR):
    n = int(0.36 * sr)
    ln = min(n, x.shape[0] - t)
    if ln <= 0:
        return
    tt = np.arange(ln) / sr
    f = 44.0 + (118.0 - 44.0) * np.exp(-tt / 0.020)
    ph = 2.0 * math.pi * np.cumsum(f) / sr
    body = np.sin(ph) * env_exp(ln, 0.085, 0.0015, sr)
    # 点击声加 0.7ms 起振：不加的话 t=0 那一采样就是全幅随机噪声（= 循环点跳变源头）
    click = (np.random.default_rng(11).uniform(-1, 1, ln) * np.exp(-tt / 0.0035) * 0.35
             * np.minimum(1.0, tt / 0.0007))
    x[t:t + ln] += np.tanh((body + click) * 1.15) * 0.92 * amp


def add_clap(x, t, amp=1.0, sr=SR, seed=7):
    """拍手/军鼓：三段短噪声错开 + 一点体声。"""
    rng = np.random.default_rng(seed)
    n = int(0.20 * sr)
    ln = min(n, x.shape[0] - t)
    if ln <= 0:
        return
    tt = np.arange(ln) / sr
    y = np.zeros(ln)
    for off, g in ((0.000, 0.55), (0.008, 0.75), (0.017, 1.00)):
        s = int(off * sr)
        m = ln - s
        if m <= 0:
            continue
        nb = rng.uniform(-1, 1, m)
        nb = nb - one_pole_lp(nb, 1400.0, sr)          # 高通掉低频
        y[s:s + m] += nb * np.exp(-np.arange(m) / sr / (0.030 if off == 0.017 else 0.012)) * g
    tone = int(0.075 * sr)
    if tone > 0:
        y[:tone] += np.sin(2 * math.pi * 195.0 * tt[:tone]) * np.exp(-tt[:tone] / 0.028) * 0.22
    x[t:t + ln] += np.tanh(y * 1.1) * 0.40 * amp


def add_hat(x, t, amp=1.0, dur=0.035, open_=False, sr=SR, seed=3):
    rng = np.random.default_rng(seed)
    d = 0.150 if open_ else dur
    n = int(d * sr)
    ln = min(n, x.shape[0] - t)
    if ln <= 0:
        return
    nb = rng.uniform(-1, 1, ln)
    nb = nb - one_pole_lp(nb, 6500.0, sr)              # 高通：只留金属屑
    tau = 0.075 if open_ else 0.016
    x[t:t + ln] += nb * env_exp(ln, tau, 0.0004, sr) * 0.30 * amp


def add_tom(x, t, freq=180.0, amp=1.0, sr=SR):
    add_sine(x, t, 0.28, freq, 0.55 * amp, sr, tau=0.085, atk=0.002,
             pitch_to=freq * 0.62, pitch_tau=0.05)


def add_riser(x, t, dur=1.0, amp=0.35, sr=SR, seed=5):
    """过门前的一段上扬噪声。"""
    rng = np.random.default_rng(seed)
    n = int(dur * sr)
    ln = min(n, x.shape[0] - t)
    if ln <= 0:
        return
    tt = np.arange(ln) / sr
    nb = rng.uniform(-1, 1, ln)
    # 用「噪声 × 包络 + 频率上扬的正弦」近似上扬，比逐样本扫滤波器便宜且够用
    ramp = np.linspace(0.0, 1.0, ln)
    tone = np.sin(2 * math.pi * (300.0 + 900.0 * ramp ** 2) * tt) * 0.35
    x[t:t + ln] += (nb * 0.5 + tone) * (ramp ** 2.2) * amp


# ==================== 拨弦（Karplus-Strong） ====================
def pluck(freq, dur, sr=SR, bright=0.5, damp=0.9965, seed=0):
    """拨弦合成：一段噪声在延迟线上循环、每圈被低通滤一次 —— 就是弦的自然衰减。

    做出来接近琶音/古筝那种"弹一下就没了"的音色，正好配砍杀。
    """
    rng = np.random.default_rng(seed)
    N = max(2, int(round(sr / freq)))
    buf = rng.uniform(-1, 1, N) * bright
    n = int(dur * sr)
    periods = int(math.ceil(n / N)) + 1
    out = np.zeros(periods * N)
    for p in range(periods):
        out[p * N:(p + 1) * N] = buf
        # 平均滤波（+1 圈固定损耗）→ 高频先掉，听感就是"弦在衰减"
        buf = 0.5 * (buf + np.roll(buf, 1)) * damp
    out = out[:n]
    return out * env_exp(n, dur * 0.55, 0.0015, sr)


def add_pluck(x, t, name, amp=0.3, dur=0.9, pan_l=0.6, sr=SR, seed=0):
    """拨弦 + 八度微叠（让它在混音里站得住）。"""
    f = NOTE[name]
    y = pluck(f, dur, sr, 0.55, 0.9965, seed)
    oct_ = pluck(f * 2.0, dur * 0.5, sr, 0.35, 0.995, seed + 1) * 0.30
    y[:oct_.shape[0]] += oct_
    add_stereo(x, t, y * amp, pan_l, sr)


# ==================== 立体声工具 ====================
def add_stereo(stereo, t, mono, pan=0.0, sr=SR):
    """pan: -1 全左 / 0 中 / +1 全右（等功率）。"""
    ln = min(mono.shape[0], stereo.shape[1] - t)
    if ln <= 0:
        return
    th = (pan + 1.0) * math.pi / 4.0
    stereo[0, t:t + ln] += mono[:ln] * math.cos(th)
    stereo[1, t:t + ln] += mono[:ln] * math.sin(th)


# ==================== 编排 ====================
# 8 分音符网格；'-' = 空拍
MOTIF_A = {  # 5-8 小节 用的主音（i–VI–VII）
    1: ['A4', '-', 'C5', '-', 'E5', '-', 'D5', 'C5'],
    2: ['-', 'A4', '-', 'G4', '-', 'A4', '-', '-'],
    3: ['A4', '-', 'C5', '-', 'E5', '-', 'G5', 'E5'],
    4: ['D5', '-', 'C5', '-', 'A4', '-', '-', '-'],
}
MOTIF_B = {  # 9-12 小节 的应答句
    1: ['E5', '-', 'D5', '-', 'C5', '-', 'A4', '-'],
    2: ['C5', '-', 'D5', '-', 'E5', '-', 'G5', '-'],
    3: ['A5', '-', 'G5', '-', 'E5', '-', 'D5', '-'],
    4: ['C5', '-', '-', 'A4', '-', '-', '-', '-'],
}

CHORDS = [  # 每个 4 小节循环：i–i–VI–VII
    {'root': 'A1', 'pad': ['A2', 'C4', 'E4']},
    {'root': 'A1', 'pad': ['A2', 'C4', 'E4']},
    {'root': 'F1', 'pad': ['F2', 'A3', 'C4']},
    {'root': 'G1', 'pad': ['G2', 'B3', 'D4']},
]


def build(bpm=128.0, bars=16, sr=SR, tail=2.5):
    beat = 60.0 / bpm
    step = beat / 2.0                      # 8 分音符一格
    bar_len = 4 * beat
    loop_n = int(round(bars * bar_len * sr))
    total_n = loop_n + int(tail * sr)
    out = np.zeros((2, total_n), dtype=np.float64)

    def at(bar, s):
        """小节(1起) + 8分格(0起) → 样本位置"""
        return int(round((bar - 1) * bar_len * sr + s * step * sr))

    # ---- 分层（这才是"起手 → 推进 → 顶点"的骨架，不是把乐器一路堆满）----
    # 实测过一版：pad 从第 1 小节就响 + 一直四踩底鼓 ⇒ 16 小节 RMS 全在 -14.x，
    # 只有 3dB 起伏，"分层"根本听不出来。现在按小节表开关乐器。
    def layer(bar):
        if bar <= 2:
            return dict(kick='sparse', bass='half', hat=None, clap=False, pad=False, mel='tease')
        if bar <= 4:
            return dict(kick='sparse', bass='8th', hat='8th', clap=False, pad=False, mel=None)
        if bar <= 8:
            return dict(kick='four', bass='8th', hat='16th', clap=True, pad=True, mel='A')
        if bar <= 12:
            return dict(kick='four', bass='8th', hat='16th', clap=True, pad=True, mel='B')
        return dict(kick='four', bass='8th', hat='16th+', clap=True, pad=True, mel='A')

    pluck_seed = 100
    for bar in range(1, bars + 1):
        L = layer(bar)
        k_idx = (bar - 1) % 4

        # 底鼓（起手两小节轻一点，给后面留出空间）
        k_amp = 0.78 if bar < 5 else 0.86
        kick_steps = ((0,) if bar <= 2 else ((0, 4) if L['kick'] == 'sparse' else (0, 2, 4, 6)))
        for s in kick_steps:
            add_kick(out[0], at(bar, s), k_amp, sr)
            add_kick(out[1], at(bar, s), k_amp, sr)

        # 踩镲（偏右，撑宽度）
        if L['hat'] == '8th':
            for s in range(0, 8, 2):
                add_hat(out[1], at(bar, s), 0.55, seed=30 + bar)
        elif L['hat']:
            for s in range(8):
                acc = 0.95 if (L['hat'] == '16th+' and s % 2) else (0.62 if s % 2 else 0.38)
                add_hat(out[1], at(bar, s), acc, seed=40 + bar * 8 + s)
        if bar in (9, 13):
            add_hat(out[1], at(bar, 0), 0.95, open_=True, seed=99 + bar)

        # 拍手
        if L['clap']:
            for s in (2, 6):
                add_clap(out[0], at(bar, s), 0.78, seed=50 + bar)

        # 低音（清场段用长音铺底，节奏段落改成八分脉冲）
        root = CHORDS[k_idx]['root']
        b_tau = 0.50 if L['bass'] == 'half' else 0.14
        for s in (range(0, 8, 4) if L['bass'] == 'half' else range(0, 8, 2)):
            g = (0.92 if s % 4 == 0 else 0.64) * (0.26 if bar <= 2 else 0.36)
            add_saw(out[0], at(bar, s), step * 1.05, NOTE[root], g, sr,
                    harmonics=26, atk=0.006, tau=b_tau)
            add_saw(out[1], at(bar, s), step * 1.05, NOTE[root], g, sr,
                    harmonics=26, atk=0.006, tau=b_tau)

        # 铺底 pad：**第 5 小节才进来** —— 它是最明显的一次"加了一层"
        if L['pad'] and bar % 2 == 1:
            dur = bar_len * 2.0
            for nm in CHORDS[k_idx]['pad']:
                f = NOTE[nm]
                for ch, det in ((0, -0.0012), (1, 0.0012)):
                    gain = 0.052 * (1.0 + 0.30 * (bar >= 9))
                    add_saw(out[ch], at(bar, 0), dur, f, gain, sr,
                            harmonics=7, atk=0.45, tau=dur * 0.60, detune=det)

        # 拨弦主音（真正撑住"东方/砍杀"那个味道的就是它，音量给足）
        mel = None
        if L['mel'] == 'A':
            mel = MOTIF_A[k_idx + 1]
        elif L['mel'] == 'B':
            mel = MOTIF_B[k_idx + 1]
        elif L['mel'] == 'tease' and bar == 2:
            mel = ['A4', '-', '-', '-', 'E5', '-', '-', '-']   # 第 2 小节先露一句
        if mel:
            for s, nm in enumerate(mel):
                if nm == '-':
                    continue
                pluck_seed += 1
                amp = 0.34 if bar < 9 else (0.40 if bar < 13 else 0.36)
                add_pluck(out, at(bar, s), nm, amp, 0.85, pan_l=-0.35, sr=sr, seed=pluck_seed)

    # ---- 过门 ----
    add_riser(out[0], at(4, 4), dur=beat * 2, amp=0.30, sr=sr, seed=61)
    add_riser(out[1], at(12, 4), dur=beat * 2, amp=0.34, sr=sr, seed=62)
    for i, f in enumerate((150.0, 185.0, 225.0, 270.0)):        # 最后 4 个 16 分桶鼓
        tt = int(round(at(bars, 4) + i * (beat / 4) * sr))
        add_tom(out[0], tt, f, 0.85, sr)
        add_tom(out[1], tt, f, 0.85, sr)

    # ---- 尾巴折回开头（无缝循环的关键） ----
    fold = total_n - loop_n
    out[:, :fold] += out[:, loop_n:loop_n + fold]

    # ---- 收尾：去直流 → 软限幅 → 归一到 -1.0 dBFS ----
    out -= out.mean(axis=1, keepdims=True)
    out = np.tanh(out * 1.05) * 0.97
    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out *= 0.891 / peak                  # -1 dBFS
    return out[:, :loop_n], loop_n


# ==================== 检查 ====================
def report(x, loop_n, bpm, bars, sr=SR):
    n = x.shape[1]
    mono = x.mean(axis=0)
    beat = 60.0 / bpm
    bar_len = 4 * beat
    print(f'  时长            {n / sr:.6f} s   ({bars} 小节 @ {bpm:g} BPM，理论 {bars * bar_len:.6f} s)')
    print(f'  峰值            {np.max(np.abs(x)):.4f} ({20 * math.log10(max(np.max(np.abs(x)), 1e-9)):+.2f} dBFS)')
    print(f'  整体 RMS        {20 * math.log10(max(np.sqrt((mono ** 2).mean()), 1e-9)):+.2f} dBFS')
    # 每 2 小节一段的能量（看弧线：起手 → 顶点）
    print('  能量弧线（每 2 小节 RMS）：')
    seg = int(round(2 * bar_len * sr))
    vals = []
    for i in range(0, n, seg):
        chunk = mono[i:i + seg]
        r = math.sqrt((chunk ** 2).mean())
        vals.append(20 * math.log10(max(r, 1e-9)))
    bars_txt = ''.join('▁▂▃▄▅▆▇█'[min(7, max(0, int((v - min(vals)) / max(1e-6, max(vals) - min(vals)) * 7.99)))] for v in vals)
    print('    ' + bars_txt + '   ' + '  '.join(f'{v:.1f}' for v in vals))
    # 循环点连续性：⚠️ 别拿"平均相邻差"当基准 —— 底鼓/拍手的起音本身就是一次大跳变，
    # 平均差会被整段音乐摊薄，于是正常的鼓点也会被判成"有咔哒声"。基准要用分位数。
    d = np.abs(np.diff(mono))
    p999 = float(np.percentile(d, 99.9))
    seam = abs(float(mono[0] - mono[-1]))
    ok = seam <= max(p999, 1e-9)
    print(f'  循环点跳变      {seam:.4f}  (相邻差 p99.9={p999:.4f}、曲内最大 {d.max():.4f} → '
          f'{seam / max(p999, 1e-9):.2f}×  {"OK" if ok else "⚠️ 比鼓点还大，可能有咔哒"})')
    # 头尾 0.5 秒的能量：都不该是静音（否则循环点会有"空档"）
    h = int(0.5 * sr)
    print(f'  头 0.5s RMS    {20 * math.log10(max(math.sqrt((mono[:h] ** 2).mean()), 1e-9)):+.2f} dBFS')
    print(f'  尾 0.5s RMS    {20 * math.log10(max(math.sqrt((mono[-h:] ** 2).mean()), 1e-9)):+.2f} dBFS')
    print(f'  削波采样数      {int(np.sum(np.abs(x) >= 0.999))}')
    # 分层是否真的做出来了：起手段 → 顶点段的落差（<5dB 就等于"分层白做"）
    arc = max(vals) - vals[0]
    print(f'  起手→顶点落差   {arc:.1f} dB  {"OK" if arc >= 5.0 else "⚠️ 太平（要 ≥5dB，检查 pad/鼓是不是一路全开）"}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bpm', type=float, default=128.0)
    ap.add_argument('--bars', type=int, default=16)
    ap.add_argument('--out', default='docs/bgm')
    ap.add_argument('--repeat', type=int, default=0, help='额外出一个连播 N 遍的版本（听循环点）')
    ap.add_argument('--stats', action='store_true')
    a = ap.parse_args()

    x, loop_n = build(a.bpm, a.bars)
    print('== 合成完成 ==')
    report(x, loop_n, a.bpm, a.bars)

    if a.stats:
        return
    os.makedirs(a.out, exist_ok=True)
    name = f'bgm-demo-{int(round(loop_n / SR))}s'
    wav = os.path.join(a.out, name + '.wav')
    import wave
    pcm = np.clip(x.T, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype('<i2')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm16.tobytes())
    print(f'  写出            {wav}  ({os.path.getsize(wav) / 1024:.0f} KB)')

    rewav = None
    if a.repeat:
        rep = np.tile(x, (1, a.repeat))
        rewav = os.path.join(a.out, name + f'-x{a.repeat}.wav')
        rpcm = np.clip(rep.T, -1.0, 1.0)
        with wave.open(rewav, 'wb') as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes((rpcm * 32767.0).astype('<i2').tobytes())
        print(f'  写出            {rewav}  ({os.path.getsize(rewav) / 1024:.0f} KB)')

    # wav 只留着试听/存档；实际进游戏用 mp3（体积差 10 倍）
    import subprocess, shutil
    if shutil.which('lame'):
        for src in [s for s in (wav, rewav) if s]:
            mp3 = src[:-4] + '.mp3'
            try:
                subprocess.run(['lame', '--quiet', '-b', '192', '-h', src, mp3], check=True)
                print(f'  写出            {mp3}  ({os.path.getsize(mp3) / 1024:.0f} KB)')
            except Exception as e:
                print(f'  (mp3 转换失败: {e})')
    print(json.dumps({'wav': wav, 'seconds': round(loop_n / SR, 3)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
