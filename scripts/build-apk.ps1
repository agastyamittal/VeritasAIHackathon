param([string]$SdkPath = "$env:LOCALAPPDATA\Android\Sdk", [string]$JdkPath = 'C:\Program Files\Android\Android Studio\jbr')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$buildTools = Get-ChildItem -LiteralPath (Join-Path $SdkPath 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$platform = Get-ChildItem -LiteralPath (Join-Path $SdkPath 'platforms') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools -or -not $platform) { throw 'Android SDK build tools and platform are required.' }
$androidJar = Join-Path $platform.FullName 'android.jar'
$toolsDir = $buildTools.FullName
$java = Join-Path $JdkPath 'bin\java.exe'
$javac = Join-Path $JdkPath 'bin\javac.exe'
$jar = Join-Path $JdkPath 'bin\jar.exe'
$keytool = Join-Path $JdkPath 'bin\keytool.exe'
function Check-Exit([string]$stage) { if ($LASTEXITCODE -ne 0) { throw "$stage failed ($LASTEXITCODE)" } }
# Each build is isolated. Existing artifacts and signing key are never recursively removed.
$work = Join-Path $root ('.apk-build\run-' + [Guid]::NewGuid().ToString('N'))
$assets = Join-Path $work 'assets\www'
$classes = Join-Path $work 'classes'
$dex = Join-Path $work 'dex'
$out = Join-Path $root 'releases'
New-Item -ItemType Directory -Force -Path $assets,$classes,$dex,$out,(Join-Path $assets 'src'),(Join-Path $assets 'public') | Out-Null
foreach ($name in @('index.html','app.js','styles.css','manifest.webmanifest','sw.js')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination $assets }
foreach ($name in @('viewer.js','viewer-state.js','vr-optics.js','math.js','building.js','mesh.js','cloud.js','cloud-config.js','hand-tracking.js','mediapipe-detector.js','mediapipe-worker.js','conditions.js','gesture-classifier.js')) { Copy-Item -LiteralPath (Join-Path $root "src\$name") -Destination (Join-Path $assets 'src') }
Copy-Item -LiteralPath (Join-Path $root 'public\aeroform-icon.svg') -Destination (Join-Path $assets 'public')
# Simulation and AI registry modules live in subfolders of src.
foreach ($name in @('locomotion.js','clap-detector.js','analysis-panel.js','analysis-charts.js','ai\registry.js','simulation\index.js','simulation\constructions.js','simulation\model.js','simulation\thermal.js','simulation\weather.js','simulation\optimizer.js','simulation\visualize.js','simulation\surrogate-features.js','energy-surrogate.js')) {
  $target = Join-Path $assets "src\$name"; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root "src\$name") -Destination $target
}
# Trained gesture classifier (training/train_gesture.py).
New-Item -ItemType Directory -Force -Path (Join-Path $assets 'models') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'models\gesture-classifier.json') -Destination (Join-Path $assets 'models')
# Hand landmarks: Google's MediaPipe Hand Landmarker, vendored (vendor/mediapipe/README.md); nothing is downloaded at runtime.
Copy-Item -LiteralPath (Join-Path $root 'vendor') -Destination (Join-Path $assets 'vendor') -Recurse
# Demo 3D models (scripts/demo-models.mjs), opened from the menu.
Copy-Item -LiteralPath (Join-Path $root 'samples') -Destination (Join-Path $assets 'samples') -Recurse
# Energy surrogate trained on EnergyPlus runs (training/train_surrogate.py energyplus).
Copy-Item -LiteralPath (Join-Path $root 'models\energy-surrogate-energyplus.json') -Destination (Join-Path $assets 'models')
$resources = Join-Path $work 'resources.zip'
& (Join-Path $toolsDir 'aapt2.exe') compile --dir (Join-Path $root 'android\res') -o $resources
Check-Exit 'Resource compilation'
$unsigned = Join-Path $work 'unsigned.apk'
& (Join-Path $toolsDir 'aapt2.exe') link -o $unsigned -I $androidJar --manifest (Join-Path $root 'android\AndroidManifest.xml') $resources
Check-Exit 'APK resources'
# jar normalizes Windows separators to ZIP forward slashes; aapt2 -A does not on this SDK.
& $jar uf $unsigned -C $work assets
Check-Exit 'Web asset packaging'
& $javac -source 8 -target 8 -Xlint:-options -classpath $androidJar -d $classes (Join-Path $root 'android\src\com\aeroform\app\MainActivity.java')
Check-Exit 'Java compilation'
$classJar = Join-Path $work 'classes.jar'
& $jar cf $classJar -C $classes .
Check-Exit 'Class archive'
# Build-tools 34.0.0 D8 crashes (NullPointerException) on this activity's inner classes. A newer R8/D8 jar at
# .apk-build\tools\r8.jar (Google Maven com.android.tools:r8, 8.7.18 tested) is used when present.
$d8Jar = Join-Path $root '.apk-build\tools\r8.jar'
if (-not (Test-Path -LiteralPath $d8Jar)) { $d8Jar = Join-Path $toolsDir 'lib\d8.jar' }
& $java -cp $d8Jar com.android.tools.r8.D8 --lib $androidJar --min-api 26 --output $dex $classJar
Check-Exit 'DEX compilation'
& $jar uf $unsigned -C $dex classes.dex
Check-Exit 'DEX packaging'
$aligned = Join-Path $work 'aligned.apk'
& (Join-Path $toolsDir 'zipalign.exe') -f -p 4 $unsigned $aligned
Check-Exit 'APK alignment'
$key = Join-Path $root '.apk-build\debug.keystore'
if (-not (Test-Path -LiteralPath $key)) {
  & $keytool -genkeypair -keystore $key -storepass android -keypass android -alias androiddebugkey -dname 'CN=AEROFORM Debug,O=AEROFORM,C=US' -keyalg RSA -keysize 2048 -validity 10000
  Check-Exit 'Debug key generation'
}
$apk = Join-Path $out 'AEROFORM-debug.apk'
& $java -jar (Join-Path $toolsDir 'lib\apksigner.jar') sign --ks $key --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out $apk $aligned
Check-Exit 'APK signing'
& $java -jar (Join-Path $toolsDir 'lib\apksigner.jar') verify --verbose $apk
Check-Exit 'Signature verification'
& (Join-Path $toolsDir 'aapt.exe') dump badging $apk
Check-Exit 'Manifest verification'
& (Join-Path $PSScriptRoot 'verify-apk.ps1')
Get-Item -LiteralPath $apk | Select-Object FullName,Length
Get-FileHash -LiteralPath $apk -Algorithm SHA256
