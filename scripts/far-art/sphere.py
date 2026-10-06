"""Equirectangular map -> orthographic sphere sprite, the way public/globes
was made (unlit, tilt baked in). Calibrated against an existing sprite."""
import numpy as np
from PIL import Image

def load_map(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255.0

def sample(m, lat, lon):
    """Bilinear sample of an equirect map at lat [-pi/2,pi/2], lon [-pi,pi)."""
    H, W, _ = m.shape
    u = (lon / (2 * np.pi) + 0.5) * W - 0.5
    v = (0.5 - lat / np.pi) * H - 0.5
    u0 = np.floor(u).astype(int); v0 = np.floor(v).astype(int)
    du = (u - u0)[..., None]; dv = (v - v0)[..., None]
    u0m = u0 % W; u1m = (u0 + 1) % W
    v0c = np.clip(v0, 0, H - 1); v1c = np.clip(v0 + 1, 0, H - 1)
    a = m[v0c, u0m]; b = m[v0c, u1m]; c = m[v1c, u0m]; d = m[v1c, u1m]
    return (a * (1 - du) + b * du) * (1 - dv) + (c * (1 - du) + d * du) * dv

def render_sphere(m, size=512, tilt=0.0, lon0=0.0, limb=0.0, flatten=0.0, aa=2):
    """Orthographic disc. limb: 0..1 strength of edge darkening.
    flatten: oblateness (vertical squash) like the FLATTEN table."""
    N = size * aa
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    R = N / 2.0
    nx = (xx + 0.5 - R) / R
    ny = (R - (yy + 0.5)) / R
    if flatten:
        ny = ny / (1.0 - flatten)
    r2 = nx * nx + ny * ny
    inside = r2 <= 1.0
    nz = np.sqrt(np.clip(1.0 - r2, 0, 1))
    # tilt about the view-x axis
    ct, st = np.cos(tilt), np.sin(tilt)
    y2 = ny * ct + nz * st
    z2 = -ny * st + nz * ct
    lat = np.arcsin(np.clip(y2, -1, 1))
    lon = np.arctan2(nx, z2) + lon0
    lon = (lon + np.pi) % (2 * np.pi) - np.pi
    col = sample(m, lat, lon)
    if limb:
        col = col * (1.0 - limb * (1.0 - nz))[..., None]
    alpha = inside.astype(np.float32)
    rgba = np.concatenate([np.clip(col, 0, 1), alpha[..., None]], axis=-1)
    img = Image.fromarray((rgba * 255).astype(np.uint8), 'RGBA')
    if aa > 1:
        img = img.resize((size, size), Image.LANCZOS)
    return img
