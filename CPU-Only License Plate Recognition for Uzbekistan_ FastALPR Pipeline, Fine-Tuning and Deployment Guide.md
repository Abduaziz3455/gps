# CPU-Only License Plate Recognition (ALPR): Best Fast + Accurate Pipeline — Simplified Report

**Top recommendation: use the MIT-licensed FastALPR stack — the open-image-models YOLOv9 plate detector (`yolo-v9-t-384`/`t-640`, or `s-608` for maximum accuracy) plus the fast-plate-ocr `cct-s-v2-global-model` OCR, run with ONNX Runtime/OpenVINO on CPU — and fine-tune the OCR on a few thousand Uzbek plate crops before production.** It is the only open-source option found that is plate-specific at both stages, ships ready ONNX models, runs comfortably in real time on a normal CPU, and has a documented fine-tuning path. The only public Uzbek-trained model found is Hugging Face `IzzatulloOne/anpr-uz` (a TPS-ResNet-BiLSTM-CTC recognizer, 90% exact-match on 80 real photos), but it is licensed CC-BY-NC-4.0 (non-commercial only). For a product, local fine-tuning plus a format-validation step is what will turn "good" accuracy into "production" accuracy.

## TL;DR
- **Best pipeline:** (optional) vehicle detector → `yolo-v9-t-384`/`t-640` plate detector (mAP50 0.92–0.958) → `cct-s-v2-global-model` OCR (sub-millisecond per plate on GPU, a few ms on CPU) → Uzbek regex/format validation + multi-frame voting. All MIT code, ONNX, CPU-friendly; realistic budget is tens of milliseconds per frame on a modern 4-core x86 CPU.
- **Uzbekistan:** no commercially usable open model or meaningful open dataset exists for Uzbek plates. The only Uzbek model is non-commercial (`IzzatulloOne/anpr-uz`, CC-BY-NC-4.0), and the only Roboflow Uzbek project has 40 images (its model checkpoint was trained on just 14). Plan to collect and label ~5–20k local plate crops. The open-nvr/ai-adapter `indian-plates-v1` fine-tune of `cct-s-v2-global-model` raised exact-plate accuracy from 38.9% to 85.1%, measured on 404 real crops held out by plate number. Two-row plates (motorcycles, trailers) must be explicitly included in training.
- **Avoid / consider:** Ultralytics YOLO (v8–YOLO26) is fast (YOLO26n 38.9 ms CPU ONNX) but AGPL-3.0 — closed-source products need a paid Enterprise License; use RF-DETR (Apache 2.0) or the MIT stack instead.\[1\]\[2\] If you'd rather buy than build, Plate Recognizer, DTK LPR SDK and SimpleLPR list Uzbekistan support; general OCR (PaddleOCR, EasyOCR, Tesseract) is a fallback, not a first choice.\[3\]\[4\]\[5\]

## Key Findings

