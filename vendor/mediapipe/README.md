# MediaPipe Hand Landmarker (third party, Apache-2.0)

AEROFORM's hand tracking uses Google's open-source MediaPipe Hand Landmarker, shipped with the app so nothing is downloaded at runtime. It is not trained by this project. See `LICENSE` (Apache License 2.0, from github.com/google-ai-edge/mediapipe).

| File | Source | SHA-256 |
| --- | --- | --- |
| `vision_bundle.mjs` | npm `@mediapipe/tasks-vision@0.10.14` | `e77f281f9619150d937023c355bae170e9120e3b9e43f1e23a2a7bee07197669` |
| `wasm/vision_wasm_internal.js` | npm `@mediapipe/tasks-vision@0.10.14` | `9440cf0cc0cea21800e31581ec32aeedcc5fbf9df4509796bbc7d3f99e52ab9c` |
| `wasm/vision_wasm_internal.wasm` | npm `@mediapipe/tasks-vision@0.10.14` | `f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc` |
| `hand_landmarker.task` | `storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |

The hashes were checked on 2026-11-15 against the published package and model, byte for byte. These are the same files the app used before version 0.5.0.

**Why this is used:** AEROFORM HandNet, the project's own landmark model (`training/train_handnet.py`), did well on dataset test images (0.34 palm-length error) but missed real hands and reported other objects as hands with the phone camera. MediaPipe is also the landmark format the AEROFORM gesture classifier was trained on (HaGRID's MediaPipe landmarks), so the gestures get the input they expect.
