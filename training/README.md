# AEROFORM gesture classifier

`models/gesture-classifier.json` is a small neural network (MLP, 42 → 128 → 128 → 64 → 10, about 31k weights) trained here on hand landmarks. It runs on top of MediaPipe Hand Landmarker, which is still the pretrained model that finds the 21 hand points. This model only decides which gesture those points make.

| Class | From HaGRID gestures | In AEROFORM (held about half a second) |
| --- | --- | --- |
| `open_palm` | palm, stop | Not a held command: an open hand held out walks you forward in VR (with a geometric open-hand check) |
| `fist` | fist | Clear the selection. Fist, then open hand within 1.2 s: go outside / back in (outside VR: interior / exterior) |
| `point` (one finger up) | one | Thermal layer |
| `two_fingers` | peace, peace_inverted, two_up, two_up_inverted | Airflow layer |
| `three_fingers` | three (index-middle-ring), three2 and three_gun (thumb-index-middle) | Heat loss layer |
| `four_fingers` | four (thumb tucked) | Architecture layer |
| `thumbs_up` | like | Up a floor |
| `thumbs_down` | dislike | Down a floor |
| `ok` | ok | Nothing. Kept as its own class because its three raised fingers would otherwise look like three fingers |
| `other` | all other gestures (including HaGRID's `point`, a finger aimed at the camera, and `three3`) and `no_gesture` hands | Nothing |

The finger pattern of every mapped HaGRID gesture was checked on its landmarks before mapping (for example `three` is 98% index-middle-ring, `three2` 98% thumb-index-middle, `four` 99% four fingers). A held sign fires once after 450 ms at 70% confidence or more; frames that drop out for up to 250 ms (blur, a misread frame) do not restart the hold (`createGestureCommands` in `src/gesture-classifier.js`).

## Datasets

| Dataset | Use | License | Size |
| --- | --- | --- | --- |
| [HaGRIDv2](https://github.com/hukenovs/hagrid) annotations with MediaPipe landmarks ([annotations.zip](https://rndml-team-cv.obs.ru-moscow-1.hc.sbercloud.ru/datasets/hagrid_v2/annotations_with_landmarks/annotations.zip)) | Train / validation / test, split by person | Variant of CC BY-SA 4.0; read the project's [license PDF](https://github.com/hukenovs/hagrid/blob/master/license/en_us.pdf) before commercial use | 719 MB zip, 1.37M hands, 2D landmarks |
| [Zenodo 10.5281/zenodo.20032888](https://zenodo.org/records/20032888) static landmarks | External test only | CC BY 4.0 | 3.2 MB, 15,029 hands, 5 classes |
| [Zenodo 10.5281/zenodo.18108472](https://zenodo.org/records/18108472) | Not used yet (its landmarks are pre-rotated, which would remove orientation) | CC BY 4.0 | 1 MB |

Images are not needed; only the landmark annotations are downloaded. Downloads go to `training/data/`, which is excluded from git and from the app.

## Results (2026-11-15, 10 classes)

| Test set | Accuracy | Notes |
| --- | --- | --- |
| HaGRIDv2 test (201,131 hands, people not in training) | 99.1% | Precision / recall: thumbs down 96.9 / 99.0%, three fingers 99.1 / 99.4%, four fingers 98.8 / 99.7%, two fingers 99.3 / 99.3%, thumbs up 97.6 / 99.3%, open palm 97.3 / 99.7%. One finger is lowest (93.5 / 96.1%) |
| Zenodo static (15,029 hands, different dataset, 5 of the classes) | 81.9% | Open palm 98%, thumbs up 99%, OK 83%, fist 66%, pointer 63% recall. Precision ≥ 98.5%: misses are labelled "other", not another command |

Earlier versions: 6 classes 99.2% / 83.9%, 7 classes (with two fingers) 99.0% / 84.6%. Zenodo's "pointer" recall fell from 79% to 63% because HaGRID's `point` (finger aimed at the camera) is no longer trained as one finger; the app's sign is one finger held up. The HaGRID test count fell from 233,315 to 201,131 because `prepare` now skips the dataset's `.ipynb_checkpoints` copies, which duplicated hands.
These are landmark-level results. They do not yet include the phone in the Gear VR, where the camera angle and lighting differ. Record your own clips to check that.

## Retrain

```powershell
# from the project root
mkdir training\data\hagrid, training\data\zenodo
curl.exe -L -o training\data\hagrid\annotations.zip https://rndml-team-cv.obs.ru-moscow-1.hc.sbercloud.ru/datasets/hagrid_v2/annotations_with_landmarks/annotations.zip
curl.exe -L -o training\data\zenodo\data.zip "https://zenodo.org/records/20032888/files/data.zip?download=1"
python -I training\train_gesture.py prepare   # about 2 minutes
python -I training\train_gesture.py train     # about 2 minutes on CPU
npm test                                      # checks the JS model matches the Python export
npm run android:apk
```

Needs Python 3 with NumPy and PyTorch (CPU is enough). Change the class mapping in `HAGRID_MAP` to add gestures. The JS side (`src/gesture-classifier.js`) reads the class list from the model file, and `app.js` decides what each gesture does.

## Features

Both `features()` in `train_gesture.py` and `gestureFeatures()` in `src/gesture-classifier.js`:

1. Take the 21 (x, y) image-normalized landmarks; x is multiplied by the camera's width/height.
2. Move the wrist (landmark 0) to the origin.
3. Divide by the wrist → middle-knuckle (landmark 9) length.
4. Mirror x when the index knuckle (5) is left of the pinky knuckle (17), so left and right hands match.

Orientation is kept, so thumbs up and thumbs down stay different. Training adds random aspect ratio (HaGRID does not store image sizes), ±20° rotation and small jitter.

# AEROFORM HandNet (our own hand landmark model; experiment, not used)

**Status: not used by the app.** On dataset test images HandNet did well (results below), but with the real phone camera it missed hands and reported other objects as hands. Its training images are cropped, centred hands from two research datasets (one synthetic), unlike a phone camera's view of a room, and it was never trained on scenes with no hand beyond RHD background patches. The app went back to Google's MediaPipe Hand Landmarker (`vendor/mediapipe/README.md`), which is also the landmark format the gesture classifier was trained on. On the same fake-camera test in Chrome, MediaPipe ran at 14 ms per frame on the GPU against HandNet's 52 ms, with fingertip errors of about 10-15 px against 20-60 px on a 400 px hand; neither reported a hand on a no-hand test pattern. Fixing HandNet would need training images like the headset's view (whole rooms, hands at the edge of the frame, many no-hand frames), labelled for real.

`models/handnet.json` finds a hand and its 21 points (same order as the gesture classifier: wrist, then thumb, index, middle, ring and little finger, base to tip) in a 128×128 camera image. It replaced Google's pretrained MediaPipe Hand Landmarker: **every model in the app is now trained here**. The network is designed and trained from random initialisation (no pretrained backbone), and runs in our own plain-JS inference (`src/handnet.js`) in a Web Worker, so no ML library is shipped either.

- **Architecture:** depthwise-separable encoder to 8×8, decoder with skip connections to 32×32 heatmaps, soft-argmax keypoints, and a hand-presence score. About 110k parameters, about 30M multiply-adds per frame.
- **Tracking:** the whole frame (letterboxed) is searched until a hand is found; after that, each frame is cropped around the last hand so it stays large in the input. Losing the hand returns to searching.
- **Data:** [FreiHAND v2](https://lmb.informatik.uni-freiburg.de/resources/datasets/FreihandDataset.en.html) (32,560 real hands × 4 backgrounds; labels made by the dataset authors) and [Rendered Hand Pose](https://lmb.informatik.uni-freiburg.de/resources/datasets/RenderedHandposeDataset.en.html) (41,258 synthetic renders, exact labels, plus background patches as "no hand" examples). Neither uses MediaPipe labels. **Both are for research use only; commercial use is not allowed.**
- **Augmentation (GPU):** hand size from small to filling the frame, shifts, ±40° rotation, mirroring, brightness/contrast/tint, greyscale, noise, and 4:3 letterbox bars.

```powershell
python -I training\prepare_hands.py          # reads the zips, writes crops to training\data\hands (about 13 GB)
python -I training\train_handnet.py 30 1.0   # epochs, width; needs CUDA PyTorch for reasonable speed
npm test                                     # checks the JS inference matches the PyTorch export
```

**Results (2026-11-15, 30 epochs, width 1.0, RTX 3060 laptop):** on the FreiHAND + RHD evaluation sets (6,916 crops, unseen in training), mean keypoint error 0.34 palm lengths (median 0.19), 53% of points within 0.2 palm lengths and 77% within 0.4, thumb-to-index (pinch) distance error 0.37 palm lengths, hand-presence accuracy 98.9%. About 100 s per epoch when the GPU is cool; a hot laptop GPU throttles to about 360 s. These are dataset results, not yet checked with the phone's camera in the headset.

# AEROFORM energy surrogates and the EnergyPlus adapter

The house temperature models are small neural networks (32 inputs → 3 × 256 SiLU → 161 outputs, about 170k weights) that predict a simulator's whole design-day result for the demo house in about 1 ms: each room's temperature for every hour plus its minimum and maximum, heating, cooling, peak loads and unmet comfort (degree-hours). Electricity and CO₂e follow from heating and cooling. Inputs (`src/simulation/surrogate-features.js`) are the construction options as physical values, setpoints, latitude, season, outdoor temperature, wind, and how many AC units and vents sit in each room after you move them.

| Model | Learns | Used in the app |
| --- | --- | --- |
| `models/energy-surrogate-energyplus.json` | EnergyPlus 26.2 runs of the house | Yes: the Analysis panel shows its estimate and test error next to the simplified physics result |
| `models/energy-surrogate-simple.json` | The simplified heat balance (`src/simulation`) | No; it is the comparison baseline |

**EnergyPlus adapter:** `src/simulation/energyplus.js` writes the house, design and weather as an EnergyPlus input file and reads the results back; `training/energyplus/run-energyplus.mjs` runs it (`node training/energyplus/run-energyplus.mjs winter` prints EnergyPlus next to the simplified model). EnergyPlus is downloaded once from the [official NREL release](https://github.com/NREL/EnergyPlus/releases/tag/v26.2.0) into `training/data/energyplus/` (BSD-3-style license; not shipped with the app). Set `ENERGYPLUS_EXE` to use another install.

## Data

`training/generate-sim-dataset.mjs` draws row *i* from its own random stream, so both engines get identical inputs for the same index and an interrupted run resumes. Ranges cover what the app allows: every construction option, heating setpoint 15–24 °C, cooling 22–30 °C, latitude −66 to 66, outdoor −20 to 45 °C (season from temperature, or a season preset), wind 0–15 m/s from N/E/S/W, ACs moved to any room (5% outside) and vents to any room on their floor. The split is by index: 10% test (never used for training or choosing the epoch), 10% validation, 80% training.

## Results (2026-11-15)

| Test set (held-out runs: 3,000 simplified, 600 EnergyPlus) | Simplified-model surrogate | EnergyPlus surrogate | Simplified model vs EnergyPlus |
| --- | --- | --- | --- |
| Hourly room temperature, mean error | 0.16 °C (95% within 0.46 °C) | 0.20 °C (95% within 0.54 °C) | 1.74 °C (95% within 4.99 °C) |
| Heating per day, mean error (R²) | 1.7 kWh of 61 (0.998) | 2.3 kWh of 59 (0.996) | 4.4 kWh of 59 (0.986) |
| Cooling per day, mean error (R²) | 1.7 kWh of 46 (0.997) | 2.0 kWh of 44 (0.996) | 5.7 kWh of 44 (0.973) |
| Electricity per day, mean error | 1.1 kWh of 35 | 1.4 kWh of 33 | 3.2 kWh of 33 |

The EnergyPlus surrogate is fine-tuned from the simplified-model surrogate (which learned the same house from 5× more runs), so EnergyPlus's 4,800 training runs only teach the differences; trained from scratch it reached 0.42 °C and 4.6 kWh heating error. The fine-tuning length (400 epochs) was chosen by validation loss. The last column is how far the physics model the app already runs is from EnergyPlus on the same test inputs; the EnergyPlus surrogate is useful where its error is clearly smaller than that. Both surrogates cover this demo house only.

## Retrain

```powershell
node training/generate-sim-dataset.mjs --engine simple --rows 30000 --out training/data/sim-simple.csv          # about 10 minutes
node training/generate-sim-dataset.mjs --engine energyplus --rows 6000 --workers 6 --out training/data/sim-energyplus.csv   # about 35-90 minutes
python -I training\train_surrogate.py simple       # about 8 minutes on CPU
python -I training\train_surrogate.py energyplus   # about 1 minute; fine-tunes from the simple one, so train that first
npm test                                           # JS inference matches the Python export; accuracy bar
```

On a laptop, EnergyPlus runs and HandNet training share one cooler and 16 GB of RAM: keep EnergyPlus to about 6 workers and the fans up, or GPU heat throttling slows HandNet about 3×.
