"""AEROFORM HandNet: our own hand landmark model, trained from random initialisation (no pretrained weights).

  python -I training/train_handnet.py [epochs=30] [width=1.0]

Input: 128x128 RGB (a whole camera frame letterboxed, or a crop around the last hand). Output: 21 keypoints
(MediaPipe/FreiHAND order, image-normalised 0..1) from 32x32 heatmaps via soft-argmax, plus a hand-presence
score. Data: training/data/hands/ from prepare_hands.py (FreiHAND + Rendered Hand Pose, research use only).
All augmentation runs on the GPU. Writes models/handnet.json (folded batch-norm weights, base64 float32) and
training/data/handnet-metrics.json. The layer list in the export is what src/handnet.js executes.
"""
import base64
import copy
import json
import math
import os
import sys
import threading
import queue
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
HANDS = Path(os.environ.get('AEROFORM_HANDS_DIR', ROOT / 'training' / 'data' / 'hands'))
OUT = Path(os.environ.get('AEROFORM_HANDNET_OUT', ROOT / 'models' / 'handnet.json'))
INPUT, HEAT = 128, 32
EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
WIDTH = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
torch.manual_seed(5)
rng = np.random.default_rng(5)
ch = lambda c: max(8, int(round(c * WIDTH / 8)) * 8)


