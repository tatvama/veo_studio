# MediaPipe models

These model files are Google MediaPipe models, licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). They are unchanged copies of the files Google publishes on its
model storage. The engine uses them for the `bg_blur` / `bg_replace` effects and `trackFaces()`
(frontend/src/engine/ml/mediapipe.ts), through `@mediapipe/tasks-vision` 1.1.0 (Apache-2.0, npm), whose WASM runtime
is bundled from the package at build time.

| File | Source | Size (bytes) | SHA-256 |
| --- | --- | --- | --- |
| `selfie_segmenter.tflite` | https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite | 249537 | `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b` |
| `blaze_face_short_range.tflite` | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite | 229746 | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |

Downloaded on 12 October 2026. The MD5 of each download matched the `x-goog-hash` Google's storage reports for it
(`Oy4+HPx9MVOMrwD/Tg+6jA==` and `o91uwxclKQdwuXzsDL+UyQ==`).

Model cards: https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter (SelfieSegmenter, square input) and
https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector (BlazeFace short range).
