#!/usr/bin/env python3
"""Perspective (keystone) correction for train-car images.

Two modes:
  detect  <image>        -> auto-detect the projective distortion and emit the
                            four corners of a corrected quadrilateral + the
                            homography as JSON.
  apply   <image> <out> <json> -> warp <image> using a homography (or 4 corners)
                            to <out>.

Detection approach:
  1. Find long straight edges (Canny + Hough).
  2. Split lines into near-horizontal and near-vertical clusters.
  3. Estimate each cluster's vanishing point via least squares.
  4. Build a homography that maps those vanishing points to infinity, then
     rotate so the dominant axis is level — i.e. "square up" the box.
  5. Emit the source quadrilateral corners (for a draggable UI) and the
     corresponding destination rectangle.

This is a best-effort detector; the UI always lets the user tweak the corners
and re-apply, and the result is saved as a clone (never overwrites).
"""
import sys
import json
import numpy as np
import cv2


def detect_lines(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=80,
                            minLineLength=img.shape[1] * 0.25, maxLineGap=30)
    if lines is None:
        return []
    out = []
    for l in lines:
        x1, y1, x2, y2 = int(l[0]), int(l[1]), int(l[2]), int(l[3])
        dx, dy = x2 - x1, y2 - y1
        length = np.hypot(dx, dy)
        if length < img.shape[1] * 0.2:
            continue
        out.append((x1, y1, x2, y2, length))
    return out


def line_angle(x1, y1, x2, y2):
    return np.arctan2(y2 - y1, x2 - x1)


def vanishing_point(lines):
    """Least-squares intersection of a set of nearly-parallel lines."""
    A = []
    b = []
    for (x1, y1, x2, y2, _) in lines:
        # line: (dy)x - (dx)y = dy*x1 - dx*y1
        dx = x2 - x1
        dy = y2 - y1
        a = dy
        c = -dx
        dval = dy * x1 - dx * y1
        A.append([a, c])
        b.append(dval)
    A = np.array(A, dtype=np.float64)
    b = np.array(b, dtype=np.float64)
    if A.shape[0] < 2:
        return None
    # SVD solve
    vp, _, _, _ = np.linalg.lstsq(A, b, rcond=None)
    return vp


def detect(img):
    h, w = img.shape[:2]
    lines = detect_lines(img)
    if not lines:
        return None

    # Split into horizontal (angle near 0 or pi) and vertical (near +-pi/2)
    horiz, vert = [], []
    for l in lines:
        a = line_angle(*l[:4]) % np.pi
        if a < np.pi / 6 or a > 5 * np.pi / 6:
            horiz.append(l)
        elif np.pi / 3 < a < 2 * np.pi / 3:
            vert.append(l)

    vp_h = vanishing_point(horiz) if len(horiz) >= 2 else None
    vp_v = vanishing_point(vert) if len(vert) >= 2 else None

    # Default: no correction (identity).
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])

    # Horizontal keystone: straighten the top/bottom edges using the horizontal
    # vanishing point. If vp_h is far to left/right/up/down of center, the
    # horizontal lines converge: force their endpoints horizontal+parallel.
    if vp_h is not None:
        hx, hy = float(vp_h[0]), float(vp_h[1])
        # How far the VP deviates from the image center drives correction strength.
        cx, cy = w / 2, h / 2
        # Horizontal convergence (VP off-center horizontally) -> trapezoid.
        # Vertical convergence (VP off-center vertically) -> pitch.
        dxh = np.clip((hx - cx) / (w * 0.5), -1.0, 1.0)
        dyh = np.clip((hy - cy) / (h * 0.5), -1.0, 1.0)

        # Shift top/bottom edges to counter horizontal convergence (left-right).
        # Positive dxh (VP to the right) => top edge should shift right so lines diverge.
        top_sx = w * 0.30 * dxh
        bot_sx = -w * 0.30 * dxh
        # Pitch correction (VP above/below center): top/bottom edges scale inward/outward.
        top_sy = h * 0.15 * dyh
        bot_sy = -h * 0.15 * dyh

        src = np.float32([
            [top_sx,        top_sy],
            [w + top_sx,    top_sy],
            [w + bot_sx,    h + bot_sy],
            [bot_sx,        h + bot_sy],
        ])
        # Clip to keep points inside a plausible region.
        src = np.clip(src, [-w*0.5, -h*0.5], [w*1.5, h*1.5])

    src = np.float32(src).reshape(4, 2)
    dst = np.float32(dst).reshape(4, 2)

    H = cv2.getPerspectiveTransform(src, dst) if np.any(src != dst) else np.eye(3)

    return {
        'src': src.reshape(-1).tolist(),  # [x0,y0,x1,y1,x2,y2,x3,y3] TL,TR,BR,BL
        'dst': dst.reshape(-1).tolist(),
        'vp_h': None if vp_h is None else vp_h.tolist(),
        'vp_v': None if vp_v is None else vp_v.tolist(),
        'horiz_lines': len(horiz),
        'vert_lines': len(vert),
        'has_correction': bool((src != dst).any()),
    }


def apply_warp(inp, outp, src_pts):
    img = cv2.imread(inp)
    h, w = img.shape[:2]
    src = np.float32(src_pts).reshape(4, 2)
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    # Warp the full image so its rectangle maps onto the dragged corners
    # ("drag the result directly" — output matches the live preview).
    H = cv2.getPerspectiveTransform(dst, src)
    warped = cv2.warpPerspective(img, H, (w, h), borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    cv2.imwrite(outp, warped, [cv2.IMWRITE_JPEG_QUALITY, 92])


def main():
    mode = sys.argv[1]
    inp = sys.argv[2]
    img = cv2.imread(inp)
    if img is None:
        print(json.dumps({'error': f'cannot read {inp}'}))
        sys.exit(1)

    if mode == 'detect':
        res = detect(img)
        print(json.dumps(res or {'error': 'no lines detected'}))
    elif mode == 'apply':
        outp = sys.argv[3]
        pts = json.loads(sys.argv[4])
        src_pts = pts.get('src', pts.get('points'))
        apply_warp(inp, outp, src_pts)
        print(json.dumps({'ok': True, 'out': outp}))
    else:
        print(json.dumps({'error': f'unknown mode {mode}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()