class ConvBN(nn.Module):
    def __init__(self, cin, cout, k=1, stride=1, groups=1, act=True):
        super().__init__()
        self.conv = nn.Conv2d(cin, cout, k, stride, k // 2, groups=groups, bias=False)
        self.bn = nn.BatchNorm2d(cout)
        self.act = act

    def forward(self, x):
        x = self.bn(self.conv(x))
        return F.relu(x) if self.act else x


def ds(cin, cout, stride=1):
    """Depthwise 3x3 (stride) + pointwise 1x1."""
    return nn.Sequential(ConvBN(cin, cin, 3, stride, groups=cin), ConvBN(cin, cout, 1))


class HandNet(nn.Module):
    def __init__(self):
        super().__init__()
        c1, c2, c3, c4, c5 = ch(16), ch(32), ch(48), ch(64), ch(128)
        self.stem = ConvBN(3, c1, 3, 2)                       # 64x64
        self.s64 = ds(c1, c2)                                   # 64
        self.s32 = nn.Sequential(ds(c2, c3, 2), ds(c3, c3))     # 32  (skip)
        self.s16 = nn.Sequential(ds(c3, c4, 2), ds(c4, c4), ds(c4, c4))  # 16 (skip)
        self.s8 = nn.Sequential(ds(c4, c5, 2), ds(c5, c5), ds(c5, c5), ds(c5, c5))  # 8
        self.skip16, self.up16 = ConvBN(c4, c5, 1, act=False), ds(c5, c4)
        self.skip32, self.up32 = ConvBN(c3, c4, 1, act=False), ds(c4, c4)
        self.head = nn.Conv2d(c4, 21, 1)
        self.presence = nn.Linear(c5, 1)

    def forward(self, x):
        x = self.s64(self.stem(x))
        f32 = self.s32(x)
        f16 = self.s16(f32)
        f8 = self.s8(f16)
        presence = self.presence(f8.mean((2, 3)))[:, 0]
        u = self.up16(F.relu(F.interpolate(f8, scale_factor=2, mode='nearest') + self.skip16(f16)))
        u = self.up32(F.relu(F.interpolate(u, scale_factor=2, mode='nearest') + self.skip32(f32)))
        return self.head(u), presence


def soft_argmax(heat):
    """heat (B,21,H,W) -> coords (B,21,2) in [0,1] image units (cell centres)."""
    b, k, h, w = heat.shape
    p = F.softmax(heat.reshape(b, k, -1), -1).reshape(b, k, h, w)
    xs = (torch.arange(w, device=heat.device) + 0.5) / w
    ys = (torch.arange(h, device=heat.device) + 0.5) / h
    return torch.stack([(p.sum(2) * xs).sum(-1), (p.sum(3) * ys).sum(-1)], -1)


class Loader:
    """Random batches across every prepared dataset for a split (*{split}_images.npy), read on a background thread."""
    def __init__(self, split, batch, shuffle=True):
        self.parts = []
        for labels_file in sorted(HANDS.glob(f'*{split}_labels.npz')):
            name = labels_file.name[:-len('_labels.npz')]
            labels = np.load(labels_file)
            n = int(labels['count'])
            self.parts.append((np.load(HANDS / f'{name}_images.npy', mmap_mode='r'), n, name))
            print(f'  {name}: {n} samples', flush=True)
        if not self.parts:
            sys.exit(f'No prepared data for {split} in {HANDS}. Run prepare_hands.py first.')
        all_labels = [np.load(HANDS / f'{name}_labels.npz') for _, _, name in self.parts]
        self.points = np.concatenate([l['points'] for l in all_labels])
        self.visible = np.concatenate([l['visible'] for l in all_labels])
        self.present = np.concatenate([l['present'] for l in all_labels])
        self.starts = np.cumsum([0] + [n for _, n, _ in self.parts])
        self.n = int(self.starts[-1])
        self.batch, self.shuffle = batch, shuffle

    def read(self, idx):
        out = np.empty((len(idx), *self.parts[0][0].shape[1:]), np.uint8)
        part = np.searchsorted(self.starts, idx, side='right') - 1
        for p in np.unique(part):
            sel = part == p
            out[sel] = self.parts[p][0][idx[sel] - self.starts[p]]
        return out

    def read_range(self, a, b):
        """Samples a..b-1 (global indices) as one contiguous copy per dataset file."""
        parts = []
        for p, (images, n, _) in enumerate(self.parts):
            lo, hi = max(a, self.starts[p]), min(b, self.starts[p] + n)
            if lo < hi: parts.append(np.array(images[lo - self.starts[p]:hi - self.starts[p]]))
        return np.concatenate(parts) if len(parts) > 1 else parts[0]

    def batches(self, chunk=1024, pool=6):
        """Reads contiguous chunks (fast, light on memory) in random order and shuffles within a pool of a few
        chunks, instead of jumping to random samples across a file much larger than free RAM."""
        starts = np.arange(0, self.n, chunk)
        if self.shuffle: starts = rng.permutation(starts)
        q = queue.Queue(maxsize=3)
        def work():
            for g in range(0, len(starts), pool):
                # One sequential read per chunk into RAM, then shuffle in memory. Picking single samples straight
                # from the memory-mapped file turns into small random page faults once the file is not cached.
                group = [(s0, min(s0 + chunk, self.n)) for s0 in starts[g:g + pool]]
                images = np.concatenate([self.read_range(a, b) for a, b in group])
                idx = np.concatenate([np.arange(a, b) for a, b in group])
                order = rng.permutation(len(idx)) if self.shuffle else np.arange(len(idx))
                for s in range(0, len(idx), self.batch):
                    o = order[s:s + self.batch]; sel = idx[o]
                    q.put((images[o], self.points[sel], self.visible[sel], self.present[sel]))
            q.put(None)
        threading.Thread(target=work, daemon=True).start()
        while (item := q.get()) is not None:
            yield item


def to_gpu(images, points, visible, present):
    img = torch.from_numpy(images).to(DEVICE, non_blocking=True).permute(0, 3, 1, 2).float() / 255
    return img, torch.from_numpy(points).to(DEVICE), torch.from_numpy(visible).to(DEVICE).float(), torch.from_numpy(present).to(DEVICE).float()


def augment(img, pts, vis, present, train=True):
    """Affine view (scale, shift, rotation, mirror) + colour; returns 128x128 inputs and normalised targets."""
    b, _, size, _ = img.shape
    dev = img.device
    pin = pts / size * 2 - 1  # stored pixels -> [-1,1]
    has = present > 0.5
    lo = torch.where(vis[..., None] > 0, pin, torch.full_like(pin, 9)).amin(1)
    hi = torch.where(vis[..., None] > 0, pin, torch.full_like(pin, -9)).amax(1)
    centre = torch.where(has[:, None], (lo + hi) / 2, torch.zeros_like(lo))
    extent = torch.where(has, (hi - lo).amax(1).clamp(min=0.05), torch.ones(b, device=dev))
    if train:
        target = torch.empty(b, device=dev).uniform_(0.45, 1.6)                 # hand extent in the output ([-1,1] => 2)
        angle = torch.empty(b, device=dev).uniform_(-0.7, 0.7)
        flip = torch.where(torch.rand(b, device=dev) < 0.5, -1.0, 1.0)
        room = (1 - target / 2).clamp(min=0) + 0.15
        where = (torch.rand(b, 2, device=dev) * 2 - 1) * room[:, None]
    else:
        target, angle = torch.full((b,), 1.1, device=dev), torch.zeros(b, device=dev)
        flip, where = torch.ones(b, device=dev), torch.zeros(b, 2, device=dev)
    s = torch.where(has, extent / target, torch.empty(b, device=dev).uniform_(0.5, 1.0) if train else torch.ones(b, device=dev))
    cos, sin = torch.cos(angle) * s, torch.sin(angle) * s
    A = torch.stack([torch.stack([cos * flip, -sin], -1), torch.stack([sin * flip, cos], -1)], 1)  # out -> in
    t = centre - (A @ where[..., None])[..., 0]
    theta = torch.cat([A, t[..., None]], 2)
    grid = F.affine_grid(theta, (b, 3, INPUT, INPUT), align_corners=False)
    out = F.grid_sample(img, grid, mode='bilinear', padding_mode='zeros', align_corners=False)
    pout = (torch.linalg.inv(A)[:, None] @ (pin - t[:, None])[..., None])[..., 0]
    if train:
        gain = torch.empty(b, 1, 1, 1, device=dev).uniform_(0.6, 1.4)
        bias = torch.empty(b, 1, 1, 1, device=dev).uniform_(-0.15, 0.15)
        tint = torch.empty(b, 3, 1, 1, device=dev).uniform_(0.85, 1.15)
        out = (out * gain * tint + bias)
        grey = torch.rand(b, device=dev) < 0.1
        out[grey] = out[grey].mean(1, keepdim=True).expand(-1, 3, -1, -1)
        out = out + torch.randn_like(out) * torch.empty(b, 1, 1, 1, device=dev).uniform_(0, 0.04)
        bars = torch.rand(b, device=dev) < 0.3                                # letterboxed 4:3 camera frames
        out[bars, :, :16] = 0; out[bars, :, -16:] = 0
        out = out.clamp(0, 1)
    inside = ((pout.abs() <= 1).all(-1)).float()
    weight = vis * inside * has[:, None].float()
    return out, (pout + 1) / 2, weight


def palm_len(p):
    return (p[:, 0] - p[:, 9]).norm(dim=-1).clamp(min=1e-3)


def evaluate(model, split):
    model.eval()
    errors, pinch_err, pres_ok, pres_n = [], [], 0, 0
    with torch.no_grad():
        for batch in Loader(split, 256, shuffle=False).batches():
            img, pts, vis, present = to_gpu(*batch)
            x, target, weight = augment(img, pts, vis, present, train=False)
            heat, logit = model(x)
            pred = soft_argmax(heat)
            pres_ok += int(((torch.sigmoid(logit) > 0.5).float() == present).sum()); pres_n += len(present)
            has = present > 0.5
            if has.any():
                p, tg, w = pred[has], target[has], weight[has]
                e = (p - tg).norm(dim=-1) / palm_len(tg)[:, None]
                errors.append(e[w > 0].cpu())
                d_pred, d_true = (p[:, 4] - p[:, 8]).norm(dim=-1), (tg[:, 4] - tg[:, 8]).norm(dim=-1)
                pinch_err.append(((d_pred - d_true).abs() / palm_len(tg)).cpu())
    e, pe = torch.cat(errors), torch.cat(pinch_err)
    model.train()
    return {'mean_error_palm': round(float(e.mean()), 4), 'median_error_palm': round(float(e.median()), 4),
            'pck_0.2_palm': round(float((e < 0.2).float().mean()), 4), 'pck_0.4_palm': round(float((e < 0.4).float().mean()), 4),
            'pinch_distance_error_palm': round(float(pe.mean()), 4), 'presence_accuracy': round(pres_ok / pres_n, 4)}


def fold(conv_bn):
    w = conv_bn.conv.weight.detach()
    bn = conv_bn.bn
    scale = bn.weight.detach() / torch.sqrt(bn.running_var + bn.eps)
    return (w * scale[:, None, None, None]).cpu().numpy(), (bn.bias.detach() - bn.running_mean * scale).cpu().numpy()


def export(model, metrics):
    layers, blobs = {}, []
    def blob(arr):
        data = np.ascontiguousarray(arr, dtype=np.float32)
        blobs.append(data.tobytes())
        return {'shape': list(data.shape), 'offset': sum(len(b) for b in blobs[:-1]) // 4}
    def cbn(name, m, act=None):
        w, b = fold(m)
        layers[name] = {'weight': blob(w), 'bias': blob(b), 'stride': m.conv.stride[0], 'groups': m.conv.groups, 'relu': m.act if act is None else act}
    def seq_ds(prefix, seq):
        blocks = [seq] if isinstance(seq[0], ConvBN) else list(seq)
        names = []
        for i, block in enumerate(blocks):
            cbn(f'{prefix}.{i}.dw', block[0]); cbn(f'{prefix}.{i}.pw', block[1]); names.append(f'{prefix}.{i}')
        return names
    cbn('stem', model.stem)
    graph = {'s64': seq_ds('s64', model.s64), 's32': seq_ds('s32', model.s32), 's16': seq_ds('s16', model.s16), 's8': seq_ds('s8', model.s8),
             'up16': seq_ds('up16', model.up16), 'up32': seq_ds('up32', model.up32)}
    cbn('skip16', model.skip16); cbn('skip32', model.skip32)
    layers['head'] = {'weight': blob(model.head.weight.detach().cpu().numpy()), 'bias': blob(model.head.bias.detach().cpu().numpy()), 'stride': 1, 'groups': 1, 'relu': False}
    layers['presence'] = {'weight': blob(model.presence.weight.detach().cpu().numpy()), 'bias': blob(model.presence.bias.detach().cpu().numpy())}
    # Reference outputs for the JS implementation test.
    # The same pattern is generated in JS (tests/core.test.mjs): fract(sin(i * 12.9898) * 43758.5453).
    i = np.arange(3 * INPUT * INPUT, dtype=np.float64)
    pattern = np.sin(i * 12.9898) * 43758.5453
    check = torch.from_numpy((pattern - np.floor(pattern)).astype(np.float32).reshape(1, 3, INPUT, INPUT))
    with torch.no_grad():
        # On the CPU in full float32: CUDA convolutions on recent GPUs default to TF32, which is less exact than
        # the JS implementation the reference is meant to check.
        heat, logit = copy.deepcopy(model).cpu().eval()(check)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        'format': 'aeroform-handnet-v1', 'input': INPUT, 'heatmap': HEAT, 'width': WIDTH, 'graph': graph, 'layers': layers,
        'weights': base64.b64encode(b''.join(blobs)).decode('ascii'),
        'training': {'data': 'FreiHAND v2 (4 backgrounds) + Rendered Hand Pose, research use only', 'init': 'random (no pretrained weights)',
                     'epochs': EPOCHS, 'trained': time.strftime('%Y-%m-%d')},
        'metrics': metrics,
        'check': {'input': 'fract(sin(i * 12.9898) * 43758.5453), CHW',
                  'keypoints': soft_argmax(heat).cpu().numpy()[0].round(5).tolist(), 'presence': round(float(logit[0]), 4)}
    }, separators=(',', ':')))
    print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)')


