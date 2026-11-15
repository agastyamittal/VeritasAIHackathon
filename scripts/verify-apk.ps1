$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$apk = Join-Path $root 'releases\AEROFORM-debug.apk'
$zip = [System.IO.Compression.ZipFile]::OpenRead($apk)
$checks = 0
try {
  foreach ($relative in @('index.html','app.js','styles.css','sw.js','manifest.webmanifest','public/aeroform-icon.svg','src/viewer.js','src/viewer-state.js','src/vr-optics.js','src/math.js','src/building.js','src/mesh.js','src/cloud.js','src/cloud-config.js','src/hand-tracking.js','src/mediapipe-detector.js','src/mediapipe-worker.js','vendor/mediapipe/vision_bundle.mjs','vendor/mediapipe/wasm/vision_wasm_internal.js','vendor/mediapipe/wasm/vision_wasm_internal.wasm','vendor/mediapipe/hand_landmarker.task','src/conditions.js','src/locomotion.js','src/clap-detector.js','src/analysis-panel.js','src/analysis-charts.js','src/ai/registry.js','src/simulation/index.js','src/simulation/constructions.js','src/simulation/model.js','src/simulation/thermal.js','src/simulation/weather.js','src/simulation/optimizer.js','src/simulation/visualize.js','src/gesture-classifier.js','models/gesture-classifier.json','samples/modern-cabin.obj','samples/twisting-tower.stl','samples/geodesic-dome.obj','samples/spiral-stair.stl','src/energy-surrogate.js','src/simulation/surrogate-features.js','models/energy-surrogate-energyplus.json')) {
    $entry = $zip.GetEntry("assets/www/$relative")
    if (-not $entry) { throw "Missing packaged asset: $relative" }
    $stream = $entry.Open()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $packedHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') }
    finally { $stream.Dispose(); $sha.Dispose() }
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $root $relative) -Algorithm SHA256).Hash
    if ($sourceHash -ne $packedHash) { throw "Stale packaged asset: $relative" }
    $checks++
  }
  foreach ($required in @('AndroidManifest.xml','classes.dex','resources.arsc')) { if (-not $zip.GetEntry($required)) { throw "Missing APK component: $required" } }
  if ($zip.Entries.FullName -match 'debug.keystore|tests/|server.*log') { throw 'Unexpected private/build assets inside APK' }
  "PASS: $checks packaged web assets match source byte-for-byte; manifest, DEX and resources are present."
} finally { $zip.Dispose() }
