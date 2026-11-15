"""AEROFORM energy surrogate: a small neural network that predicts a simulator's results for the demo house
instantly (room temperatures through the day, heating, cooling, peak loads, comfort).

  python -I training/train_surrogate.py simple      # learns the simplified heat balance (training/data/sim-simple.csv)
  python -I training/train_surrogate.py energyplus  # learns EnergyPlus 26.2 (training/data/sim-energyplus.csv)

Data comes from training/generate-sim-dataset.mjs; inputs and outputs are defined in
src/simulation/surrogate-features.js. Rows are split by index: 10% test (index % 10 == 0, never used for
training or model choice), 10% validation (index % 10 == 1, picks the best epoch), 80% training.
For the EnergyPlus model the test report also shows how far the simplified model is from EnergyPlus on the
same test rows (the two datasets draw identical inputs for the same index), so the surrogate's error can
be compared with the error of the physics model the app already runs.
Writes models/energy-surrogate-<engine>.json (weights as base64 float32; src/energy-surrogate.js runs it).
"""
import base64
import csv
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

ROOT = Path(__file__).resolve().parent.parent
ENGINE = sys.argv[1] if len(sys.argv) > 1 else 'simple'
EPOCHS = int(sys.argv[2]) if len(sys.argv) > 2 else 400
DATA = {'simple': ROOT / 'training/data/sim-simple.csv', 'energyplus': ROOT / 'training/data/sim-energyplus.csv'}
if os.environ.get('AEROFORM_SURROGATE_DATA'): DATA[ENGINE] = Path(os.environ['AEROFORM_SURROGATE_DATA'])
LABEL = {'simple': 'AEROFORM simplified heat balance 1.0', 'energyplus': 'EnergyPlus 26.2 (AEROFORM EnergyPlus adapter 1.0)'}
OUT = Path(os.environ.get('AEROFORM_SURROGATE_OUT', ROOT / 'models' / f'energy-surrogate-{ENGINE}.json'))
TOTALS = ['heating_kwh', 'cooling_kwh', 'peak_heating_kw', 'peak_cooling_kw', 'unmet_kh']
HIDDEN = [256, 256, 256]
# The EnergyPlus surrogate is fine-tuned from the simplified-model surrogate by default (set AEROFORM_SURROGATE_INIT=none to train from scratch).
_init = os.environ.get('AEROFORM_SURROGATE_INIT', str(ROOT / 'models/energy-surrogate-simple.json') if ENGINE == 'energyplus' else 'none')
INIT = None if _init == 'none' else Path(_init)
torch.manual_seed(7)
np.random.seed(7)
torch.set_num_threads(4)


def load(path):
    with open(path, newline='') as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = np.array([[float(v) for v in r] for r in reader if r], dtype=np.float64)
    first_target = header.index('heating_kwh')
    order = np.argsort(rows[:, 0])
    rows = rows[order]
    return header, rows[:, 0].astype(int), rows[:, 1:first_target], rows[:, first_target:], header[1:first_target], header[first_target:]


class Net(nn.Module):
    def __init__(self, n_in, n_out):
        super().__init__()
        sizes = [n_in, *HIDDEN]
        self.hidden = nn.ModuleList(nn.Linear(a, b) for a, b in zip(sizes, sizes[1:]))
        self.out = nn.Linear(sizes[-1], n_out)

    def forward(self, x):
        for layer in self.hidden:
            x = nn.functional.silu(layer(x))
        return self.out(x)