def main():
    model = HandNet().to(DEVICE)
    params = sum(p.numel() for p in model.parameters())
    print(f'HandNet width {WIDTH}: {params:,} parameters on {DEVICE}', flush=True)
    data = Loader('train', 128)
    steps = EPOCHS * math.ceil(data.n / 128)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps, pct_start=min(0.3, max(0.1, 3 / steps)))
    best, best_state, started, first = None, None, time.time(), 0
    # Resume after an interruption: a checkpoint is saved after every pass.
    checkpoint = OUT.with_name(OUT.stem + f'-checkpoint-w{WIDTH}-e{EPOCHS}.pt')
    if checkpoint.exists():
        saved = torch.load(checkpoint, map_location=DEVICE, weights_only=False)
        model.load_state_dict(saved['model']); opt.load_state_dict(saved['opt']); sched.load_state_dict(saved['sched'])
        first, best, best_state = saved['epoch'], saved['best'], saved['best_state']
        print(f'resuming after pass {first} (best so far {best})', flush=True)
    for epoch in range(first, EPOCHS):
        total, count = 0.0, 0
        for batch in data.batches():
            img, pts, vis, present = to_gpu(*batch)
            x, target, weight = augment(img, pts, vis, present)
            heat, logit = model(x)
            pred = soft_argmax(heat)
            coord = ((pred - target).abs().sum(-1) * weight).sum() / weight.sum().clamp(min=1)
            loss = coord * 10 + F.binary_cross_entropy_with_logits(logit, present) * 0.5
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step()
            total += loss.item(); count += 1
        m = evaluate(model, 'test')
        print(f'epoch {epoch + 1:2d}/{EPOCHS}  loss {total / count:.4f}  test {m}  ({time.time() - started:.0f}s)', flush=True)
        if best is None or m['mean_error_palm'] < best['mean_error_palm']:
            best, best_state = m, {k: v.detach().clone() for k, v in model.state_dict().items()}
        torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'sched': sched.state_dict(), 'epoch': epoch + 1, 'best': best, 'best_state': best_state}, checkpoint)
    model.load_state_dict(best_state); model.eval()
    metrics = {'test': best, 'parameters': params,
               'note': 'Errors are relative to palm length (wrist to middle knuckle). Test = FreiHAND evaluation + RHD evaluation, unseen in training.'}
    OUT.with_name(OUT.stem + '-metrics.json').write_text(json.dumps(metrics, indent=1))
    export(model, metrics)


if __name__ == '__main__':
    main()
