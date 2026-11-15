# AEROFORM

A self-contained architectural viewer with a two-floor demo home, cutaway/exterior views, floor isolation, furniture and HVAC, illustrative environmental layers, phone stereoscopic viewing, camera hand tracking, and cloud sharing of STL/OBJ models between a laptop and a phone. No npm dependencies or CDNs are needed. Hand tracking uses Google's open-source MediaPipe Hand Landmarker, shipped in `vendor/mediapipe`; the gesture classifier and the EnergyPlus-trained energy model were trained here. Only the optional cloud sharing uses the network (Supabase Storage).

## Unreleased (after 0.5.0)

- **Hand tracking back on MediaPipe:** our own hand landmark model, AEROFORM HandNet (trained from scratch on FreiHAND and Rendered Hand Pose), reached 0.34 palm-length error on dataset test images but missed real hands and fired on other objects with the phone camera. The app uses MediaPipe Hand Landmarker 0.10.14 again (Apache-2.0, hashes in `vendor/mediapipe/README.md`), which is also the landmark format the gesture classifier was trained on. HandNet stays in `training/` and `src/handnet.js` as a documented experiment and is not shipped.
- **VR without buttons:** entering Phone VR starts hand tracking and a clap listener and shows a one-screen guide to the controls (close it with Start or a clap; "Don't show again" is remembered). Hand signs, held about half a second: **thumbs up / down** change floor; **1 finger** thermal, **2** airflow, **3** heat loss, **4** architecture; **open hand** held out walks forward; **pinch** grabs or selects; **fist then open** goes outside / back in. **Clap** recenters (microphone, analysed on the phone, never recorded). Leave with the headset's Back button (Escape on a computer). Lens fit and Walk are in ☰ → Phone VR. The gesture classifier now has 10 classes (thumbs down, three and four fingers added; 99.1% on held-out people).
- **Hand signs register more reliably:** the swipes and waves are gone. A held sign no longer restarts when one frame is blurred or misread, and open-hand walking no longer needs a perfectly still hand. In a simulation where 90% of frames read as open, the old walk moved you for 41% of a 4 s hold and the new one for 90%. Walking works only in VR; the dev view says so.
- **Heat particles (Heat loss layer):** red particles stream through every window and the door, out and upwards when heat is lost, inwards when it is hotter outside, with more particles and faster flow for more watts through that opening. The Thermal layer is coloured room floors only (blue colder, grey comfortable, red hotter). In VR all particles are drawn half as many and half the size, at most 12 px (`VR_PARTICLES` in `src/viewer.js`).
- **Renamed to AEROWAY:** the name shown in the app (in the accent blue, with no placeholder logo square), the browser tab, the web-app manifest and the Android app label. Internal names (the `com.aeroform.app` package, `aeroform-*` storage keys and cache names, file names) are unchanged so saved settings and the installed app carry over.
- **Plainer UI:** square corners everywhere, neutral black and dark-grey surfaces (#0c0c0c / #151515), a light "air" blue accent (#9fd8ff) for buttons and selections, the device's own sans-serif font, no "Live 3D · local assets" line, custom scroll bars (thin, square, dark grey, light blue while hovered or dragged), no project-name line, no status dots, no corner brackets on the 3D view and no all-caps labels (fold-out sections keep short sentence-case titles). The 3D background, the Analysis charts, the browser theme colour and the Android window background follow the same greys.
- **Demo house starts with poorly placed AC units:** each floor's AC unit is in the small bedroom (19 m²), leaving the hall and living rooms (89 m²) too hot or too cold. A finding flags it, and Analysis → Find improvements has a new **Move equipment** section with the simulated fix for each unit (floor 1: 268 fewer degree-hours outside the setpoints, floor 2: 190, over a winter, mild and summer day). Moving a unit costs about +20% electricity, because it then heats and cools the bigger rooms; the panel says so. The fresh-air vents stay in the hall: in this house every room gets enough fresh air wherever they are, so moving them would show no gain. Setpoint changes are no longer offered as comfort fixes.
- **EnergyPlus layer removed:** the menu no longer has an EnergyPlus layer button. The EnergyPlus-trained model's energy estimate is still shown in the Analysis panel.
- **Demo 3D models:** the menu has a Demo 3D models list: Modern cabin (OBJ), Twisting tower (STL), Geodesic dome (OBJ) and Spiral stair (STL). They are built from simple solids by `scripts/demo-models.mjs` (our own, no third-party assets), shipped in `samples/` (4-48 KB each), work offline and in the APK, and open in 3D and Phone VR like any upload. The files also work for testing Upload to phone and Open from computer. Fixed on the way: a model whose display name has no file extension could not be opened.
- **Clap sensitivity slider:** the hand dev view has a Sensitivity slider (0-100, default 45, saved on the phone, applied at once, also while in VR), a live meter of the loudest recent sound against the level a clap must pass, and a Test microphone button for use outside VR. The slider moves every detector threshold together between strict and eager (`clapThresholds` in `src/clap-detector.js`); speech, music and steady noise never count, even at 100. The microphone is read block by block, not polled.
- **No more walking without an open hand:** walking now needs the trained model to say open palm (70% or more) and all four fingers out by geometry. On held-out HaGRID hands the old either-or rule read 30% of everyday "other" hand shapes and 8% of OK signs as open; the new rule reads none of them and still 99.5% of open palms. Walking also stops within about 150 ms of closing the hand (was up to 700 ms).
- **Smoother rendering:** the MediaPipe hand model now runs in a background thread (`src/mediapipe-worker.js`; falls back to the main thread if a worker cannot start), so detection no longer stalls drawing. Particles are computed once per frame for both eyes into one reused buffer, and open-hand walking moves you every displayed frame instead of in steps at the hand-detection rate. Chrome at phone size with the CPU slowed 4x, VR with hand tracking on the Heat loss layer: 25-33 fps with most frames over 34 ms before, 89-118 fps with none over 34 ms after.
- **EnergyPlus adapter:** `src/simulation/energyplus.js` exports the house, design and weather to EnergyPlus 26.2 and reads the results back in the same shape as the simplified model. It runs on a laptop with EnergyPlus installed (`node training/energyplus/run-energyplus.mjs winter`), not in the app.
- **EnergyPlus-trained estimate in the Analysis panel:** a small neural network trained on 6,000 EnergyPlus runs of this house predicts EnergyPlus's room temperatures, heating, cooling and electricity in about 1 ms on the phone. The panel shows it under the headline numbers with its test error (about 0.2 °C and 1.4 kWh per day), and says when an input is outside its training range. The simplified physics still drives the layers, findings and Find improvements.

## Version 0.5.0

- **Environmental simulation (simplified physics, not EnergyPlus/CFD/AI):** `src/simulation/` models the house as 6 thermal zones (3 rooms × 2 floors) with conduction through walls, windows, doors, roof and ground; clear-sky sun by season and latitude; air leakage scaled by wind and temperature; vent fresh air with optional heat recovery; people and appliances; air exchange through doorways and the stair; and AC units as capacity-limited heat pumps. It runs over repeated design days in about 20 ms. Weather comes from **Weather conditions**.
- **Layers driven by the simulation:** **Thermal** tints each room by its simulated temperature (daily mean or any hour); **Heat loss** colours each wall, window, door and roof by its simulated heat flow; **Airflow** shows jets from each AC and vent where they currently are and marks rooms under 0.35 fresh-air changes per hour.
- **Analysis panel (simplified, visual):** electricity, CO₂e and comfort tiles; floor-plan maps with rooms coloured colder / comfortable / hotter and the HVAC and windows drawn in; temperature through the day per room (hover or tap to set the 3D view hour); biggest heat leaks or gains; what to fix; **Find improvements** with a before/after for the best combination and one-change bars with **Apply**. Design settings, baseline comparison, the room table and all assumptions are in collapsed sections.
- **Movement in VR:** hold an open hand out to glide forward; walk or step in place to move about 0.7 m per step (accelerometer step detection; **Walk on/off** in VR). Phones in a Gear VR track rotation only, so steps stand in for positional tracking.
- **Grab HVAC:** look at an AC unit or vent, pinch and hold to grab, move your hand or look around to carry it (push the hand away to move it further), release to drop. Moves are saved, feed the simulation, and can be reset (☰ → Layers & hand tracking → Reset moved items).
- **Gestures:** open hand waved **up** = up a floor, waved **down** = down a floor (VR: same spot on the other floor; normal view: floor filter); thumbs up recenters; point goes to the next room; fist clears the selection; **fist then open hand** switches interior/exterior (in VR: outside the house and back).
- **Surrogate training data:** `training/generate-sim-dataset.mjs` writes paired design inputs and simulation outputs (now used to train the energy surrogates above).

## Version 0.4.0

- **Layout:** a desktop column with logo, Interior/Exterior, Sim conditions, Open from computer and Upload to phone, then a dashed divider and a framed 3D view. On phones: logo, Phone VR and a ☰ menu on top; the model name and a Weather conditions pill at the bottom. Controls stay clear of the Android status and navigation bars: the APK passes the real bar sizes to the page as `--native-*` CSS variables, and browsers use `env(safe-area-inset-*)`.
- **Cloud models:** Upload to phone saves any file (up to 50 MB) to the Supabase bucket `aeroform-models`. On the phone, open ☰ → Cloud and tap a file. STL and OBJ files open in 3D and VR, fitted to 8 m; other files are stored only. Open from computer views an STL/OBJ locally without uploading.
- **Hand tracking:** ☰ → Layers & hand tracking → Hand tracking (or **Hands** in VR). MediaPipe Hand Landmarker runs on the camera; pinching thumb and index selects the part under the center mark and highlights it. The APK asks for camera permission; a browser needs HTTPS or localhost.
- **Gesture classifier (trained here):** a small network trained on 1.37M HaGRIDv2 hand landmarks recognises open palm, fist, point, thumbs up and OK on top of MediaPipe. Holding open palm recenters, point moves to the next room in VR, fist clears the selection. 99.2% on HaGRID's unseen-people test set, 83.9% on a separate Zenodo dataset. See [training/README.md](training/README.md).
- **Weather conditions:** season preset, outdoor temperature, wind speed and direction, saved on the device. These are stored inputs for a future EnergyPlus run; nothing simulates them yet.

### One-time Supabase setup

Cloud sharing needs a storage bucket and two policies. In the Supabase dashboard, open **SQL Editor → New query**, paste [`supabase/setup.sql`](supabase/setup.sql) and click **Run**. Until then, uploads report that the bucket does not exist. The publishable key in `src/cloud-config.js` is meant to ship in apps; anyone who has the app can list and upload files, and no one can delete or overwrite them through the app.

## Website

From this folder run `npm start` (or `node scripts/server.mjs`). Open `http://localhost:8787/?v=7`. A phone on the same Wi-Fi uses the laptop's LAN IP instead of `localhost`.

The local server serves only the app assets and APK download. It sends no-cache headers so edits don't silently reuse old scripts. On secure origins, the service worker caches the app for offline revisits and replaces older AEROFORM caches without deleting other applications' caches.

- Drag to orbit; pinch/scroll to zoom. Reset restores the overview.
- Cutaway/Exterior controls and layers are in the sidebar, or the **Explore** drawer on a phone.
- Floor buttons isolate each floor and its environmental preview.
- **Phone VR** enters a two-eye view immediately. Drag to look, **Recenter**, **Next room**, and **Exit VR** work without fullscreen or motion permission. Phone motion in a browser needs a supporting secure origin; LAN HTTP still supports touch-look stereo mode.
- A chosen design is local file selection only. It does not generate a building or run AI. The UI states this explicitly.
- Airflow particles and thermal colors are visual concepts, not physical simulation or predictions.

## Android APK

The debug build is `releases/AEROFORM-debug.apk`. Copy that file to the phone and open it to install. Or download it from the running website at `/releases/AEROFORM-debug.apk`.

This is an offline native Android WebView host with the same web assets bundled inside. It does not point to the laptop. The native bridge requests landscape and immersive display for VR, keeps the display awake while VR is active, and forwards rotation sensor orientation to the viewer. Version 0.2.1 uses only the native motion source inside the APK, smooths sensor noise once per rendered frame, and locks the selected landscape direction for the VR session. Recenter clears pending smoothing immediately. File selection uses Android's document picker. It is a custom split-eye viewer, not an official Gear VR runtime.

Version **0.3.1** includes circular eye apertures with a black surround, radial lens correction, and separate **Auto** and **Manual** lens-fit modes. Each eye renders into a square texture with parallel cameras. The head-tracking fixes remain in place.

For **Galaxy S24+ in a black Gear VR**, enter Phone VR and open **Lens fit**. **Auto** is the default: it calculates centered lens positions and view size from the S24+ screen geometry and the 62 mm headset lens spacing. It preserves the physical spacing as the render resolution changes. Center the phone in the headset and use **Show alignment target** to check the result.

**Manual** provides spacing, vertical position, view size, field of view, lens correction, and 3D depth controls. Manual adjustments are saved separately, so switching to Auto does not erase them. **Use calculated values** resets only the manual fit to the automatic starting values. Earlier manual settings are retained when upgrading; the first launch of this version starts in Auto. The selected mode and manual fit survive restarts when local storage is available. At 0% depth both eyes use the same viewpoint. **Show house** leaves the alignment target.

The calculation uses [Samsung's S24+ display specifications](https://www.samsung.com/ca/business/smartphones/galaxy-s/galaxy-s24-plus-onyx-black-256gb-sm-s926wzkaxac/) and the [Gear VR R324 specification's 62 mm lens spacing](https://images.samsung.com/is/content/samsung/p5/ch_fr/pdf/Pb_Sam_GearVR_SMR324_Productfiche_CH_FR.pdf), used as the starting profile for the user's black R323/R324/R325 family. From a 169.1 mm diagonal and 3120:1440 aspect ratio, the landscape screen is approximately **153.54 × 70.86 mm**. Lens centers are `(153.54 ± 62) / 2`: **45.77 and 107.77 mm** from the left edge, or **29.81% and 70.19%** of the width. At 3120 × 1440, that is approximately **(930, 720)** and **(2190, 720)**. Auto fits 60 mm circular views with a 1 mm inner margin on each eye and at least 3 mm vertical margins. These margins are layout choices, not measured lens-aperture values.

Auto calculates alignment and view size; it cannot derive lens distortion, mounting offsets, or your personal eye spacing from the phone dimensions. The 90° view, 22% correction and standard virtual camera separation remain starting presets. This is not a measured or certified Gear VR optical profile. Use Manual for an imperfect physical fit, following the principles in [Google's calibration guide](https://support.google.com/cardboard/manufacturers/answer/6324808?hl=en).

The build uses the installed Android SDK's AAPT2, D8, zipalign and apksigner plus Android Studio's JDK, without Gradle or Capacitor downloads. Build-tools 34.0.0's D8 crashes with a NullPointerException on this activity's inner classes on this machine, so the script uses `.apk-build/tools/r8.jar` when present (Google Maven `com.android.tools:r8` 8.7.18, tested). Installing newer build-tools is the alternative.

```powershell
npm run android:apk
```

To use different SDK/JDK locations:

```powershell
.\scripts\build-apk.ps1 -SdkPath 'C:\path\to\Sdk' -JdkPath 'C:\path\to\jdk'
```

The build script compiles Java and Android resources, embeds the web assets, signs the APK with a local debug key, verifies its signature/manifest, and compares every packaged asset with its source. Intermediate files and the debug signing key stay in `.apk-build/` and are excluded from both source control and the web server. This is a debug prototype, not a store release.

## Verification

Run `npm test`: 81 tests cover the trained models (gesture classifier, both energy surrogates and the HandNet experiment reproduce their PyTorch exports), the vendored MediaPipe files against their documented hashes, the clap detector, held hand signs and open-hand walking, the EnergyPlus export, the simulation (energy balance, sun angles, design changes, optimizer, visualization), movement, grabbing, gestures, cover STL/OBJ parsing, the Supabase client, cloud list/upload UI, ray picking, pinch detection, the hand-tracker lifecycle, weather conditions, the building, visibility, validation, camera math, stereo projection/viewports, lens geometry, calculated fit, mode persistence and migration, calibration controls, touch and motion input, conflicting sensor sources, noise filtering, recentering, actual UI handlers, permission failures, error recovery, asset imports and HTTP responses. DOM/device/WebGL adapters are used where a browser is required; these tests do not prove GPU rendering or physical headset behavior.

Run `npm run test:browser` with Playwright installed to exercise desktop, phone portrait/landscape, all enabled controls, offline reload, startup failures, and VR permission-denial/reentry, and capture screenshots. An existing Playwright installation can be supplied through `PLAYWRIGHT_MODULE`; an existing browser can be supplied through `CHROME_PATH`.

See [TEST-REPORT.md](TEST-REPORT.md) for actual results and remaining verification limits.

## Modules

- `app.js`: interface, loading/error states, permissions, file selection, VR lifecycle.
- `src/viewer.js`: local WebGL rendering, camera/gesture controls, device orientation and VR room locations.
- `src/vr-optics.js`: S24+ lens placement, manual fit settings, radial correction, and alignment target rendering.
- `src/math.js`: projections, camera bases and quaternion operations.
- `src/building.js`: structured demo geometry and room records, with metre units and provenance.
- `src/mesh.js`: STL (binary/ASCII) and OBJ parsing, Z-up conversion, fitting and flat normals.
- `src/cloud.js`, `src/cloud-config.js`: Supabase Storage list/upload/download over REST.
- `src/hand-tracking.js`, `src/mediapipe-detector.js`, `src/mediapipe-worker.js`, `vendor/mediapipe/`: camera lifecycle, pinch detection with hysteresis, and the MediaPipe Hand Landmarker (GPU, falling back to CPU).
- `src/clap-detector.js`: clap to recenter in VR (microphone; nothing recorded).
- `src/gesture-classifier.js`, `models/gesture-classifier.json`, `training/`: trained gesture model, its JS inference and the training script.
- `src/simulation/`: thermal zones, weather, heat-balance solver, optimizer and layer visualization; `src/analysis-panel.js` is its UI; `src/ai/registry.js` lists AI and non-AI components with their status.
- `src/locomotion.js`: step detection, open-hand detection and grab mapping.
- `src/conditions.js`: weather/sim condition inputs, presets and summaries.
- `src/handnet.js`, `src/handnet-worker.js`, `src/hand-detector.js`, `models/handnet.json`: AEROFORM HandNet experiment (our own hand landmark model and its plain-JS inference). Not used by the app; kept with its results for comparison.
- `src/simulation/energyplus.js`, `training/energyplus/`: EnergyPlus adapter (IDF export, runner, result reader).
- `src/energy-surrogate.js`, `src/simulation/surrogate-features.js`, `models/energy-surrogate-*.json`: energy surrogates and their shared inputs/outputs; trained by `training/train_surrogate.py`.
- `supabase/setup.sql`: bucket and storage policies for cloud sharing.
- `src/viewer-state.js`: validated state transitions, file validation and eye layouts.
- `android/`: native activity, sensor bridge, document picker and manifest.
- `src/contracts/README.md`: boundaries for future real AI and simulation integrations.
