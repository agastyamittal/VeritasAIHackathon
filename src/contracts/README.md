# AEROFORM integration boundaries

`createBuilding()` supplies `{schemaVersion: 2, id, units, boxes, rooms, thermal, source}`. Geometry units are metres. `thermal` describes zones, openings, interior connections and the stair, matching the boxes. Movable HVAC boxes carry `group`, `movable` and `home`. `source.interpretedByAI` is false: the demo house is procedural.

No component may label an output as AI-predicted, simulated or measured without a named model/simulator version, input provenance, units and validation appropriate to the claim. `src/ai/registry.js` lists every intelligent component and its real status (AI, physics or rules). Results in the app are labelled "simplified physics estimate (not EnergyPlus or AI)"; the EnergyPlus-trained surrogate's line is labelled as an AI surrogate of EnergyPlus, with its measured test error.

| Boundary | Status | Implementation |
| --- | --- | --- |
| **SimulationAdapter** | Implemented (simplified physics) | `src/simulation/index.js` → `analyze({building, design, moves, conditions})` |
| **OptimizationAdapter** | Implemented (search over simulations) | `findImprovements()` / `applyImprovement()` in `src/simulation/optimizer.js` |
| **Viewer adapter** | Implemented for axis-aligned boxes and STL/OBJ meshes | `src/viewer.js`, `src/mesh.js` |
| **Phone display adapter** | Implemented | `src/vr-optics.js`, Android sensor bridge |
| **Hand input** | Implemented (MediaPipe landmarks, open source; gesture classifier trained here; clap via microphone) | `src/hand-tracking.js`, `src/mediapipe-detector.js`, `src/gesture-classifier.js`, `src/locomotion.js`, `src/clap-detector.js` |
| **DesignInterpreter** | Not implemented | Planned: CubiCasa5K floor-plan model |
| **Energy surrogate** | Implemented (trained on EnergyPlus runs) | `src/energy-surrogate.js`, `models/energy-surrogate-energyplus.json`, `training/train_surrogate.py` |
| **EnergyPlus adapter** | Implemented (laptop only; needs the EnergyPlus executable) | `src/simulation/energyplus.js` (IDF export, CSV reader), `training/energyplus/run-energyplus.mjs` (runner) |

## SimulationAdapter (implemented)

Input: the building, design options (`src/simulation/constructions.js`: windows, walls, roof, ground floor, air tightness, heat recovery, AC size, setpoints, grid factor, latitude), HVAC moves (`{group: [dx, dy, dz]}`), and weather conditions (`src/conditions.js`).

Output (`result`): per-zone hourly and min/mean/max temperatures, heating/cooling kWh, comfort (degree-hours outside the setpoints), fresh-air changes per hour, per-surface heat flow; building totals (heating, cooling, electricity, CO2e, peak loads); a heat-flow breakdown by path; device-to-zone assignment; and `provenance` (model name and version, method, timestep, every input value used, assumptions, units, timestamp).

Method: lumped-capacitance zones with explicit 3-minute steps over repeated clear-sky design days (ISO 13790/52016 style). It covers conduction, sun on windows and opaque surfaces, wind- and temperature-driven air leakage, vent fresh air with optional heat recovery, internal gains, inter-zone exchange through doorways and the stair, and AC units as capacity-limited ideal thermostats. Tests check that the energy balance closes within 2% and that each design change moves results in the physically expected direction.

What it is not: EnergyPlus, CFD, or AI. Rooms are well mixed (one temperature each). Airflow is a ventilation-rate estimate plus device jets for visualization, not a velocity field. U-values and SHGC are typical values per construction type.

## OptimizationAdapter (implemented)

Each candidate change (each better construction option, AC size, AC placement into an unserved room, setpoint relaxation) is simulated on the winter, mild and summer design days and compared with the current design. Results are kept in separate lists: energy savings without comfort loss, comfort improvements, and trade-offs (changes that save energy by leaving rooms colder or hotter). The best non-conflicting changes are simulated together as a package. Nothing is reported without simulating it.

## DesignInterpreter (planned)

Selected design bytes and file metadata → validated building model (same schema as `createBuilding()`, including `thermal`), with parser/model name and version, confidence per recognized element, source coordinates and warnings. Like every model in AEROFORM, it will be trained here rather than downloaded pretrained: CubiCasa5K annotations are the first candidate training data for plan images; buildingSMART IFC samples for BIM import. File upload currently stores files and opens STL/OBJ meshes only; it does not interpret plans.

## EnergyPlus adapter (implemented)

`buildIdf({building, design, moves, conditions})` writes an EnergyPlus 26.2 input file; `parseEnergyPlusCsv()` reads `eplusout.csv` back as `{zones, totals}` in the simplified model's shape (hourly/min/max/mean °C per zone, heating, cooling, electricity, CO2e, peaks, unmet degree-hours). `runEnergyPlus()` in `training/energyplus/run-energyplus.mjs` runs `energyplus --expandobjects --readvars` in a temporary folder and fails loudly on Severe/Fatal errors. EnergyPlus cannot run in the browser or APK, so the app never calls it directly.

Shared with the simplified model: geometry (zones, every window and door clipped to its zone's wall), each option's U-value (insulation layers sized against standard surface films) and SHGC, ground temperature, internal-gain schedule, vent fresh air per zone (`ventFlows()`), heat recovery, AC capacity in the zone each unit sits in, setpoints, doorway/stair exchange (two `ZoneCrossMixing` objects per opening), latitude, date, temperature, wind and ASHRAE clear sky. EnergyPlus's own: layered transient conduction with concrete slabs, surface heat balance and long-wave exchange, convection, solar geometry and window optics, infiltration (`ZoneInfiltration:DesignFlowRate` with EnergyPlus's BLAST coefficients), and ideal-loads HVAC. Sensible loads only. The design day uses EnergyPlus's default temperature profile (peak 15:00) rather than our cosine.

## Energy surrogate (implemented)

A neural network (32 inputs → 3×256 SiLU → 161 outputs) trained on paired inputs and EnergyPlus outputs from `node training/generate-sim-dataset.mjs --engine energyplus`. Inputs and outputs are defined once in `src/simulation/surrogate-features.js`. It is valid for the demo house only (`predict()` returns null for another building), reports `outsideTrainingRange` for out-of-range inputs, and carries its held-out test error, which the Analysis panel shows next to the estimate. It does not replace the simplified simulation, which still drives the layers, findings and optimizer. A second surrogate of the simplified model (`--engine simple`) is trained the same way for comparison; the app does not load it.
