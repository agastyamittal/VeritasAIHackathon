"""Prepare hand images + 21 keypoints for AEROFORM HandNet (our own hand landmark model).

  python -I training/prepare_hands.py

Reads the downloaded archives directly (no extraction) and writes fixed-size crops to memory-mapped arrays in
training/data/hands/, so the whole set never has to fit in RAM:
  FreiHAND v2 (32,560 real hands x 4 backgrounds, 3D labels projected to 2D)  - research use only
  Rendered Hand Pose (41,258 synthetic renders, exact labels)                   - research use only
Keypoints use the MediaPipe/FreiHAND order: 0 wrist, then thumb, index, middle, ring, little, each base -> tip.
RHD lists fingers tip -> base and is reordered. RHD annotations are a Python pickle; they are read with a
restricted unpickler that only allows numpy arrays and plain containers, because unpickling can run code.
"""
import io
import json
import pickle
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'training' / 'data'
OUT = DATA / 'hands'
SIZE = 144  # stored crop size; training samples 128x128 views from it with scale/shift/rotation
FREI = DATA / 'freihand' / 'FreiHAND_pub_v2.zip'
FREI_EVAL = DATA / 'freihand' / 'FreiHAND_pub_v2_eval.zip'
RHD = DATA / 'rhd' / 'RHD_v1-1.zip'


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        import numpy._core.multiarray as multiarray
        if module in ('numpy.core.multiarray', 'numpy._core.multiarray') and name in ('_reconstruct', 'scalar'):
            return getattr(multiarray, name)
        if module == 'numpy' and name in ('ndarray', 'dtype'):
            return getattr(np, name)
        if module == '_codecs' and name == 'encode':  # Python 2 pickles rebuild array bytes with it; it only encodes text
            import _codecs
            return _codecs.encode
        raise pickle.UnpicklingError(f'blocked: {module}.{name}')


def rhd_to_mp(points):
    out = np.empty_like(points)
    out[0] = points[0]
    for f in range(5):
        for k in range(4):
            out[1 + 4 * f + k] = points[1 + 4 * f + (3 - k)]
    return out


def crop_square(img, cx, cy, side):
    """Square crop centred on (cx, cy), resized to SIZE; outside the image is black."""
    half = side / 2
    box = (int(round(cx - half)), int(round(cy - half)), int(round(cx - half)) + int(round(side)), int(round(cy - half)) + int(round(side)))
    canvas = Image.new('RGB', (box[2] - box[0], box[3] - box[1]))
    canvas.paste(img.crop((max(0, box[0]), max(0, box[1]), min(img.width, box[2]), min(img.height, box[3]))), (max(0, -box[0]), max(0, -box[1])))
    scale = SIZE / canvas.width
    return np.asarray(canvas.resize((SIZE, SIZE), Image.BILINEAR)), (box[0], box[1], scale)


class Writer:
    def __init__(self, name, capacity):
        OUT.mkdir(parents=True, exist_ok=True)
        self.name, self.n = name, 0
        self.images = np.lib.format.open_memmap(OUT / f'{name}_images.npy', mode='w+', dtype=np.uint8, shape=(capacity, SIZE, SIZE, 3))
        self.points = np.zeros((capacity, 21, 2), np.float32)
        self.visible = np.zeros((capacity, 21), np.uint8)
        self.present = np.zeros(capacity, np.uint8)
        self.source = np.zeros(capacity, np.uint8)

    def add(self, image, points, visible, present, source):
        self.images[self.n] = image
        self.points[self.n], self.visible[self.n], self.present[self.n], self.source[self.n] = points, visible, present, source
        self.n += 1

    def close(self):
        self.images.flush()
        np.savez(OUT / f'{self.name}_labels.npz', points=self.points[:self.n], visible=self.visible[:self.n], present=self.present[:self.n], source=self.source[:self.n], count=self.n)
        print(f'{self.name}: {self.n} samples ({int(self.present[:self.n].sum())} with a hand)', flush=True)


