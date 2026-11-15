# AEROFORM verification — 2026-11-14

## Clap sensitivity slider, walking without an open hand (2026-11-15)

- Clap: one `sensitivity` setting (0-1) interpolates every threshold between CLAP_STRICT and CLAP_EAGER; slider in the hand dev view (saved, applied live), with a level meter and a microphone test outside VR. Synthetic: faintest clap heard is 0.5 of full scale at 0, 0.2 at the default 0.45, 0.08 or less at 1; speech, music, steady and swelling noise, consonant + vowel and a cough never fire even at 1. Chrome fake microphone with a loud, a medium and a faint clap: 1 heard at 10, 2 at 45, 3 at 90.
- Walking: cause found on 1,500 held-out HaGRID hands per class: the old rule (model OR geometry) read 30.0% of "other" hands and 8.0% of OK signs as an open palm; the new rule (model at 70% AND geometry) reads 0.0% of every non-palm class and 99.5% of open palms. Grace after the hand closes cut from 300 ms to 150 ms, glide hold from 400 ms to 250 ms.
- If you still drift with your hand down, check the dev view's Walk row: a rising step count means the accelerometer step walking (menu ☰ → Phone VR → Walk), not the hand.
- `npm test`: 80 of 80. `npm run test:browser`: 23 of 23. APK rebuilt and verified.

## Smoother rendering, clap dialled back (2026-11-15)

Measured in Chrome (Intel UHD GPU), 915×412 viewport at 2.6× pixel ratio, CPU throttled 4× to approximate a phone, VR on the Heat loss layer, fake camera, 5 s per case:

| Case | Before | After |
| --- | --- | --- |
| VR + hand tracking, hand model on the main thread | 25-33 fps, 63-96% of frames over 34 ms | (kept only as the fallback) |
| VR + hand tracking, hand model in a worker | - | 89-118 fps, 0% over 34 ms |
| VR, hands off: 3D drawing per frame | 10-12 ms | 4.6-5.5 ms |

- Changes: MediaPipe in `src/mediapipe-worker.js` (camera frames sent as ImageBitmaps; main-thread fallback); particles built once per frame and shared by both eyes in one buffer; open-hand walking applied every displayed frame. The worker detected hands in the fake-camera video at 17-19 detections per second.
- Clap: defaults between the two earlier settings (peak 0.1, 4× background, 2.5× onset). Synthetic: claps at 0.12-0.2 of full scale fire, 0.06 and a soft 4 ms click do not. Chrome fake microphone: the two-clap recording at 100%, 25% and 12% volume recentered twice each; talking 0 times.
- `npm test`: 78 of 78. `npm run test:browser`: 23 of 23. APK rebuilt and verified (39 assets, now including the worker).
- Not verified: frame rate and hand detection on the S24+ itself.

## Heat particles on the Thermal and Heat loss layers (2026-11-15)

- Thermal: red particle clusters per room from the simulated room temperature (count, colour and rise speed scale with warmth). Heat loss: six particle lanes per window and door from that opening's simulated heat flow, outward when heat is lost and inward when it is gained.
- Unit tests: winter heat leaves through all 12 openings (start inside the walls, end outside and higher); a 40 °C day reverses every lane; warmer rooms rise faster; a freezing house holds fewer particles; the renderer draws exactly the simulated particle counts and honours the floor filter.
- Chrome (SwiftShader) screenshots in mild and winter conditions: clusters sit inside the rooms, streams pass through the glazing; no page errors.
- `npm test`: 76 of 76. `npm run test:browser`: 23 of 23. APK rebuilt and verified (38 assets).

## New hand signs, VR controls guide, open-hand walk fix (2026-11-15)

