"""AEROFORM gesture classifier: trains a small MLP on MediaPipe hand landmarks.

Stages (run from the project root, with -I so nothing in the data folders can be imported):
  python -I training/train_gesture.py prepare   # HaGRIDv2 annotations.zip -> training/data/hagrid.npz
  python -I training/train_gesture.py train     # trains, evaluates, writes models/gesture-classifier.json

Data:
  HaGRIDv2 annotations with landmarks (variant of CC BY-SA 4.0; see training/README.md)
  Zenodo 10.5281/zenodo.20032888 static landmarks (CC BY 4.0), used only as an external test set.

The feature code below is mirrored exactly in src/gesture-classifier.js. The exported JSON carries reference
inputs and outputs, and tests/core.test.mjs checks that the JS implementation reproduces them.
"""
import csv
import io
import json
import math
import sys
import time
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'training' / 'data'
HAGRID_ZIP = DATA / 'hagrid' / 'annotations.zip'
ZENODO_ZIP = DATA / 'zenodo' / 'data.zip'
PREPARED = DATA / 'hagrid.npz'
OUTPUT = ROOT / 'models' / 'gesture-classifier.json'

CLASSES = ['open_palm', 'fist', 'point', 'thumbs_up', 'thumbs_down', 'ok', 'two_fingers', 'three_fingers', 'four_fingers', 'other']
# HaGRID gesture -> AEROFORM class. Every other HaGRID gesture, and no_gesture hands, become "other".
# In VR: thumbs up / down change floor; one, two, three and four fingers pick a layer; open palm walks forward.
# Finger patterns were checked on the landmarks (fingers clearly extended, thumb-index-middle-ring-little):
#   one 01000, peace / two_up 01100, three 01110, three2 / three_gun 11100, four 01111, like 10000 up, dislike 10000 down.
# HaGRID's "point" is a finger pointed at the camera (foreshortened, often reads as a fist); it is not
# "one finger up", so it goes to other. "three3" (index, middle, little) and "ok" (whose three raised fingers
# look like a three) are kept apart: three3 as other, ok as its own class, so neither is read as three fingers.
HAGRID_MAP = {'palm': 'open_palm', 'stop': 'open_palm', 'fist': 'fist', 'one': 'point',
              'like': 'thumbs_up', 'dislike': 'thumbs_down', 'ok': 'ok',
              'peace': 'two_fingers', 'peace_inverted': 'two_fingers', 'two_up': 'two_fingers', 'two_up_inverted': 'two_fingers',
              'three': 'three_fingers', 'three2': 'three_fingers', 'three_gun': 'three_fingers',
              'four': 'four_fingers'}
# Zenodo static labels (assumed meanings from the record: Open, Close, Pointer, Ok, Nice).
ZENODO_MAP = {'open': 'open_palm', 'close': 'fist', 'pointer': 'point', 'ok': 'ok', 'nice': 'thumbs_up'}
SEED = 7


def features(points):
    """points: (N, 21, 2) image-normalized x, y (x already multiplied by width/height when known).
    Returns (N, 42): wrist at origin, scaled by wrist->middle-knuckle length, mirrored so the index knuckle
    is to the right of the pinky knuckle (left and right hands look alike). Orientation is kept, so
    thumbs up and thumbs down stay different."""
    p = np.asarray(points, dtype=np.float64)
    p = p - p[:, :1, :]
    palm = np.linalg.norm(p[:, 9, :], axis=1)
    palm = np.where(palm < 1e-6, 1.0, palm)
    p = p / palm[:, None, None]
    flip = (p[:, 5, 0] - p[:, 17, 0]) < 0
    p[flip, :, 0] *= -1
    return p.reshape(len(p), 42).astype(np.float32)