1. **Plate-specific beats general-purpose.** fast-plate-ocr's CCT models read the whole cropped plate in one shot (no character segmentation, no text-line detection), which is why they are 1–2 orders of magnitude faster than general OCR.\[6\] PP-OCRv5 mobile recognition, by comparison, is listed at 21.20 ms (normal) / 5.32 ms (high-performance mode) on CPU and 16 MB, and is trained for documents/scene text, not plates.\[7\]
2. **Detector accuracy scales with input size.** open-image-models publishes: `s-608` mAP50 0.966 / mAP50-95 0.772; `t-640` 0.958 / 0.758; `t-512` 0.948 / 0.724; `t-416` 0.94 / 0.702; `t-384` 0.92 / 0.687; `t-256` 0.858 / 0.606.\[8\] A third-party deployment measured `s-608` at ~101 ms per pass on a development CPU and found it read 15 distinct plates vs 10 for `t-384` on the same 100-second video — larger input finds more small/distant plates.\[9\]
3. **Global OCR models are a starting point, not a finish line.** The v2 CCT models (released March 2026 in fast-plate-ocr 1.1.0) were trained on ~3x the data of v1 (v1 used 220k global plates), cover 65+ countries and also predict plate region.\[10\] But on a local format they underperform until fine-tuned. In the open-nvr/ai-adapter `indian-plates-v1` release, Indian plates went from 38.9% exact / 75.6% character accuracy with the global model to 85.1% / 97.0% after fine-tuning on 22,110 crops. Accuracy was measured on 404 real crops held out by plate number. The release adds that 17 of the 60 remaining misses were typos in the validation labels, so the true exact rate is close to 89%.
4. **Academic benchmarks confirm that OCR choice matters less than data.** Laroca et al. compared 16 OCR models across 12 public datasets (incl. AOLP, UFPR-ALPR, RodoSol-ALPR, CCPD-family ChineseLP) in "Advancing Multinational License Plate Recognition Through Synthetic and Real Data Fusion" (IET Intelligent Transport Systems, vol. 19, 2025). With real + synthetic training data, all models reached 94.6%–97.9% average recognition. Commercial Sighthound and OpenALPR scored only 57.0% and 69.3% on RodoSol-ALPR. Lesson: domain-matched training data drives accuracy.
5. **Licensing is the main trap.** Ultralytics YOLOv5/v8/YOLO11/YOLO12/YOLO26 are AGPL-3.0 (including your trained weights); closed-source commercial use requires an Ultralytics Enterprise License.\[2\]\[11\] RF-DETR Nano–Large and D-FINE are Apache 2.0.\[12\]\[13\] fast-alpr, fast-plate-ocr and open-image-models code is MIT — but the license of the *pretrained weights* and their training data has not been explicitly confirmed by the author (a GitHub issue asking this was closed with no visible answer), and the YOLOv9 training lineage (original YOLOv9 repo is GPL-3.0) is a gray zone.\[9\]\[14\]\[15\]

## Comparison Table (top candidates)

| Stage | Option | CPU speed | Accuracy | Size | License | Verdict |
|---|---|---|---|---|---|---|
| Plate detector | open-image-models `yolo-v9-t-384` | Fast (est. ~15–40 ms/frame on 4-core x86; measure with built-in benchmark) | mAP50 0.92, mAP50-95 0.687 | 7.8 MB | MIT code (weights unconfirmed) | **Default for speed** |
| Plate detector | `yolo-v9-t-640` | Slower than t-384 | mAP50 0.958, mAP50-95 0.758 | 7.8 MB | MIT code | **Best balance for distant/small plates** |
| Plate detector | `yolo-v9-s-608` | ~101 ms/pass (third-party, unnamed dev CPU) | mAP50 0.966, mAP50-95 0.772 | 28.6 MB | MIT code | Max accuracy, ~10 FPS |
| Detector (train your own) | YOLO26n | 38.9 ms CPU ONNX @640 (Xeon 2.0 GHz); 13.9 ms on Apple M5 Pro | COCO mAP 40.9 (generic) | 2.4M params | AGPL-3.0 / paid Enterprise | Fast, but license cost for closed products |
| Detector (train your own) | RF-DETR Nano | Good on GPU; CPU path less mature | COCO mAP50:95 48.4 | 30.5M params | Apache 2.0 | Best permissive option for vehicle detection |
| OCR | fast-plate-ocr `cct-s-v2-global-model` | 0.68 ms on RTX 3090; few ms on CPU (legacy models: 2.1–2.9 ms on M1 CPU) | Recommended default; 65+ countries | 5.3 MB | MIT code | **Recommended OCR (fine-tune for UZ)** |
| OCR | `cct-xs-v2-global-model` | 0.47 ms on RTX 3090 | Slightly lower than S | ~2–3 MB | MIT code | For weak CPUs / many cameras |
| OCR | PP-OCRv5 mobile rec (PaddleOCR) | 21.2 ms (normal) / 5.3 ms (HPI) CPU | 81.29% avg (general text) | 16 MB (en model 7.5 MB) | Apache 2.0 | Fallback; general text, needs tuning |
| OCR | EasyOCR / Tesseract / TrOCR | Slow on CPU (detection + recognition, or large transformer) | Weak on plates without tuning | Large | Apache / Apache / MIT | Not recommended |
| End-to-end (open) | **FastALPR** (above two combined) | Real-time on CPU | As above | ~10–35 MB total | MIT | **Top pick** |
| End-to-end (open) | HyperLPR3 | <100 ms per 720p frame, single core | 95–97% (Chinese plates) | Small | Apache 2.0 | Chinese plates only — not for UZ |
| End-to-end (open) | OpenALPR (open-source) | ~12–70 FPS on desktop CPUs (vendor) | 69.3% on RodoSol (commercial ver.) | — | AGPL / proprietary | Outdated |
| End-to-end (commercial) | Doubango ultimateALPR | Up to 237 FPS on Xeon with OpenVINO; 12 FPS on Raspberry Pi 4 (vendor) | Vendor claims | — | Proprietary (free to evaluate) | Fastest; check UZ support & price |
| End-to-end (commercial) | Plate Recognizer SDK | 50–100 ms on 7th–8th gen Intel 4-core | Vendor claims; 90+ countries incl. Uzbekistan | Docker | Paid | Easiest "buy" option |
| End-to-end (commercial) | DTK LPR SDK / SimpleLPR | DTK: 15–40 ms/frame CPU | DTK claims 98%; both list Uzbekistan; DTK supports 2-line | — | Paid (SimpleLPR $450 one-time) | Cheap commercial fallback |