- Reported: in the dev view an open palm was recognised but nothing moved, and the swipe/wave controls registered poorly.
- Cause, two parts: (1) open-hand walking runs only in VR, so nothing moves in the dev view outside VR (the dev view's new "Sign" row now says "walk forward (in VR only)"); (2) the walk timer restarted on every frame not read as open and whenever the hand moved 5% of the image within 300 ms, so on a phone it often never started. Replaying 1,500 held-out HaGRID open palms through the app's classifier and rules: 99.9% of frames read as open. In a 15 fps simulation where 90% of frames read open, the old rule walked for 41% of a 4 s hold, the new one (`createOpenHandWalk`: 400 ms to start, 300 ms dropout grace) for 90%. The old rule also counted four fingers as an open palm (99.9% of HaGRID `four` hands); the new one does not (0.1%).
- New signs: thumbs up / down = floor up / down; 1, 2, 3, 4 fingers = thermal, airflow, heat loss, architecture. Swipes and waves removed. The gesture classifier was retrained with thumbs down, three and four fingers (10 classes): 99.1% on 201,131 held-out HaGRID hands; results per class in `training/README.md`.
- Held signs fire after 450 ms; dropouts up to 250 ms do not restart the hold (unit tested, including flicker between two signs that must not fire).
- VR controls guide: shown on entering Phone VR, closed by Start, Escape, Back or a clap; "Don't show again" is stored; not shown when Lens fit opens VR. Browser test checks it fits the 915×412 phone screen (screenshot `test-results/phone-landscape-vr-guide.png`).
- `npm test`: 74 of 74 pass. `npm run test:browser`: 23 of 23 pass. APK rebuilt and verified.
- Not verified: the signs with a real hand through the headset camera.

## Clap sensitivity (2026-11-15)

- Reported on the phone: claps were often missed. The covered microphone in the headset hears a clap far quieter than in the open.
- `src/clap-detector.js` defaults lowered (peak 0.2 → 0.06, 5× → 3× background, 3× → 2× the quietest of the last three blocks, crest 2.5 → 2, fade test 35% → 50% within 45-200 ms). The onset's level is now its loudest block, so a clap that straddles two blocks is no longer rejected.
- The microphone is now read block by block (ScriptProcessor, timed by the audio clock) instead of polling an analyser every 20 ms, which could skip sound when the phone's timers ran late. The analyser polling stays as a fallback.
- Synthetic tests: the old settings missed claps below 0.3 of full scale; the new ones hear them down to 0.08. Claps that start near the end of a block, and claps with room echo, now count. A spoken consonant plus vowel, a cough-length burst, speech, music, steady and swelling noise still do not fire.
- Chrome with a fake microphone: the two-clap recording at full, 25% and 12% volume recentered twice each; the talking-like recording 0 times.
- `npm test`: 73 of 73 pass. `npm run test:browser`: complete, all checks pass.
- Not verified: the S24+ in the headset. Trade-off: other sharp clicks (a door latch, a dropped pen) may now recenter too.

## VR without buttons, two-finger swipe, clap, MediaPipe hand tracking (2026-11-15)

- `npm test`: **73 tests, 73 passed.** New or changed: the VR overlay contains no buttons except the lens-alignment one (hidden unless the target shows); entering VR starts hand tracking and the clap listener, leaving stops both; Lens fit and Walk work from the menu; the two-finger pose check and sideways swipe (quick sweep left/right once; slow drift, small moves and vertical moves do not count); the clap detector on synthetic audio (single, soft, double-counts-once and over background noise fire; speech-like syllables, music tones, steady loud noise and a swell do not); the clap listener asks for raw audio, fires once and releases the microphone, and reports refusal; the 7-class gesture model reproduces its PyTorch export and two fingers is not a held command; vendored MediaPipe matches the SHA-256 hashes documented in `vendor/mediapipe/README.md`, is served, cached and packaged, and falls back from GPU to CPU.
- `npm run test:browser` (installed Chrome): **23 of 23 passed**, including: no visible buttons in VR on desktop, phone portrait and phone landscape; Escape and the browser's Back leave VR without leaving the page; Lens fit from the menu; offline reload. The offline check now waits for the app's one-time reload when the service worker first takes control (caching about 17 MB with MediaPipe made that reload land mid-check).
- Chrome with a fake microphone (`--use-file-for-fake-audio-capture`): a recording with two claps 2 s apart recentered twice; a recording of loud talking-like syllables recentered 0 times. No page errors.
- Chrome with a fake camera playing held-out FreiHAND hands: MediaPipe 0.10.14 on the GPU, 14 ms per frame, fingertips within about 10-15 px on a 400 px hand (HandNet: 52 ms, 20-60 px); found the hand on 2 of the 3 images. On Chrome's no-hand test pattern: 0 detections in 219 frames.
- APK rebuilt (9.9 MB): 38 packaged files match source; permissions INTERNET, CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS; microphone not required. The Android permission handler now queues camera and microphone requests (VR asks for both at once) instead of denying the first.
- Not verified: anything on the phone in the Gear VR: the two-finger swipe with a real moving hand (no test video exists; the direction assumes the rear camera is not mirrored), clap detection with the S24+ microphone inside the headset and real room noise, and MediaPipe speed on the phone.

## Trained models and EnergyPlus (2026-11-15)

- `npm test`: **70 tests, 70 passed, 0 failed.** New: HandNet JS inference matches the PyTorch export (reference now computed on the CPU in float32; CUDA's TF32 made it 2e-4 off); both energy surrogates' JS inference matches PyTorch within 2e-3 relative and meets the accuracy bar (hourly room temperature error < 1 °C, heating/cooling R² > 0.95); the EnergyPlus export has the same zones, 14 windows and 4 doors as the simplified model (window area within 2%), paired interzone surfaces, cross-mixing both ways and AC capacity per zone; the CSV reader integrates energy and peaks correctly; surrogate features follow moved HVAC.
- EnergyPlus 26.2.0 ran 6,000 design-day simulations of the house with 0 failures (1 warning per run: ground temperature outside EnergyPlus's typical 15-25 °C range; 10 °C is intended).
- `npm run android:apk` and `scripts/verify-apk.ps1`: **36 packaged web assets match source byte-for-byte**, including `models/handnet.json` and `models/energy-surrogate-energyplus.json`. APK 1.6 MB.
- `npm run test:browser` (Playwright with the installed Chrome, `CHROME_PATH`): **23 of 23 checks passed** on desktop, phone portrait and phone landscape: startup with local assets, help, views and floors, layers, file chooser, VR with fullscreen/motion denied and exit/re-entry, lens fit (black corners, both alignment targets, saved settings), no runtime errors, WebGL-unavailable error, offline reload and cache migration. First complete run of this suite. Three test expectations were out of date and were updated: the startup Supabase file list is now answered locally (any other outside request still fails), an empty file replaces `.exe` as the rejected upload (any type is accepted since 0.4.0), and phones open Help from the menu.
- Analysis panel in Chrome (desktop and phone): the EnergyPlus-trained line shows 53.1 kWh / 15.7 °C (winter) and 42.8 kWh / 27.0 °C (summer) for the default design; EnergyPlus itself gives 52.6 / 15.7 and 42.2 / 27.0. No page errors.
- HandNet in Chrome with a fake camera: the worker loads the model and runs at 16 fps (52 ms per frame on the laptop CPU). On Chrome's test pattern presence stays 0.05 (no hand); fed held-out FreiHAND hands it reports a hand in 154 of 157 frames.
- Not verified: HandNet and the APK on the phone or through the Gear VR (frame rate and accuracy with the real camera); live Supabase upload/list (stubbed in the browser run).

## 0.5.0 additions (2026-11-15)

- TAP version 13
# Subtest: demo has two floors, valid dimensions, openings, furniture, HVAC, and honest provenance
ok 1 - demo has two floors, valid dimensions, openings, furniture, HVAC, and honest provenance
  ---
  duration_ms: 2.237
  ...
# Subtest: floor selection filters geometry and roof consistently across every view
ok 2 - floor selection filters geometry and roof consistently across every view
  ---
  duration_ms: 0.7401
  ...
# Subtest: state changes publish snapshots and reject unsupported energy results
ok 3 - state changes publish snapshots and reject unsupported energy results
  ---
  duration_ms: 0.4562
  ...
# Subtest: file selection accepts any file type and rejects missing, oversized, and empty files
ok 4 - file selection accepts any file type and rejects missing, oversized, and empty files
  ---
  duration_ms: 0.2055
  ...
# Subtest: stereo viewports cover even, odd, portrait, landscape and zero-sized layouts
ok 5 - stereo viewports cover even, odd, portrait, landscape and zero-sized layouts
  ---
  duration_ms: 0.3022
  ...
# Subtest: perspective matrix preserves aspect and maps near/far to clip planes
ok 6 - perspective matrix preserves aspect and maps near/far to clip planes
  ---
  duration_ms: 0.2342
  ...
# Subtest: lookAt positions camera at origin and preserves a right-handed orthonormal basis
ok 7 - lookAt positions camera at origin and preserves a right-handed orthonormal basis
  ---
  duration_ms: 0.5556
  ...
# Subtest: orientation quaternions remain normalized in portrait and both landscape orientations
ok 8 - orientation quaternions remain normalized in portrait and both landscape orientations
  ---
  duration_ms: 0.6782
  ...
# Subtest: cube triangles match face normals and produce 36 vertices
ok 9 - cube triangles match face normals and produce 36 vertices
  ---
  duration_ms: 0.5741
  ...
# Subtest: VR renders square eye textures and circular lens regions, then restores the mono viewport
ok 10 - VR renders square eye textures and circular lens regions, then restores the mono viewport
  ---
  duration_ms: 6.8073
  ...
# Subtest: S24+ lens centers have adjustable physical spacing with equal heights and no eye overlap
ok 11 - S24+ lens centers have adjustable physical spacing with equal heights and no eye overlap
  ---
  duration_ms: 0.514
  ...
# Subtest: automatic fit derives S24+ screen geometry and preserves 62 mm spacing at different resolutions
ok 12 - automatic fit derives S24+ screen geometry and preserves 62 mm spacing at different resolutions
  ---
  duration_ms: 0.4707
  ...
# Subtest: lens mapping keeps centers aligned, corners black, and both eyes isolated at every correction strength
ok 13 - lens mapping keeps centers aligned, corners black, and both eyes isolated at every correction strength
  ---
  duration_ms: 0.4246
  ...
# Subtest: parallel stereo has crossed near disparity, aligned far directions and a zero-depth option
ok 14 - parallel stereo has crossed near disparity, aligned far directions and a zero-depth option
  ---
  duration_ms: 4.919
  ...
# Subtest: lens framebuffer failures show an error instead of silently rendering a broken VR view
ok 15 - lens framebuffer failures show an error instead of silently rendering a broken VR view
  ---
  duration_ms: 1.0111
  ...
# Subtest: drag rotates overview, touch zoom stays bounded, and reset restores camera
ok 16 - drag rotates overview, touch zoom stays bounded, and reset restores camera
  ---
  duration_ms: 0.7326
  ...
# Subtest: VR drag changes the view without motion permission; sensors and recenter also respond
ok 17 - VR drag changes the view without motion permission; sensors and recenter also respond
  ---
  duration_ms: 2.4384
  ...
# Subtest: APK head tracking never alternates between native and browser coordinate frames
ok 18 - APK head tracking never alternates between native and browser coordinate frames
  ---
  duration_ms: 11.9565
  ...
# Subtest: browser VR ignores native bridge events and still follows browser motion
ok 19 - browser VR ignores native bridge events and still follows browser motion
  ---
  duration_ms: 1.3516
  ...
# Subtest: head tracking attenuates small alternating noise while following deliberate turns promptly
ok 20 - head tracking attenuates small alternating noise while following deliberate turns promptly
  ---
  duration_ms: 39.171
  ...
# Subtest: recenter clears pending smoothing and invalid/sign-flipped readings never shake the view
ok 21 - recenter clears pending smoothing and invalid/sign-flipped readings never shake the view
  ---
  duration_ms: 3.408
  ...
# Subtest: head tracking smoothing uses elapsed time consistently at 30, 60 and 120 fps
ok 22 - head tracking smoothing uses elapsed time consistently at 30, 60 and 120 fps
  ---
  duration_ms: 8.9784
  ...
# Subtest: preview particles follow floor filtering; simulated thermal tiles follow the floor too
ok 23 - preview particles follow floor filtering; simulated thermal tiles follow the floor too
  ---
  duration_ms: 1.3972
  ...
# Subtest: room navigation stays on isolated floors and reports graphics loss
ok 24 - room navigation stays on isolated floors and reports graphics loss
  ---
  duration_ms: 0.6067
  ...
# Subtest: WebGL absence fails with an actionable error
ok 25 - WebGL absence fails with an actionable error
  ---
  duration_ms: 0.2853
  ...
# Subtest: actual application starts, enables scene buttons, changes layers/views/floors and opens help
ok 26 - actual application starts, enables scene buttons, changes layers/views/floors and opens help
  ---
  duration_ms: 122.3671
  ...
# Subtest: actual VR button remains active after permission failures, supports room/recenter and repeated exit
ok 27 - actual VR button remains active after permission failures, supports room/recenter and repeated exit
  ---
  duration_ms: 99.0344
  ...
# Subtest: native VR bridge receives enter/exit; Android back exits stereo mode
ok 28 - native VR bridge receives enter/exit; Android back exits stereo mode
  ---
  duration_ms: 48.5849
  ...
# Subtest: lens fit controls update rendering, persist settings, show alignment and close correctly on Android Back
ok 29 - lens fit controls update rendering, persist settings, show alignment and close correctly on Android Back
  ---
  duration_ms: 94.6064
  ...
# Subtest: switching Auto and Manual preserves separate settings, including after restarting in Auto
ok 30 - switching Auto and Manual preserves separate settings, including after restarting in Auto
  ---
  duration_ms: 116.1565
  ...
# Subtest: older manual fits migrate without overriding Auto; malformed or unavailable storage remains usable
ok 31 - older manual fits migrate without overriding Auto; malformed or unavailable storage remains usable
  ---
  duration_ms: 182.5459
  ...
# Subtest: actual upload handler uses textContent, uploads any file, and keeps the demo for non-3D files
ok 32 - actual upload handler uses textContent, uploads any file, and keeps the demo for non-3D files
  ---
  duration_ms: 96.1946
  ...
# Subtest: STL and OBJ parsing: binary, ASCII, quads, negative indices; Z-up conversion and 8 m fit
ok 33 - STL and OBJ parsing: binary, ASCII, quads, negative indices; Z-up conversion and 8 m fit
  ---
  duration_ms: 5.2888
  ...
# Subtest: cloud client: Supabase REST calls, safe object names, listing, and actionable errors
ok 34 - cloud client: Supabase REST calls, safe object names, listing, and actionable errors
  ---
  duration_ms: 4.1174
  ...
# Subtest: actual cloud list renders names as text and loads a shared STL into the viewer
ok 35 - actual cloud list renders names as text and loads a shared STL into the viewer
  ---
  duration_ms: 177.0211
  ...
# Subtest: ray picking: box entry distance, misses, boxes behind, and the camera inside a box
ok 36 - ray picking: box entry distance, misses, boxes behind, and the camera inside a box
  ---
  duration_ms: 0.3742
  ...
# Subtest: pinch detection: palm-normalized ratio, hysteresis, hold frames, and lost hands
ok 37 - pinch detection: palm-normalized ratio, hysteresis, hold frames, and lost hands
  ---
  duration_ms: 0.6064
  ...
# Subtest: hand tracker: local MediaPipe assets, camera lifecycle, one selection per pinch, denial and fallback
ok 38 - hand tracker: local MediaPipe assets, camera lifecycle, one selection per pinch, denial and fallback
  ---
  duration_ms: 12.5357
  ...
# Subtest: renderer: cloud model replaces the house; center pinch selects and highlights; reticle draws
ok 39 - renderer: cloud model replaces the house; center pinch selects and highlights; reticle draws
  ---
  duration_ms: 2.4842
  ...
# Subtest: actual hand-tracking button reports a missing camera and stays usable
ok 40 - actual hand-tracking button reports a missing camera and stays usable
  ---
  duration_ms: 124.4473
  ...
# Subtest: actual startup failure shows retry and keeps help responsive; retry recovers when graphics return
ok 41 - actual startup failure shows retry and keeps help responsive; retry recovers when graphics return
  ---
  duration_ms: 93.1581
  ...
# Subtest: all local modules, cache entries, and HTML assets resolve without CDN dependencies
ok 42 - all local modules, cache entries, and HTML assets resolve without CDN dependencies
  ---
  duration_ms: 18.5169
  ...
# Subtest: HTTP server serves the app and module MIME types; rejects methods and private files
ok 43 - HTTP server serves the app and module MIME types; rejects methods and private files
  ---
  duration_ms: 49.1691
  ...
# Subtest: weather conditions: presets, clamped edits, custom detection, and summaries
ok 44 - weather conditions: presets, clamped edits, custom detection, and summaries
  ---
  duration_ms: 0.2752
  ...
# Subtest: actual weather pill, sim card, local open and menu help controls work and persist
ok 45 - actual weather pill, sim card, local open and menu help controls work and persist
  ---
  duration_ms: 148.7329
  ...
# Subtest: trained gesture model: JS features and inference reproduce the Python export; commands need a held gesture
ok 46 - trained gesture model: JS features and inference reproduce the Python export; commands need a held gesture
  ---
  duration_ms: 8.964
  ...
# Subtest: hand dev view: opens from the menu and VR, explains a missing camera, switches camera, and shows the log
ok 47 - hand dev view: opens from the menu and VR, explains a missing camera, switches camera, and shows the log
  ---
  duration_ms: 171.0801
  ...
# Subtest: hand tracker diagnostics: frames, fps, handedness, camera options and delegate choice
ok 48 - hand tracker diagnostics: frames, fps, handedness, camera options and delegate choice
  ---
  duration_ms: 0.7939
  ...
# Subtest: walking: steps from a walking signal move you; single bumps, sitting noise and slow sway do not
ok 49 - walking: steps from a walking signal move you; single bumps, sitting noise and slow sway do not
  ---
  duration_ms: 1.0095
  ...
# Subtest: open hand and grab offsets: geometry works for palm or back of hand, mirrored front camera
ok 50 - open hand and grab offsets: geometry works for palm or back of hand, mirrored front camera
  ---
  duration_ms: 0.4771
  ...
# Subtest: renderer: walking moves level in the look direction; grabbing the AC moves its whole group and saves offsets
ok 51 - renderer: walking moves level in the look direction; grabbing the AC moves its whole group and saves offsets
  ---
  duration_ms: 2.9036
  ...
# Subtest: fist then open hand toggles once; open without a fist, or too late, does nothing
ok 52 - fist then open hand toggles once; open without a fist, or too late, does nothing
  ---
  duration_ms: 0.1883
  ...
# Subtest: actual walk toggle and reset moved items controls persist
ok 53 - actual walk toggle and reset moved items controls persist
  ---
  duration_ms: 52.4189
  ...
# Subtest: simulation geometry: zones tile each floor, openings match the 3D windows, HVAC assigned by position
ok 54 - simulation geometry: zones tile each floor, openings match the 3D windows, HVAC assigned by position
  ---
  duration_ms: 0.8079
  ...
# Subtest: simulation physics: energy balance closes over the day and every design change moves results the right way
ok 55 - simulation physics: energy balance closes over the day and every design change moves results the right way
  ---
  duration_ms: 81.6498
  ...
# Subtest: weather: sun angles at 45 N and facade sunlight follow the season
ok 56 - weather: sun angles at 45 N and facade sunlight follow the season
  ---
  duration_ms: 0.4165
  ...
# Subtest: optimizer: every listed improvement was simulated; trade-offs kept apart; applying a move relocates the AC
ok 57 - optimizer: every listed improvement was simulated; trade-offs kept apart; applying a move relocates the AC
  ---
  duration_ms: 230.2052
  ...
# Subtest: visualization: tiles per room, windows lose more heat per m2 than walls in winter, jets follow moved devices
ok 58 - visualization: tiles per room, windows lose more heat per m2 than walls in winter, jets follow moved devices
  ---
  duration_ms: 8.068
  ...
# Subtest: renderer: heat-loss layer recolors envelope boxes; airflow uses simulated jets
ok 59 - renderer: heat-loss layer recolors envelope boxes; airflow uses simulated jets
  ---
  duration_ms: 5.0054
  ...
# Subtest: actual analysis panel: runs on start, edits design, finds and applies improvements, compares with baseline
ok 60 - actual analysis panel: runs on start, edits design, finds and applies improvements, compares with baseline
  ---
  duration_ms: 283.3765
  ...
1..60
# tests 60
# suites 0
# pass 60
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2342.6769: **60 tests passed; 0 failures.** New: simulation geometry (zones tile 108 m² per floor; window area equals the 3D glass), energy balance closing within 2% on winter and summer days, physically expected direction for glazing, air sealing, heat recovery, insulation and setpoints, no heating where no AC, AC moved outside serves nothing; sun altitude at 45°N (summer noon ~66°, winter ~24°) and facade sunlight by season; optimizer lists only simulated changes, keeps trade-offs apart, packages distinct categories, and relocates an AC; visualization tiles, heat-flow colours (windows above walls in winter) and jets that follow moved devices; renderer heat-loss recolouring and simulated airflow particles; the Analysis panel (design edit and persistence, season switch, improvements, apply, baseline comparison, heat-loss layer). Movement: step detection (walking signal ~10 steps in 6 s; single bumps, sitting noise and slow sway give none), open-hand geometry, grab offsets, walking along the gaze, grabbing the AC group, floor limit, saved offsets, fist→open toggle timing, Walk toggle and accelerometer batches.
- **Headless Chrome:** Thermal, Heat loss and Airflow layers and the Analysis panel rendered at desktop and phone sizes with no page errors; Find improvements ran in the page.
- **APK 0.5.0** (version code 7): 32 packaged assets verified; accelerometer forwarding added to the native bridge. Not tried on the phone: step detection thresholds on the S24+, grabbing through the headset camera, and comfort of hand-forward movement.
- **Simulation limits:** simplified heat balance with typical U-values and clear-sky design days; one temperature per room; not EnergyPlus, CFD or AI, and not validated against measurements.

## 0.4.0 additions

- `node tests/core.test.mjs`: **45 tests passed; 0 failures.** New tests: binary/ASCII STL and OBJ parsing (quads, negative indices, Z-up, 8 m fit, damaged files); Supabase REST calls, object naming, list filtering and error messages; cloud list rendering as text and loading a shared STL; upload of non-3D files; ray/box picking; palm-normalized pinch ratio, hysteresis and lost hands; tracker GPU→CPU fallback, one selection per pinch, camera release, denial and insecure origin; model rendering, selection highlight and reticle; weather presets, persistence and dialog controls; Open from computer; menu Help.
- **Headless Chrome (this PC, SwiftShader):** the app loaded; MediaPipe Hand Landmarker created from the vendored files with the GPU delegate in about 2.2 s and ran a detection; an STL chosen through the real upload input rendered in the viewer (1 triangle, fitted to 8 m). Screenshots at 1440 × 900 and 412 × 915 with simulated 32 px status and 48 px navigation bars showed every control clear of both bars.
- **Supabase (live):** listing with the publishable key returns an empty list; upload returns "Bucket not found" until `supabase/setup.sql` is run. A successful real upload and phone download have not been verified.
- **APK 0.4.0** (version code 6) built with R8/D8 8.7.18, v2/v3 signatures verified, 20 packaged assets match source, INTERNET and CAMERA permissions present. Not installed on a phone in this session: camera permission prompts, real hand tracking through the Gear VR, and the inset values on the S24+ are unverified.

## Passed

`node tests/core.test.mjs`: **35 tests passed; 0 failures** (version 0.3.1).

- Structured building: valid dimensions and colors, two floors, room records, furniture, HVAC, explicit non-AI provenance.
- Every view/floor/VR visibility combination; roof and preview layers follow floor selection.
- Validated state transitions, supported files, empty/oversize/unsupported files and unsafe-looking filenames.
- Camera projection, orthonormal camera basis, sensor quaternions, separate eye matrices, square eye render targets, lens-region viewports, mono restoration.
- S24+ lens spacing at 55/62/72 mm, vertical alignment, no eye-region overlap, portrait/landscape bounds, circular masking and symmetric radial texture mapping. Parallel cameras align distant directions; 0% depth produces identical eye views. Framebuffer failures surface an actionable error.
- Actual Lens fit controls update viewer settings, persist and restore the fit, reset defaults, toggle alignment targets, and close correctly on Android Back without exiting VR. These are adapter tests, not real GPU/pixel checks.
- Automatic fit derives a 153.54 × 70.86 mm S24+ display, preserves 62 mm lens spacing at 3120/2340/1560/1040 pixel widths, and places the centers at 29.81%/70.19%. Calculated view diameter is 60 mm, rounded to framebuffer pixels.
- Auto is the default. Mode switching preserves separate Manual adjustments through restarts, older saved manual fits migrate without replacing Auto, and malformed/unavailable storage does not prevent using either mode. Hidden Auto sliders cannot change the active calculated fit.
- Renderer/controller integration: drag, zoom bounds, sensor input, recenter, room switching and graphics-loss reporting using a recording WebGL adapter.
- VR jitter regressions: native/browser motion isolation, rejection of invalid and zero-length quaternions, equivalent quaternion signs, recenter during smoothing, VR reentry and orientation reset, and consistent filtering at 30/60/120 fps. Four of the new tests failed against the previous implementation and pass with the fix.
- Synthetic motion check: alternating +/-0.2 degree noise at 60 fps stays below 0.1 degree after settling; a 45 degree turn starts on the next frame and settles within 1 degree in 100 ms. These are simulated sensor/render checks, not phone latency measurements.
- Actual `app.js` event handlers using elements parsed from `index.html`: startup, enabled scene controls, Help, Explore drawer, view/layer/floor selection, uploads, repeated VR entry/exit, denied fullscreen/motion, native bridge and Android Back, startup failure and recovery. These use simulated DOM and device APIs.
- All local module imports and cached assets exist. No CDN/third-party runtime requests. Unique HTML IDs and matching app selectors.
- Live local HTTP responses, MIME types, cache headers, HEAD support and rejection of private paths and unsupported methods.

The Android build completed with the installed SDK tools and JDK. Verification confirmed:

- DEX bytecode, Android manifest and resources are present.
- `com.aeroform.app.MainActivity` is launchable. Minimum API 26; target API 35.
- APK version 0.3.1, version code 5; landscape direction stays fixed within each native VR session.
- APK signature verifies with Android v2 and v3 schemes.
- All **11 packaged web assets** match source SHA-256 hashes byte-for-byte.
- Debug key, tests and server logs are not included in the APK.
- Asset ZIP paths use forward slashes; a Windows packaging defect found by the initial verification was fixed before the final build.

## Not verified

- The real Playwright browser suite was attempted again for 0.3.1, but Chromium launch was denied by the current execution environment: `browserType.launch: spawn EPERM`. No browser screenshots, shader-driver validation or real GPU rendering results were obtained. Browser checks for Auto/Manual switching, saved settings, black corners, both alignment targets, WebGL errors and lens-control screenshots are present but could not run. The passing adapter tests above do not replace those checks.
- `adb devices -l` reported no attached devices. The configured emulator has no installed system image. The APK has **not** been installed or launched on a phone/emulator in this session.
- Real Galaxy S24+ head tracking, fullscreen transitions, frame rate, thermal load, and physical lens alignment/headset comfort remain unverified. Automatic geometry uses documented screen dimensions and the R324's 62 mm lens spacing as the black Gear VR family profile. Lens correction, field of view and virtual eye separation remain starting presets, not measured optical calibration. The user's through-lens result still needs checking on the phone.

## Reproduce

```powershell
npm test
npm run android:apk
.\scripts\verify-apk.ps1
```

With Playwright and a browser available in a session allowed to launch them, run `npm run test:browser`. It exercises desktop, mobile portrait and landscape, all enabled controls, loading failure, file selection, permission-denied VR, repeated VR exit/reentry, offline reload, and cache migration. Screenshots/results are written under `test-results/`.

For an Android device connected with USB debugging authorized, the built APK can be installed with `adb install -r releases\AEROFORM-debug.apk` and launched with `adb shell am start -n com.aeroform.app/.MainActivity`. Physical sensor and display behavior must still be checked on the phone.
