# Character animation system

Phase 1 of the animation spec (16 Nov 2026). The two workflows end in the same format:

- **A (phase 3):** language → Motion Translator → motion/1 JSON → BVH / FBX
- **B (done):** video → MediaPipe Pose Landmarker Lite → tracking → motion/1 JSON → BVH / FBX

## Where things run

| Step | Where | Cost |
|---|---|---|
| Video decoding, finding people (MediaPipe Lite, 6 MB, vendored) | the phone's browser | free; the video never leaves the phone |
| Tracking, smoothing, fitting to the skeleton, root motion, description | the phone's browser (`public/motion.js`) | free |
| Library, BVH | the app's server on the phone (`src/motions.js`) | free |
| FBX | Blender without a screen (`tools/blender/motion_to_fbx.py`): Ubuntu's own `blender` package on the phone | free; about 400 MB disk |
| Video-model conditioning (depth, masks, views) | already in the app (`/api/body/depth`, `/api/body/views`) | free |

No GPU is used. A clip analysed once is never analysed again: it is recognised by a fingerprint
(size, name, first and last 4 MB) and opened from the library.

## Canonical skeleton: `assistant-human/1`

The body editor's 19-part rig (MakeHuman CC0 mesh and weights, `public/pose.js`), with human joint
limits. The joint names map to Mixamo names for export (`--mixamo` / `?names=mixamo`):

hips (Hips) → waist (Spine) → chest (Spine2) → neck (Neck) → head (Head);
chest → clavicle.L/R (Left/RightShoulder) → upperArm (Arm) → forearm (ForeArm) → hand (Hand);
hips → thigh.L/R (Left/RightUpLeg) → shin (Leg) → foot (Foot).

## Format: `motion/1`

```json
{
  "format": "motion/1", "skeleton": "assistant-human/1", "name": "clip · person 1",
  "fps": 10, "frameCount": 40, "duration": 4, "interpolation": "linear",
  "source": { "kind": "video", "file": "clip.mp4", "key": "<fingerprint>-10", "people": 2, "width": 1080, "height": 1920, "detector": "MediaPipe Pose Landmarker Lite" },
  "person": 1,
  "frames": [{ "t": 0, "root": [0, 0, 0], "pose": { "hips": { "turn": -3 }, "shin.L": { "bend": 12 } }, "conf": { "shin.L": 0.97 } }],
  "quality": { "legs": { "seen": 0.95, "average": 0.9 }, "uncertain": [] },
  "description": ["Torso inclination -8° to 8° (forward +).", "..."]
}
```

- `pose`: the rig's own axes in degrees (pose.js `POSE_PARTS`), so a motion fits any body shape
  made in the editor. Joint limits are applied when it is made.
- `root`: centimetres, estimated from one camera (assumes the camera does not move).
- `conf`: per part, 0–1 (the least sure of the points it depends on). A part not seen keeps its last
  angles instead of being guessed.
- Quaternions per joint for other tools: `rotations(rest, upc, pose)` in motion.js; BVH and FBX
  carry the same rotations.

## How a video becomes motion (all automatic)

1. Frames sampled at 10 fps (5 or 15 in Options), shrunk to 640 px, MediaPipe in VIDEO mode, up to 2 people (or 3).
2. People kept apart frame to frame by where their hips are and how big they are.
3. Short gaps (up to 1 s) filled; jitter smoothed with a small Gaussian (the whole clip is known, so no lag).
4. Points projected back through a phone camera's usual lens: on-screen positions for up/down and across, MediaPipe's 3D only for depth.
5. Fitted to the figure: the hips from the pelvis and torso (a bend is shared between hips and
   spine, as people bend), then torso, neck and head, then arms and legs, each segment's direction
   from the video at the figure's own lengths, by pose.js's solver within joint limits.
6. Root motion: across from the hips on screen, towards or away from the size of the torso, and
   the lowest seen foot kept on the floor.

## Two or more people

MediaPipe Lite on the whole frame merges or loses people who stand close (tested: two figures
walking towards each other were merged at about a body's width apart, and lost entirely during a
high five). So once two people are in view, each is followed in a close-up of their own (a strip as
tall as their body and as wide as their trunk and legs), with one landmarker per person in VIDEO
mode; the whole frame is still searched twice a second for newcomers. Everyone in a clip shares one
origin (straight ahead of the camera, at the nearest person's starting distance), so exported files
keep their places relative to each other.

## Checked

- Poses rebuilt from their own points: 12 standard poses within 6 cm (lying down, kneeling and crouching included).
- BVH → Blender → FBX → imported again: every joint within 0.01 cm.
- Two figures walking towards each other and high-fiving (`tools/test-clips.mjs`, `test/ui/animation-two.mjs`):
  followed in 49 and 50 of 50 frames, no swaps, each walks about 55 cm the right way, facing ±39–45°
  (true ±35°), the correct arm raised on each (104° and 108°), gap 156 cm → 49 cm (true about 145 → 40).
  About 40 s for 5 s of clip.
- The grey mannequin clip (the app's own render): found and fitted in about 26 s for 4 s of video.
  Known limits seen there: arms straight overhead read about 120–130° instead of about 168°, and knees
  that are straight read as 15–25° bent when filmed from the front (depth is hard to judge from one camera).

## Next phases

- 2: procedural animation (key poses, interpolation, blending) on the same format.
- 3: the Motion Translator (language → motion/1).
- 5: validation (foot sliding, joint limits report, capsule collisions) and manual correction.
- 6: Wan adapters (DWPose-style skeleton video for Wan Animate; depth and mask sequences for VACE).