*Speeds come from different hardware and are vendor- or third-party-reported; benchmark on your own CPU before deciding.*

## Recommended Pipeline Architecture

```
Camera / RTSP frame
   │
   ├─(1) Vehicle detector (optional)  RF-DETR Nano (Apache) or YOLO26n (AGPL) — classes: car, truck, bus, motorcycle
   │        → skips plate search on empty frames, gives vehicle type, enables tracking
   │
   ├─(2) Plate detector  open-image-models yolo-v9-t-640 (or t-384 for speed) on the vehicle crop or full frame
   │
   ├─(3) Crop + light pre-processing  pad box 5–10%, optional deskew, keep aspect ratio
   │
   ├─(4) OCR  fast-plate-ocr cct-s-v2 fine-tuned on Uzbek plates (one-row AND two-row crops)
   │
   └─(5) Post-processing
          • Uzbek format regex + region-code whitelist
          • Position-aware character fixes (0↔O, 1↔I, 8↔B, 5↔S, 2↔Z)
          • Multi-frame voting per tracked vehicle (e.g., ByteTrack) + confidence threshold
```

**Why vehicle detection first?** It is optional. The plate detector works directly on full frames, but a vehicle stage cuts false positives (signs, text on trucks), gives you the vehicle class (car/truck/bus/motorcycle) for free, and lets you track each vehicle and vote over several frames — the single cheapest accuracy boost. Note open-image-models now also ships RF-DETR COCO detectors (`rf-detr-nano-384-coco`), which include car/truck/bus/motorcycle classes.\[8\]

**Minimal implementation (Python):**
```python
# pip install fast-alpr[onnx-openvino]   (Intel CPU)  or  fast-alpr[onnx]  (any CPU)
from fast_alpr import ALPR
alpr = ALPR(detector_model="yolo-v9-t-640-license-plate-end2end",
            ocr_model="cct-s-v2-global-model")
results = alpr.predict(frame)   # list of plate boxes + text + confidence
```
Swap in your fine-tuned OCR (`.onnx` + `plate_config.yaml`) once trained, and wrap the output with the validation step below.

