"""Plate reading: vehicle -> plate box -> text. CPU only, ONNX Runtime, one thread per model.

Chosen and measured in docs/plate-recognition-plan.md (section 9):
  1. RF-DETR nano (COCO) finds vehicles; the plate is searched inside each vehicle at full resolution, because a
     plate is only 60-200 px wide in a 2560 px picture and shrunk whole it is too small to find.
  2. No vehicle found (a dark truck at night): the plate detector looks at four zoomed quarters of the picture.
  3. The YOLOv9 t-384 plate detector finds the plate; fast-plate-ocr cct-s-v2, fine-tuned on our own gate pictures,
     reads it.
Reads are only suggestions: the app validates and corrects them with the same rules as camera reads.
"""
import os

import cv2
import numpy as np
import onnxruntime as ort

MODELS = os.environ.get('READER_MODELS', '/models')
VEHICLES = {'car', 'truck', 'bus', 'motorcycle'}
EDGE_PX = 4  # a plate box touching the left or right edge holds a cut-off plate: its read is a guess


def _opts(threads=1):
    o = ort.SessionOptions()
    o.intra_op_num_threads = threads
    o.inter_op_num_threads = 1
    return o


def scene(img):
    """The camera prints its own read in a text strip under the 16:9 picture: never let a model see it."""
    return img[:min(img.shape[0], round(img.shape[1] * 9 / 16))]


def _iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u else 0


class Reader:
    def __init__(self, models=MODELS, threads=1):
        # open-image-models keeps its downloads here; the image ships them, so nothing is fetched at run time.
        os.environ.setdefault('XDG_CACHE_HOME', os.path.join(models, 'cache'))
        from fast_plate_ocr import LicensePlateRecognizer
        from open_image_models import create_detector
        p = ['CPUExecutionProvider']
        self.vehicle = create_detector(os.path.join(models, 'rf-detr-nano-384-coco.onnx'), backend='rf_detr',
                                       class_labels=_coco_labels(), conf_thresh=0.3, providers=p, sess_options=_opts(threads))
        self.plate = create_detector(os.path.join(models, 'yolo-v9-t-384-license-plates-end2end.onnx'), backend='yolo_v9',
                                     class_labels=['License Plate'], conf_thresh=0.25, providers=p, sess_options=_opts(threads))
        self.ocr = LicensePlateRecognizer(onnx_model_path=os.path.join(models, 'plates_uz.onnx'),
                                          plate_config_path=os.path.join(models, 'plates_uz.yaml'), providers=p, sess_options=_opts(threads))

    def boxes(self, img):
        """Plate boxes [x1, y1, x2, y2, conf], best first."""
        found = []
        vs = [v for v in self.vehicle.predict(img) if v.label in VEHICLES]
        vs = sorted(vs, key=lambda v: -(v.bounding_box.x2 - v.bounding_box.x1) * (v.bounding_box.y2 - v.bounding_box.y1))[:3]
        for v in vs:
            b = v.bounding_box
            x1, y1, x2, y2 = max(0, b.x1), max(0, b.y1), min(img.shape[1], b.x2), min(img.shape[0], b.y2)
            if x2 - x1 < 32 or y2 - y1 < 32:
                continue
            for p in self.plate.predict(img[y1:y2, x1:x2]):
                q = p.bounding_box
                found.append([q.x1 + x1, q.y1 + y1, q.x2 + x1, q.y2 + y1, float(p.confidence)])
        if not vs:  # no vehicle at all: look in the whole frame and in four zoomed quarters
            for p in self.plate.predict(img):
                q = p.bounding_box
                found.append([q.x1, q.y1, q.x2, q.y2, float(p.confidence)])
        if not found:
            H, W = img.shape[:2]
            th, tw = int(H * 0.6), int(W * 0.6)
            for ty in (0, H - th):
                for tx in (0, W - tw):
                    for p in self.plate.predict(img[ty:ty + th, tx:tx + tw]):
                        q = p.bounding_box
                        found.append([q.x1 + tx, q.y1 + ty, q.x2 + tx, q.y2 + ty, float(p.confidence)])
        found.sort(key=lambda d: -d[4])
        kept = []
        for d in found:
            if all(_iou(d, k) < 0.5 for k in kept):
                kept.append(d)
        return kept[:4]

    def read(self, img):
        """[{plate, conf, det, box, cut}] for every plate box in a BGR picture (already without the text strip)."""
        out = []
        H, W = img.shape[:2]
        for x1, y1, x2, y2, det in self.boxes(img):
            w, h = x2 - x1, y2 - y1
            a, b = max(0, int(x1 - w * 0.05)), max(0, int(y1 - h * 0.05))
            c, d = min(W, int(x2 + w * 0.05)), min(H, int(y2 + h * 0.05))
            crop = img[b:d, a:c]
            if crop.size == 0:
                continue
            p = self.ocr.run_one(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), return_confidence=True)
            probs = [float(x) for x in (p.char_probs if p.char_probs is not None else [])]
            out.append({'plate': p.plate, 'conf': round(min(probs) if probs else 0.0, 3), 'det': round(det, 3),
                        'box': [int(x1), int(y1), int(x2), int(y2)], 'cut': bool(x1 <= EDGE_PX or x2 >= W - EDGE_PX)})
        return out


def _coco_labels():
    from open_image_models.detection.core.coco import COCO_CLASSES
    return COCO_CLASSES  # {class id: name}, ids as the model outputs them


def decode(buf):
    img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('not a picture')
    return img