def prepare():
    if not HAGRID_ZIP.exists():
        sys.exit(f'Missing {HAGRID_ZIP}. See training/README.md for the download.')
    splits = {}
    started = time.time()
    with zipfile.ZipFile(HAGRID_ZIP) as archive:
        names = [n for n in archive.namelist() if n.endswith('.json')]
        for name in sorted(names):
            parts = Path(name).parts
            if '.ipynb_checkpoints' in parts:  # notebook copies of other files, not extra data
                continue
            split = next((s for s in ('train', 'val', 'test') if s in parts), None)
            if split is None:
                continue
            with archive.open(name) as handle:
                records = json.load(handle)
            points, labels = splits.setdefault(split, ([], []))
            kept = 0
            for record in records.values():
                hands = record.get('hand_landmarks') or []
                for gesture, hand in zip(record.get('labels') or [], hands):
                    if not hand or len(hand) != 21:
                        continue
                    xy = [pt[:2] for pt in hand]
                    if any(len(pt) != 2 or not all(math.isfinite(v) for v in pt) for pt in xy):
                        continue
                    points.append(xy)
                    labels.append(CLASSES.index(HAGRID_MAP.get(gesture, 'other')))
                    kept += 1
            print(f'{name}: {kept} hands ({time.time() - started:.0f}s)', flush=True)
    arrays = {}
    for split, (points, labels) in splits.items():
        arrays[f'{split}_points'] = np.asarray(points, dtype=np.float32)
        arrays[f'{split}_labels'] = np.asarray(labels, dtype=np.int64)
        counts = np.bincount(arrays[f'{split}_labels'], minlength=len(CLASSES))
        print(split, len(labels), dict(zip(CLASSES, counts.tolist())))
    np.savez_compressed(PREPARED, **arrays)
    print('wrote', PREPARED)


def zenodo_test():
    """External test set: Zenodo static landmarks, 42 normalized X/Y columns after a label index."""
    if not ZENODO_ZIP.exists():
        return None
    with zipfile.ZipFile(ZENODO_ZIP) as archive:
        files = {Path(n).name.lower(): n for n in archive.namelist()}
        label_file = next((files[k] for k in files if k.startswith('static') and 'label' in k), None)
        data_file = next((files[k] for k in files if k.startswith('static') and 'label' not in k and k.endswith('.csv')), None)
        if not data_file:
            return None
        names = {}
        if label_file:
            for row in csv.reader(io.TextIOWrapper(archive.open(label_file), 'utf-8-sig')):
                if row and row[0].strip().isdigit():
                    names[int(row[0])] = row[1].strip().lower() if len(row) > 1 else ''
                elif row and len(row) == 1 and row[0].strip():
                    names[len(names)] = row[0].strip().lower()
        points, labels = [], []
        for row in csv.reader(io.TextIOWrapper(archive.open(data_file), 'utf-8-sig')):
            try:
                values = [float(v) for v in row]
            except ValueError:
                continue
            if len(values) != 43:
                continue
            target = ZENODO_MAP.get(names.get(int(values[0]), ''))
            if target is None:
                continue
            points.append(np.asarray(values[1:], dtype=np.float32).reshape(21, 2))
            labels.append(CLASSES.index(target))
    if not points:
        return None
    return np.asarray(points), np.asarray(labels), names


def augment(points, rng):
    """Random aspect (HaGRID image sizes are not in the annotations), rotation +/-20 deg, small jitter."""
    n = len(points)
    p = points.astype(np.float64).copy()
    p[:, :, 0] *= rng.uniform(0.7, 1.45, size=(n, 1))
    angle = np.radians(rng.uniform(-20, 20, size=n))
    c, s = np.cos(angle), np.sin(angle)
    centered = p - p[:, :1, :]
    rotated = np.stack([centered[..., 0] * c[:, None] - centered[..., 1] * s[:, None],
                        centered[..., 0] * s[:, None] + centered[..., 1] * c[:, None]], axis=-1)
    scale = np.linalg.norm(rotated[:, 9, :], axis=1)[:, None, None]
    rotated += rng.normal(0, 0.012, size=rotated.shape) * scale
    return rotated


def balanced_indices(labels, rng, per_class, other_factor=2):
    chosen = []
    for k in range(len(CLASSES)):
        idx = np.flatnonzero(labels == k)
        cap = per_class * (other_factor if CLASSES[k] == 'other' else 1)
        if len(idx) > cap:
            idx = rng.choice(idx, cap, replace=False)
        chosen.append(idx)
    return rng.permutation(np.concatenate(chosen))


def report(name, truth, predicted):
    k = len(CLASSES)
    matrix = np.zeros((k, k), dtype=np.int64)
    np.add.at(matrix, (truth, predicted), 1)
    accuracy = float((truth == predicted).mean())
    per_class = {}
    for i, label in enumerate(CLASSES):
        support = int(matrix[i].sum())
        if support == 0:
            continue
        recall = matrix[i, i] / support
        precision = matrix[i, i] / max(1, matrix[:, i].sum())
        per_class[label] = {'precision': round(float(precision), 4), 'recall': round(float(recall), 4), 'support': support}
    print(f'\n{name}: accuracy {accuracy:.4f} on {len(truth)} hands')
    for label, m in per_class.items():
        print(f"  {label:10s} precision {m['precision']:.3f}  recall {m['recall']:.3f}  n={m['support']}")
    return {'accuracy': round(accuracy, 4), 'hands': int(len(truth)), 'classes': per_class, 'confusion': matrix.tolist()}