**Uzbek format validation (post-processing):**
- Standard private: `RR L DDD LL` → e.g., `01 A 123 BC` → regex `^(01|10|20|25|30|40|50|60|70|75|80|85|90|95)[A-Z]\d{3}[A-Z]{2}$`\[16\]
- Alternative private: `RR DDD LLL` → e.g., `01 123 ABC` → `^(region)\d{3}[A-Z]{3}$`\[16\]
- Region codes: 01 Tashkent city, 10 Tashkent region, 20 Sirdaryo, 25 Jizzakh, 30 Samarqand, 40 Fergana, 50 Namangan, 60 Andijan, 70 Qashqadaryo, 75 Surxondaryo, 80 Bukhara, 85 Navoiy, 90 Xorazm, 95 Karakalpakstan.\[16\]
- Special plates to allow: foreign citizens `H` + 6 digits (yellow), foreign companies `M` + 6 digits (green), diplomatic `CMD`/`D`/`T` + 3-digit mission code (green), UN series (blue), temporary/transit plates.\[16\]
- Two-row plates: motorcycles (three digits top, two letters bottom, region code upper right) and trailers (four digits top, two letters bottom).\[16\] Read both rows into one string in a fixed order (e.g., region + top + bottom) and validate with a separate regex.
- Use the regex to choose between the OCR's top candidates, and to map ambiguous characters by slot (a digit slot can't contain "O", a letter slot can't contain "0").

## Fine-Tuning for Uzbek Plates

- **Data reality:** there is no commercially usable Uzbek-trained plate model. Hugging Face `IzzatulloOne/anpr-uz` is a TPS-ResNet-BiLSTM-CTC recognizer for Uzbek plates that reports 90% exact-match on an independent sample of 80 real photos, but it is CC-BY-NC-4.0 (non-commercial only). It is useful as a reference or for auto-labeling experiments, not for shipping. The only Uzbek Roboflow project ("Uzbek car license number ocr", CC BY 4.0) has 40 images, and its model checkpoint was trained on just 14. A Tashkent developer's open-source project reports finding zero Uzbek plate models or datasets on Hugging Face. Commercial datasets (e.g., Unidata/UniDataPro, 86–93 countries) list Uzbekistan if you want to buy a starting set.\[17\]\[18\] Nomeroff Net publishes OCR datasets for Kazakh, Kyrgyz and other ex-USSR plates that may help as auxiliary data.\[19\]
- **Detector:** the global YOLOv9 detector will likely find Uzbek plates as-is (same rectangular white plate shape). Fine-tune only if you see misses on two-row motorcycle/trailer plates or at your specific camera angles — 1–3k labeled frames is usually enough.
- **OCR (most important):**
  1. Collect plate crops from your actual cameras (day/night/IR, rain, dirty plates, angles). Auto-label with the global model, then correct by hand — far faster than labeling from scratch.
  2. Target ~5–20k crops, including a deliberate share of two-row motorcycle/trailer plates and special (H/M/diplomatic) plates. The Indian fine-tune used 22,110 crops and noted two-line plates were under-represented — avoid that gap.\[20\]
  3. Write a `plate_config.yaml`: Latin alphabet A–Z + 0–9 + pad char, `max_plate_slots` ≥ 9 (covers `CMD` + digits and two-row strings), `keep_aspect_ratio: true`, RGB input (e.g., 128×64).\[21\]
  4. `pip install fast-plate-ocr[train]`, then `fast-plate-ocr train` starting from `cct-s-v2-global-model` weights (the repo has a fine-tuning notebook).\[6\] The open-nvr/ai-adapter `indian-plates-v1` release documents its recipe as: "fast-plate-ocr train from the global weights, lr 5e-4 then 3e-4, batch 64, early stopping on val_plate_acc; two rounds."
  5. Add synthetic plates (rendered Uzbek fonts/layouts) to cover rare region codes and letter combinations; Laroca et al. found synthetic + real data fusion consistently improves recognition.\[22\]
  6. Export to ONNX (`fast-plate-ocr export`) and validate on a held-out set **split by plate number**, so the same car never appears in both train and test.\[20\]\[23\]