def freihand(path, prefix, images_dir, variants, writer):
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        find = lambda suffix: next(n for n in names if n.endswith(suffix))
        K = json.loads(z.read(find(f'{prefix}_K.json')))
        xyz = json.loads(z.read(find(f'{prefix}_xyz.json')))
        base = find(f'{images_dir}/rgb/00000000.jpg').rsplit('/', 1)[0]
        started = time.time()
        for v in range(variants):
            for i in range(len(K)):
                k, p = np.array(K[i]), np.array(xyz[i])
                uv = (k @ p.T).T
                uv = uv[:, :2] / uv[:, 2:3]
                img = Image.open(io.BytesIO(z.read(f'{base}/{v * len(K) + i:08d}.jpg'))).convert('RGB')
                scale = SIZE / img.width
                writer.add(np.asarray(img.resize((SIZE, SIZE), Image.BILINEAR)), uv * scale, np.ones(21), 1, 0)
                if writer.n % 5000 == 0:
                    print(f'  FreiHAND {writer.name} {writer.n} ({time.time() - started:.0f}s)', flush=True)


def rhd(split, writer, rng, negatives_per_image=0.15):
    with zipfile.ZipFile(RHD) as z:
        names = z.namelist()
        anno_name = next(n for n in names if n.endswith(f'anno_{split}.pickle'))
        annotations = SafeUnpickler(io.BytesIO(z.read(anno_name)), encoding='latin1').load()
        color_dir = anno_name.rsplit('/', 1)[0] + '/color'
        started = time.time()
        for sample_id, anno in sorted(annotations.items()):
            uv_vis = np.asarray(anno['uv_vis'], dtype=np.float64)
            img = Image.open(io.BytesIO(z.read(f'{color_dir}/{sample_id:05d}.png'))).convert('RGB')
            hands = []
            for h in (uv_vis[:21], uv_vis[21:]):
                vis = h[:, 2] > 0.5
                if vis.sum() >= 6:
                    pts = h[:, :2]
                    w, hgt = np.ptp(pts[vis, 0]), np.ptp(pts[vis, 1])
                    hands.append((vis.sum(), max(w, hgt), rhd_to_mp(pts), rhd_to_mp(vis[:, None])[:, 0]))
            if hands:
                hands.sort(key=lambda t: (t[0] >= 15, t[1]), reverse=True)
                _, extent, pts, vis = hands[0]
                c = (pts[vis].min(0) + pts[vis].max(0)) / 2
                side = max(60.0, extent * rng.uniform(1.9, 2.6))
                crop, (x0, y0, s) = crop_square(img, c[0], c[1], side)
                writer.add(crop, (pts - [x0, y0]) * s, vis.astype(np.uint8), 1, 1)
            # Negatives: background patches that contain no labelled hand point.
            if rng.random() < negatives_per_image or not hands:
                all_pts = uv_vis[uv_vis[:, 2] > 0.5, :2]
                for _ in range(8):
                    side = rng.uniform(90, 220)
                    cx, cy = rng.uniform(side / 2, img.width - side / 2), rng.uniform(side / 2, img.height - side / 2)
                    margin = side * 0.6
                    if not len(all_pts) or not np.any((np.abs(all_pts[:, 0] - cx) < margin) & (np.abs(all_pts[:, 1] - cy) < margin)):
                        crop, _ = crop_square(img, cx, cy, side)
                        writer.add(crop, np.zeros((21, 2)), np.zeros(21), 0, 1)
                        break
            if writer.n % 5000 < 2:
                print(f'  RHD {writer.name} {writer.n} ({time.time() - started:.0f}s)', flush=True)


if __name__ == '__main__':
    # python -I training/prepare_hands.py [freihand|rhd|all]  (each dataset writes its own files; training reads all of them)
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    rng = np.random.default_rng(3)
    if which in ('freihand', 'all'):
        for path in (FREI, FREI_EVAL):
            if not path.exists():
                sys.exit(f'Missing {path}. See training/README.md.')
        w = Writer('freihand_train', 32560 * 4); freihand(FREI, 'training', 'training', 4, w); w.close()
        w = Writer('freihand_test', 3960); freihand(FREI_EVAL, 'evaluation', 'evaluation', 1, w); w.close()
    if which in ('rhd', 'all'):
        if not RHD.exists():
            sys.exit(f'Missing {RHD}. See training/README.md.')
        w = Writer('rhd_train', 41258 * 2); rhd('training', w, rng); w.close()
        w = Writer('rhd_test', 2728 * 2); rhd('evaluation', w, rng); w.close()