def train():
    import torch
    from torch import nn

    torch.manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    data = np.load(PREPARED)
    train_points, train_labels = data['train_points'], data['train_labels']
    val_points, val_labels = data['val_points'], data['val_labels']
    test_points, test_labels = data['test_points'], data['test_labels']

    model = nn.Sequential(nn.Linear(42, 128), nn.ReLU(), nn.Dropout(0.15), nn.Linear(128, 128), nn.ReLU(),
                          nn.Dropout(0.15), nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, len(CLASSES)))
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    epochs = 14
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=3e-3, total_steps=epochs * 400)
    loss_fn = nn.CrossEntropyLoss(label_smoothing=0.05)
    val_x = torch.from_numpy(features(val_points))
    best, best_state = -1.0, None
    for epoch in range(epochs):
        model.train()
        idx = balanced_indices(train_labels, rng, per_class=60000)
        x = torch.from_numpy(features(augment(train_points[idx], rng)))
        y = torch.from_numpy(train_labels[idx])
        batch = max(1, math.ceil(len(idx) / 400))
        total = 0.0
        for step in range(400):
            sl = slice(step * batch, (step + 1) * batch)
            if sl.start >= len(idx):
                break
            optimizer.zero_grad()
            loss = loss_fn(model(x[sl]), y[sl])
            loss.backward()
            optimizer.step()
            scheduler.step()
            total += loss.item()
        model.eval()
        with torch.no_grad():
            predicted = model(val_x).argmax(1).numpy()
        # Balanced accuracy, so the large "other" class does not dominate model selection.
        recalls = [float((predicted[val_labels == k] == k).mean()) for k in range(len(CLASSES)) if (val_labels == k).any()]
        score = float(np.mean(recalls))
        print(f'epoch {epoch + 1:2d}  loss {total / 400:.4f}  val balanced accuracy {score:.4f}', flush=True)
        if score > best:
            best, best_state = score, {k: v.clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    model.eval()

    def predict(points):
        with torch.no_grad():
            return torch.softmax(model(torch.from_numpy(features(points))), 1).numpy()

    metrics = {'validation_balanced_accuracy': round(best, 4),
               'hagrid_test': report('HaGRIDv2 test (unseen people)', test_labels, predict(test_points).argmax(1))}
    external = zenodo_test()
    if external is not None:
        points, labels, names = external
        metrics['zenodo_external'] = report('Zenodo 20032888 static (other dataset)', labels, predict(points).argmax(1))
        metrics['zenodo_external']['label_names'] = {str(k): v for k, v in names.items()}

    layers = [m for m in model if isinstance(m, nn.Linear)]
    check_idx = rng.choice(len(test_points), 6, replace=False)
    check_points = test_points[check_idx]
    export = {
        'format': 'aeroform-gesture-mlp-v1',
        'classes': CLASSES,
        'features': 'xy21: subtract wrist, divide by |wrist->landmark9|, mirror x when x5 < x17; x scaled by image width/height first',
        'layers': [{'weights': layer.weight.detach().numpy().round(6).tolist(), 'bias': layer.bias.detach().numpy().round(6).tolist()} for layer in layers],
        'activation': 'relu',
        'training': {
            'data': 'HaGRIDv2 annotations with MediaPipe landmarks (train split); classes mapped per HAGRID_MAP',
            'mapping': HAGRID_MAP,
            'license_note': 'HaGRID is distributed under a variant of CC BY-SA 4.0; check its license before commercial use.',
            'epochs': epochs, 'seed': SEED, 'trained': time.strftime('%Y-%m-%d'),
        },
        'metrics': metrics,
        'checks': [{'points': p.round(6).tolist(), 'probabilities': q.round(5).tolist()}
                   for p, q in zip(check_points.astype(np.float64), predict(check_points.round(6)))],
    }
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(export, separators=(',', ':')))
    print(f'\nwrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.0f} KB)')


if __name__ == '__main__':
    stage = sys.argv[1] if len(sys.argv) > 1 else ''
    if stage == 'prepare':
        prepare()
    elif stage == 'train':
        train()
    else:
        sys.exit(__doc__)