## CPU Deployment Tips

- **Runtime:** ONNX Runtime CPU everywhere; on Intel CPUs install the OpenVINO extra (`[onnx-openvino]`) — Doubango's own figures show OpenVINO giving roughly 3x higher FPS on the same i7 (131.78 vs 41.18 FPS).\[24\] TensorRT is GPU-only and not applicable.
- **Input size is the biggest speed knob:** t-384 → t-512 → t-640 trades speed for small-plate recall. Pick the smallest size that reliably finds plates at your camera distance.
- **Skip frames and gate work:** run the detector at 5–10 FPS, not 25–30; run OCR only on new/tracked plates; vote over 3–5 reads per vehicle.
- **Batching and threads:** batch OCR crops from one frame; set `intra_op_num_threads` to physical cores for a single stream, or run one process per camera with 1–2 threads each for many streams.
- **INT8 quantization:** ONNX Runtime/OpenVINO post-training INT8 can speed up the detector further on CPUs with VNNI/AMX, but re-check mAP and plate accuracy after quantizing (PaddleOCR reports quantization changes accuracy and speed non-trivially). The OCR is already tiny, so quantize the detector first.
- **Measure on your hardware:** `LicensePlateRecognizer("cct-s-v2-global-model").benchmark()` for OCR and `yolo benchmark ... format=onnx` (Ultralytics) or the open-image-models benchmark helper for detectors.\[6\]\[25\]

## Caveats

- **No independent CPU benchmark exists for the recommended v2 OCR and YOLOv9 plate models.** The author's OCR latencies were measured on an RTX 3090 GPU; detector CPU timings were never published (a placeholder in early docs).\[26\]\[27\] The ~15–40 ms detector and "few ms" OCR CPU figures above are estimates — benchmark before committing to camera counts.
- **Uzbek coverage is unverified.** fast-plate-ocr's v2 models cover "65+ countries", but the country list (in `cct_s_v2_global_plate_config.yaml` in the release assets) was not confirmed to include Uzbekistan; no source confirms two-row plate support in the global models.\[10\]
- **Weight licensing:** the MIT license clearly covers the code; for a closed-source or government deployment, get written confirmation from the author or retrain the detector yourself on your own data with a permissively licensed detector (RF-DETR, Apache 2.0) to eliminate risk.
- **Vendor numbers** (Doubango, Plate Recognizer, DTK, OpenALPR) are self-reported marketing figures on vendor-chosen hardware.\[4\]\[28\]\[29\]\[30\] The unofficial "FastPlateOCR API" site is not affiliated with the fast-plate-ocr author, so ignore its accuracy claims.\[31\]
- **Privacy/legal:** ALPR data is personal data, so secure its storage and access. TechCrunch reported in December 2025 that Uzbekistan's national traffic-camera ALPR database (about 100 camera sites, built on Chinese vendor Maxvision's system) was "exposed online without a password," leaking millions of photos and raw video.

## Sources

