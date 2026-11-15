// What each intelligent component in AEROFORM is, and whether it is actually running. The UI lists these
// so no output is mistaken for AI when it comes from physics or rules, and planned models are not shown
// as working. Update the status here when a component is connected.
export const AI_COMPONENTS = Object.freeze([
  { id: 'hand-landmarks', name: 'MediaPipe Hand Landmarker', kind: 'Pretrained open-source model (Google, Apache-2.0), not trained here', status: 'active',
    role: 'Finds the hand and its 21 points in the camera image for pinch, grab and gestures', source: 'vendor/mediapipe (tasks-vision 0.10.14, official float16 model; hashes in vendor/mediapipe/README.md)' },
  { id: 'handnet', name: 'AEROFORM HandNet', kind: 'Model trained for this project (from random initialisation)', status: 'experiment, not used',
    role: 'Our own hand landmark model: 0.34 palm-length error on FreiHAND/RHD test images, but unreliable on the real phone camera (missed hands, false detections), so MediaPipe replaced it', source: 'training/train_handnet.py, src/handnet.js (kept for the comparison; not shipped in the app)' },
  { id: 'gesture-classifier', name: 'AEROFORM gesture classifier', kind: 'Model trained for this project', status: 'active',
    role: 'Hand signs from the hand points: thumbs up / down (floor), one to four fingers (layer), open palm (walk), fist, OK', source: 'Trained on HaGRIDv2 hand landmarks; 99.1% on held-out people, every VR sign at 93.5% precision or more (training/README.md)' },
  { id: 'floorplan-interpreter', name: 'Floor-plan interpreter', kind: 'Planned model, to be trained here on floor-plan data (e.g. CubiCasa5K)', status: 'not connected',
    role: 'Rooms, walls, doors and windows from an uploaded plan image, as an editable building', source: 'Contract: DesignInterpreter in src/contracts/README.md' },
  { id: 'energy-surrogate', name: 'EnergyPlus-trained energy surrogate', kind: 'Model trained for this project (neural network)', status: 'active',
    role: 'EnergyPlus-level room temperatures, heating, cooling and electricity for the demo house in under a millisecond, shown next to the simplified physics result', source: 'Trained on EnergyPlus 26.2 runs of the demo house (training/train_surrogate.py energyplus); test error in models/energy-surrogate-energyplus.json' },
  { id: 'energyplus', name: 'EnergyPlus adapter', kind: 'Physics simulator (not AI), runs on a laptop', status: 'active',
    role: 'Exports the building, design and weather to EnergyPlus 26.2 and reads results back in the same shape; produces the surrogate training data', source: 'src/simulation/energyplus.js, training/energyplus/run-energyplus.mjs' },
  { id: 'heat-balance', name: 'Simplified heat balance', kind: 'Physics model (not AI)', status: 'active',
    role: 'Room temperatures, heat flows, ventilation, energy and CO2 per design day', source: 'src/simulation/thermal.js' },
  { id: 'design-search', name: 'Design search', kind: 'Optimization over simulations (not AI)', status: 'active',
    role: 'Tests each design change in the simulation and ranks savings and comfort', source: 'src/simulation/optimizer.js' }
]);
