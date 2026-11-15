// VR movement without positional tracking. The phone in a Gear VR knows its rotation but not its position,
// so walking is detected from accelerometer steps (each step moves you forward where you look), and an
// open hand held out in front of the camera glides you forward.

export const STEP_LENGTH_METRES = 0.7;
export const HAND_WALK_SPEED = 1.1; // m/s while an open hand is held out

// Walking makes the acceleration magnitude bounce about 1.5-4 m/s^2 above gravity at 1.4-2.5 steps per
// second. Input: |acceleration| - 9.81 (m/s^2) with a timestamp in ms. A peak above `threshold` counts as a
// step, at most one per `minInterval`. A step counts only if another follows within `maxInterval`, so a
// single nod or bump never moves you; once walking, every step counts immediately.
export function createStepDetector({ threshold = 1.4, release = 0.4, minInterval = 280, maxInterval = 1400, smoothing = 0.35 } = {}) {
  let filtered = 0, above = false, peak = 0, lastPeak = -Infinity, walking = false, steps = 0, pending = false;
  return {
    get steps() { return steps; },
    get walking() { return walking; },
    get value() { return filtered; },
    reset() { filtered = 0; above = false; peak = 0; lastPeak = -Infinity; walking = false; steps = 0; pending = false; },
    // Returns the number of steps to apply for this sample (0, 1, or 2 when a pending first step is confirmed).
    update(value, time) {
      if (!Number.isFinite(value) || !Number.isFinite(time)) return 0;
      filtered += smoothing * (value - filtered);
      if (walking && time - lastPeak > maxInterval) { walking = false; pending = false; }
      if (!above) {
        if (filtered > threshold) { above = true; peak = filtered; }
        return 0;
      }
      peak = Math.max(peak, filtered);
      if (filtered > release) return 0;
      above = false;
      const gap = time - lastPeak;
      if (gap < minInterval) return 0;
      lastPeak = time;
      if (walking) { steps++; return 1; }
      if (pending && gap <= maxInterval) { walking = true; pending = false; steps += 2; return 2; }
      pending = true;
      return 0;
    }
  };
}

const distance = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

// Open hand: index, middle, ring and little fingertips all clearly further from the wrist than their
// middle joints. Works whether the camera sees the palm or the back of the hand.
export function isOpenHand(hand, aspect = 1) {
  if (!Array.isArray(hand) || hand.length !== 21) return false;
  let extended = 0;
  for (const [pip, tip] of [[6, 8], [10, 12], [14, 16], [18, 20]]) {
    if (distance(hand[tip], hand[0], aspect) > distance(hand[pip], hand[0], aspect) * 1.15) extended++;
  }
  return extended === 4;
}

// Walking hand: the trained gesture model says open palm (at least 70%) AND all four fingers are out by
// geometry. Either one alone let relaxed or half-open hands walk you: on held-out HaGRID hands the old
// either-or rule read 30% of "other" hands and 8% of OK signs as open; this rule reads none of them, and 99.5%
// of open palms. prediction: {label, confidence} from the gesture classifier, or null (then no walking).
export function isWalkingHand(hand, prediction, aspect = 1) {
  return Boolean(prediction && prediction.label === 'open_palm' && prediction.confidence >= 0.7 && isOpenHand(hand, aspect));
}

// Hand size in the image (wrist to middle knuckle), used to tell when the hand moves toward or away.
export const palmSize = (hand, aspect = 1) => Array.isArray(hand) && hand.length === 21 ? distance(hand[0], hand[9], aspect) : null;

// Grab mapping: how far the held object moves for a hand movement, in the view's right/up/forward axes.
// Sideways and vertical hand motion turns into the same angle at the object's distance (camera field of
// view ~60 deg), and a smaller palm (hand pushed away) moves the object proportionally further away.
// `mirrored` is true for the front camera, whose image is flipped relative to the user.
export function grabOffset(startHand, hand, { aspect = 1, distance: objectDistance = 3, mirrored = false, fov = 60 } = {}) {
  if (!startHand || !hand) return { right: 0, up: 0, forward: 0 };
  const span = 2 * Math.tan((fov * Math.PI / 180) / 2) * objectDistance;
  const dx = (hand[9].x - startHand[9].x) * (mirrored ? -1 : 1);
  const dy = hand[9].y - startHand[9].y;
  const before = palmSize(startHand, aspect), now = palmSize(hand, aspect);
  const scale = before && now ? Math.min(3, Math.max(1 / 3, before / now)) : 1;
  // `span` is the horizontal field at the object; the vertical field is narrower by the image aspect.
  return { right: dx * span, up: -dy * span / aspect, forward: objectDistance * (scale - 1) };
}

// Open hand held out: walk forward. Walking starts once the hand has been open for `startMs`, and dropouts
// shorter than `graceMs` (one blurred or misread frame at 15-20 detections a second) neither stop it nor
// restart the wait; a closed hand stops it within about 150 ms. Version 1 restarted
// on every missed frame and also needed the hand perfectly still, so on a phone it often never started.
export function createOpenHandWalk({ startMs = 400, graceMs = 150 } = {}) {
  let since = null, seen = -Infinity, walking = false;
  return {
    get walking() { return walking; },
    reset() { since = null; seen = -Infinity; walking = false; },
    // open: this frame shows an open hand (and walking is allowed). Returns whether to walk this frame.
    update(open, time) {
      if (open) { if (since === null || time - seen > graceMs) since = time; seen = time; }
      else if (time - seen > graceMs) since = null;
      walking = since !== null && time - since >= startMs;
      return walking;
    }
  };
}
