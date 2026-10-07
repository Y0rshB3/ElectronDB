#!/usr/bin/env python3
"""
Builds every app icon from build/vortaq-icon-source.png.

The source artwork is a rounded square on a black canvas. This script finds
the rounded square in the image (least-squares fit of a rounded rectangle to
the edge), makes everything outside it transparent with an antialiased edge,
and leaves the pixels inside untouched. Outputs:

  build/icon.png            1024x1024, full bleed (Windows/Linux/renderer)
  build/icon-mac.png        1024x1024 on Apple's icon grid (824px shape)
  build/icon.icns           macOS, every size of the iconset (needs iconutil)
  build/icon.ico            Windows, 16-256 (BMP entries below 256, PNG at 256)
  build/icons/<n>x<n>.png   Linux sizes
  src/renderer/src/assets/app-icon.png   256x256 for the renderer

Not part of the build: run it only when the artwork changes.
Requires Python 3 with Pillow and numpy (pip install pillow numpy) and, for
the .icns, macOS iconutil.
"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from io import BytesIO

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
SOURCE = os.path.join(BUILD, 'vortaq-icon-source.png')
EDGE_THRESHOLD = 12  # background is 0-2, the square's rim and fill are >= 24


def edge_points(lum):
    """Sub-pixel crossings of EDGE_THRESHOLD scanning rows and columns from outside."""
    pts = []

    def crossings(line):
        idx = np.nonzero(line > EDGE_THRESHOLD)[0]
        if len(idx) == 0:
            return None
        a, b = idx[0], idx[-1]
        la = a - 1 + (EDGE_THRESHOLD - line[a - 1]) / (line[a] - line[a - 1]) if a > 0 else a
        lb = b + (line[b] - EDGE_THRESHOLD) / (line[b] - line[b + 1]) if b < len(line) - 1 else b
        return la + 0.5, lb + 0.5

    for y in range(lum.shape[0]):
        c = crossings(lum[y])
        if c:
            pts += [(y + 0.5, c[0]), (y + 0.5, c[1])]
    for x in range(lum.shape[1]):
        c = crossings(lum[:, x])
        if c:
            pts += [(c[0], x + 0.5), (c[1], x + 0.5)]
    return np.array(pts)


def rounded_rect_sdf(ys, xs, cx, cy, a, b, r):
    qx = np.abs(xs - cx) - (a - r)
    qy = np.abs(ys - cy) - (b - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def fit_shape(lum):
    pts = edge_points(lum)
    x0, x1 = pts[:, 1].min(), pts[:, 1].max()
    y0, y1 = pts[:, 0].min(), pts[:, 0].max()
    cx, cy, a, b = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    best = None
    for r in np.arange(50, min(a, b), 0.5):
        d = rounded_rect_sdf(pts[:, 0], pts[:, 1], cx, cy, a, b, r)
        rms = float(np.sqrt((d ** 2).mean()))
        if best is None or rms < best[0]:
            best = (rms, float(np.abs(d).max()), r)
    rms, worst, r = best
    print(f'shape: centre=({cx:.1f},{cy:.1f}) half=({a:.1f},{b:.1f}) radius={r} rms={rms:.2f}px max={worst:.2f}px')
    if rms > 1.5:
        sys.exit('the source no longer looks like a rounded square; check the artwork')
    return cx, cy, a, b, r


def masked_master(src):
    rgb = np.asarray(src.convert('RGB')).astype(np.float64)
    lum = rgb.max(axis=2)
    cx, cy, a, b, r = fit_shape(lum)
    h, w = lum.shape
    ys, xs = np.mgrid[0:h, 0:w] + 0.5
    # Inset half a pixel so the source's own blend into black stays outside;
    # a one-pixel linear ramp gives the antialiased edge.
    d = rounded_rect_sdf(ys, xs, cx, cy, a, b, r) + 0.5
    alpha = np.clip(0.5 - d, 0, 1)
    rgba = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
    img = Image.fromarray(rgba, 'RGBA')
    # Square crop centred on the shape, 1px transparent margin around it.
    half = max(a, b) + 1
    box = tuple(int(round(v)) for v in (cx - half, cy - half, cx + half, cy + half))
    return img.crop(box)


def resized(img, size):
    return img.resize((size, size), Image.LANCZOS)


def on_mac_grid(img):
    """Apple's macOS icon grid: a 824px shape centred on a 1024px canvas."""
    canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    canvas.alpha_composite(resized(img, 824), (100, 100))
    return canvas


def write_ico(img, path, sizes=(16, 20, 24, 32, 40, 48, 64, 128, 256)):
    """ICO with BMP (32bpp BGRA + AND mask) entries and a PNG entry for 256."""
    entries = []
    for s in sizes:
        im = resized(img, s)
        if s >= 256:
            buf = BytesIO()
            im.save(buf, 'PNG')
            data = buf.getvalue()
        else:
            px = np.asarray(im)
            bgra = px[::-1, :, [2, 1, 0, 3]].tobytes()
            row = ((s + 31) // 32) * 4
            mask = bytearray()
            for y in range(s - 1, -1, -1):
                line = bytearray(row)
                for x in range(s):
                    if px[y, x, 3] == 0:
                        line[x // 8] |= 0x80 >> (x % 8)
                mask += line
            header = struct.pack('<IiiHHIIiiII', 40, s, s * 2, 1, 32, 0, len(bgra) + len(mask), 0, 0, 0, 0)
            data = header + bgra + bytes(mask)
        entries.append((s, data))
    out = bytearray(struct.pack('<HHH', 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for s, data in entries:
        dim = 0 if s >= 256 else s
        out += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in entries:
        out += data
    with open(path, 'wb') as f:
        f.write(out)


def write_icns(img, path):
    iconutil = shutil.which('iconutil')
    if not iconutil:
        print('iconutil not found (not macOS): build/icon.icns left as is')
        return
    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, 'icon.iconset')
    os.mkdir(iconset)
    for base in (16, 32, 128, 256, 512):
        resized(img, base).save(os.path.join(iconset, f'icon_{base}x{base}.png'))
        resized(img, base * 2).save(os.path.join(iconset, f'icon_{base}x{base}@2x.png'))
    subprocess.run([iconutil, '-c', 'icns', iconset, '-o', path], check=True)
    shutil.rmtree(tmp)


def main():
    master = resized(masked_master(Image.open(SOURCE)), 1024)
    master.save(os.path.join(BUILD, 'icon.png'), optimize=True)
    mac = on_mac_grid(master)
    mac.save(os.path.join(BUILD, 'icon-mac.png'), optimize=True)
    write_icns(mac, os.path.join(BUILD, 'icon.icns'))
    write_ico(master, os.path.join(BUILD, 'icon.ico'))
    linux = os.path.join(BUILD, 'icons')
    os.makedirs(linux, exist_ok=True)
    for s in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        resized(master, s).save(os.path.join(linux, f'{s}x{s}.png'), optimize=True)
    assets = os.path.join(ROOT, 'src', 'renderer', 'src', 'assets')
    os.makedirs(assets, exist_ok=True)
    resized(master, 256).save(os.path.join(assets, 'app-icon.png'), optimize=True)
    print('icons written')


if __name__ == '__main__':
    main()