def main():
    header, index, X, Y, features, targets = load(DATA[ENGINE])
    print(f'{ENGINE}: {len(index)} rows, {X.shape[1]} inputs, {Y.shape[1]} outputs', flush=True)
    log_t = np.array([t in TOTALS for t in targets])
    Yt = np.where(log_t, np.log1p(np.maximum(Y, 0)), Y)
    test, val = index % 10 == 0, index % 10 == 1
    train = ~(test | val)
    x_mean, x_std = X[train].mean(0), X[train].std(0)
    x_std[x_std < 1e-6] = 1
    y_mean, y_std = Yt[train].mean(0), Yt[train].std(0)
    y_std[y_std < 1e-6] = 1
    # Fine-tuning: start from another surrogate of the same house (the simplified-model one has 5x more runs),
    # keeping its input/output scaling, so EnergyPlus only has to teach the differences.
    init = json.loads(INIT.read_text()) if INIT else None
    if init:
        x_mean, x_std = np.array(init['input_mean']), np.array(init['input_std'])
        y_mean, y_std = np.array(init['output_mean']), np.array(init['output_std'])
    norm_x = lambda a: torch.tensor((a - x_mean) / x_std, dtype=torch.float32)
    xtr, xva, xte = norm_x(X[train]), norm_x(X[val]), norm_x(X[test])
    ytr = torch.tensor((Yt[train] - y_mean) / y_std, dtype=torch.float32)
    yva = torch.tensor((Yt[val] - y_mean) / y_std, dtype=torch.float32)
    weight = torch.tensor(np.where(log_t, 4.0, 1.0), dtype=torch.float32)  # totals count more than single hours

    model = Net(X.shape[1], Y.shape[1])
    if init:
        w = np.frombuffer(base64.b64decode(init['weights']), dtype=np.float32)
        take = lambda spec: torch.tensor(w[spec['offset']:spec['offset'] + int(np.prod(spec['shape']))].reshape(spec['shape']).copy())
        for layer, saved in zip([*model.hidden, model.out], init['layers']):
            layer.weight.data, layer.bias.data = take(saved['weight']), take(saved['bias'])
    lr = 5e-4 if init else 2e-3
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-5)
    batch = 256
    steps = EPOCHS * ((len(xtr) + batch - 1) // batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.1)
    best, best_state, started = None, None, time.time()
    for epoch in range(EPOCHS):
        model.train()
        perm = torch.randperm(len(xtr))
        for s in range(0, len(xtr), batch):
            i = perm[s:s + batch]
            loss = (((model(xtr[i]) - ytr[i]) ** 2) * weight).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        model.eval()
        with torch.no_grad():
            v = float((((model(xva) - yva) ** 2) * weight).mean())
        if best is None or v < best:
            best, best_state = v, {k: t.clone() for k, t in model.state_dict().items()}
        if epoch % 25 == 0 or epoch == EPOCHS - 1:
            print(f'epoch {epoch + 1:4d}/{EPOCHS}  train {loss.item():.4f}  validation {v:.4f}  ({time.time() - started:.0f}s)', flush=True)
    model.load_state_dict(best_state); model.eval()

    def predict(xn):
        with torch.no_grad():
            p = model(xn).numpy().astype(np.float64) * y_std + y_mean
        return np.where(log_t, np.maximum(np.expm1(p), 0), p)

    def report(pred, truth):
        out = {}
        for k, name in enumerate(targets):
            if name in TOTALS:
                e = np.abs(pred[:, k] - truth[:, k])
                ss = ((truth[:, k] - truth[:, k].mean()) ** 2).sum()
                out[name] = {'mae': round(float(e.mean()), 3), 'mean_value': round(float(truth[:, k].mean()), 3),
                             'r2': round(float(1 - ((pred[:, k] - truth[:, k]) ** 2).sum() / ss), 4) if ss > 0 else None}
        hourly = np.array([n.startswith('t_') for n in targets])
        e = np.abs(pred[:, hourly] - truth[:, hourly])
        out['room_temperature_hourly_c'] = {'mae': round(float(e.mean()), 3), 'p95': round(float(np.percentile(e, 95)), 3)}
        zones = sorted({n[2:].rsplit('_', 1)[0] for n in targets if n.startswith('t_')})
        means = lambda a: np.stack([a[:, [targets.index(f't_{z}_{h:02d}') for h in range(24)]].mean(1) for z in zones], 1)
        out['room_temperature_daily_mean_c'] = {'mae': round(float(np.abs(means(pred) - means(truth)).mean()), 3)}
        elec = lambda a: a[:, targets.index('heating_kwh')] / 3.0 + a[:, targets.index('cooling_kwh')] / 3.2
        e = np.abs(elec(pred) - elec(truth))
        out['electricity_kwh'] = {'mae': round(float(e.mean()), 3), 'mean_value': round(float(elec(truth).mean()), 3)}
        return out

    pred_test = predict(xte)
    metrics = {'test_rows': int(test.sum()), 'train_rows': int(train.sum()), 'validation_rows': int(val.sum()),
               'surrogate_vs_' + ENGINE: report(pred_test, Y[test])}
    if ENGINE == 'energyplus' and DATA['simple'].exists():
        _, s_index, _, s_Y, _, s_targets = load(DATA['simple'])
        if s_targets == targets:
            lookup = {int(i): k for k, i in enumerate(s_index)}
            have = np.array([int(i) in lookup for i in index[test]])
            if have.all():
                simple = s_Y[[lookup[int(i)] for i in index[test]]]
                metrics['simplified_model_vs_energyplus'] = report(simple, Y[test])
    for k, v in metrics.items():
        print(k, json.dumps(v, indent=1) if isinstance(v, dict) else v)

    # Export. Layers are [out, in] weight matrices; activation SiLU on hidden layers, linear output.
    blobs, layers = [], []
    def blob(a):
        data = np.ascontiguousarray(a, dtype=np.float32)
        blobs.append(data.tobytes())
        return {'shape': list(data.shape), 'offset': (sum(len(b) for b in blobs) - len(blobs[-1])) // 4}
    for layer in [*model.hidden, model.out]:
        layers.append({'weight': blob(layer.weight.detach().numpy()), 'bias': blob(layer.bias.detach().numpy())})
    check_x = X[test][:3]
    OUT.write_text(json.dumps({
        'format': 'aeroform-energy-surrogate-v1', 'engine': ENGINE, 'learns': LABEL[ENGINE],
        'features': features, 'targets': targets, 'log1p_targets': [t for t in targets if t in TOTALS],
        'input_mean': x_mean.round(6).tolist(), 'input_std': x_std.round(6).tolist(),
        'output_mean': y_mean.round(6).tolist(), 'output_std': y_std.round(6).tolist(),
        'input_min': X[train].min(0).round(4).tolist(), 'input_max': X[train].max(0).round(4).tolist(),
        'activation': 'silu', 'layers': layers, 'weights': base64.b64encode(b''.join(blobs)).decode('ascii'),
        'training': {'rows': len(index), 'epochs': EPOCHS, 'hidden': HIDDEN, 'trained': time.strftime('%Y-%m-%d'),
                     'initialised_from': f'models/{INIT.name} (fine-tuned)' if INIT else 'random',
                     'data': f'training/generate-sim-dataset.mjs --engine {ENGINE}', 'house': 'AEROFORM demo house only (6 zones)'},
        'metrics': metrics,
        'check': {'inputs': check_x.tolist(), 'outputs': predict(norm_x(check_x)).round(4).tolist()}
    }, separators=(',', ':')))
    print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