1. [which version of yolo is free for commercial use if any thanks.. · ultralytics · Discussion #3974 · GitHub](https://github.com/orgs/ultralytics/discussions/3974)
2. [Is YOLO Free for Commercial Use? AGPL-3.0 Explained](https://www.eurthtech.com/post/is-yolo-free-for-commercial-use-agpl-apache-alternatives)
3. [90+ Countries, 6 Continents](https://platerecognizer.com/countries/)
4. [License Plate Recognition SDK - High quality LPR](https://www.dtksoft.com/lprsdk)
5. [License Plate Recognition Software & SDK - SimpleLPR](https://www.warelogic.com/)
6. [GitHub - ankandrew/fast-plate-ocr: Lightweight & fast OCR models for license plate text recognition. · GitHub](https://github.com/ankandrew/fast-plate-ocr)
7. [Usage Tutorial - PaddleOCR Documentation](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html)
8. [GitHub - ankandrew/open-image-models: Pre-trained image models using ONNX for fast, out-of-the-box inference.](https://github.com/ankandrew/open-image-models)
9. [GitHub - jpalvadev/licence-plate-detector · GitHub](https://github.com/jpalvadev/licence-plate-detector)
10. [Releases · ankandrew/fast-plate-ocr · GitHub](https://github.com/ankandrew/fast-plate-ocr/releases)
11. [What It Takes to Use a YOLO Model Legally in a Commercial Product](https://savant-ai.io/blog/yolo-commercial-licensing/)
12. [GitHub - roboflow/rf-detr: RF-DETR is a real-time object detection and segmentation model architecture developed by Roboflow, SOTA on COCO, designed for fine-tuning. \[ICLR 2026\] · GitHub](https://github.com/roboflow/rf-detr)
13. [Best Ultralytics Alternatives in 2026](https://www.libreyolo.com/articles/best-ultralytics-alternatives)
14. [Clarify MIT coverage of CCT-v2 pretrained weights and fine-tuned derivatives · Issue #97 · ankandrew/fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr/issues/97)
15. [License of the pretrained model weights (detector and OCR) · Issue #50 · ankandrew/fast-alpr · GitHub](https://github.com/ankandrew/fast-alpr/issues/50)
16. [Vehicle registration plates of Uzbekistan](https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Uzbekistan)
17. [Car License Plate Detection Dataset - 3 809 704 Images for Plate Detection and OCR - Databricks Marketplace](https://marketplace.databricks.com/details/a1776113-4df3-4ce7-bf0c-05735cad8434/Unidata_Car-License-Plate-Detection-Dataset-3-809-704-Images-for-Plate-Detection-and-OCR)
18. [UniDataPro/license-plate-detection · Datasets at Hugging Face](https://huggingface.co/datasets/UniDataPro/license-plate-detection)
19. [Nomeroff Net. Automatic numberplate recognition system. Version 3.5.0](https://github.com/ria-com/nomeroff-net)
20. [Release Indian plates OCR model v1 · open-nvr/ai-adapter · GitHub](https://github.com/open-nvr/ai-adapter/releases/tag/indian-plates-v1)
21. [Configuration Parameters](https://deepwiki.com/ankandrew/fast-plate-ocr/6.2-configuration-parameters)
22. [Advancing Multinational License Plate Recognition ...](https://raysonlaroca.github.io/papers/laroca2025advancing-published.pdf)
23. [GitHub - Prathamesh9764/FastPlateOCR-Training-Pipeline · GitHub](https://github.com/Prathamesh9764/FastPlateOCR-Training-Pipeline)
24. [ultimateALPR-SDK/samples/c++/benchmark/README.md at master · DoubangoTelecom/ultimateALPR-SDK · GitHub](https://github.com/DoubangoTelecom/ultimateALPR-SDK/blob/master/samples/c++/benchmark/README.md)
25. [Choose an Ultralytics YOLO Model Size](https://academy.ultralytics.com/courses/train-your-first-yolo/choose-a-model-size)
26. [pypi.org](https://pypi.org/project/open-image-models/0.1.0)
27. [Available Models - FastPlateOCR](https://ankandrew.github.io/fast-plate-ocr/latest/inference/model_zoo/)
28. [Intro — ultimateALPR 3.13.0 documentation](https://www.doubango.org/SDKs/anpr/docs/)
29. [ALPR for Blue Iris](https://platerecognizer.com/blueiris/)
30. [OpenALPR - Our Technologies](https://cdn.openalpr.com/benchmarks.html)
31. [Security: Unofficial site using project name · Issue #78 · ankandrew/fast-plate-ocr · GitHub](https://github.com/ankandrew/fast-plate-ocr/issues/78)
