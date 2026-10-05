#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
低血心跳音（lowhp.wav）合成器 —— 纯代码，零外部素材。

为什么要单独做一个音：
  血条/经验条挪到左上角卡之后（2026-10 用户口径），"低血"这件事在打斗中很容易被忽略。
  视觉那两层（角色身上的红色心跳脉冲、屏幕四边泛红）在**眼睛正盯着怪**的时候都可能漏掉，
  所以补一层听觉：进低血档时来一记心跳。

为什么是"心跳"而不是警报声：
  它每 3.2 秒重复一次（见 cfg.feel.lowHp.repeat），是**背景性的提醒**，不是一次性事件。
  尖锐的警报声连着响会让人想把声音关掉；低频心跳（lub-dub）重复起来才不烦，而且和
  打击音（高频金属/木头）在频谱上分得开，不会被打击音盖住。

波形做法（就是两次"闷响"）：
  · 低频正弦（lub 58Hz / dub 46Hz）做主体，指数衰减 —— 这是"咚"的肉感
  · 每一次前面叠一个极短的宽频 click —— 没有它，纯低频在小喇叭上几乎听不见
    （手机外放放不出 50Hz，能听见的其实是那个 click 的边沿）
  · dub 比 lub 略轻、略短，两次间隔 0.155s —— 这个间隔太小会听成一下，太大就散成两下

用法：
  python3 tools/make-lowhp.py                 # 写 assets/audio/lowhp.wav
  python3 tools/make-lowhp.py --stats         # 只打统计，不写文件
  python3 tools/make-lowhp.py --out /tmp/x.wav
"""
import argparse, os, struct
import numpy as np

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, '..', 'assets', 'audio', 'lowhp.wav')


def thump(n, freq, decay, gain):
    """一次闷响：低频正弦 × 指数包络。attack 取 4ms —— 再快会有"啪"的爆音。"""
    t = np.arange(n) / SR
    env = np.exp(-t / decay)
    atk = np.minimum(1.0, t / 0.004)
    body = np.sin(2 * np.pi * freq * t) * env * atk
    return body * gain


def click(n, gain):
    """闷响前的一记"唇齿音"：宽频短噪声 + 高通感（用差分近似），给外放一点存在感。"""
    rng = np.random.default_rng(7)                       # 固定种子：每次生成的文件完全一样
    t = np.arange(n) / SR
    noise = rng.uniform(-1.0, 1.0, n)
    noise = np.diff(np.concatenate(([0.0], noise)))      # 一阶差分 = 粗高通
    env = np.exp(-t / 0.006) * np.minimum(1.0, t / 0.001)
    return noise * env * gain


def build():
    dur = 0.42            # dub 在 0.155s 起、长约 0.26s → 0.42s 刚好收干净，尾巴不留空（体积直接省 1/4）
    x = np.zeros(int(SR * dur))

    def place(sig, at):
        i = int(SR * at)
        j = min(len(x), i + len(sig))
        x[i:j] += sig[:j - i]

    place(thump(int(SR * 0.30), 58.0, 0.075, 0.95), 0.000)   # lub
    place(click(int(SR * 0.02), 0.16), 0.000)
    place(thump(int(SR * 0.26), 46.0, 0.062, 0.66), 0.155)   # dub（更轻更短）
    place(click(int(SR * 0.02), 0.10), 0.155)

    x *= 0.62                                                # 峰值留足余量：它要和打击音叠在一起
    peak = float(np.max(np.abs(x))) or 1.0
    if peak > 0.89:
        x *= 0.89 / peak
    fade = int(SR * 0.004)                                   # 头尾各 4ms 淡入淡出：防首尾爆音
    x[:fade] *= np.linspace(0.0, 1.0, fade)
    x[-fade:] *= np.linspace(1.0, 0.0, fade)
    return x


def write_wav(path, x):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    pcm = np.clip(x, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype('<i2')
    data = pcm.tobytes()
    with open(path, 'wb') as f:
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + len(data)))
        f.write(b'WAVEfmt ')
        f.write(struct.pack('<IHHIIHH', 16, 1, 1, SR, SR * 2, 2, 16))
        f.write(b'data')
        f.write(struct.pack('<I', len(data)))
        f.write(data)
    return len(data) + 44


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--stats', action='store_true')
    a = ap.parse_args()

    x = build()
    rms = float(np.sqrt(np.mean(x ** 2)))
    print('时长 %.3fs · 峰值 %.3f · RMS %.4f' % (len(x) / SR, float(np.max(np.abs(x))), rms))
    if a.stats:
        raise SystemExit(0)
    size = write_wav(a.out, x)
    print('%s  (%.1f KB)' % (os.path.normpath(a.out), size / 1024.0))
