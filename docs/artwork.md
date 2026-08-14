# Artwork selection

> [简体中文](zh-CN/artwork.md) | **English**

YAQMC uses one centralized resolver for small (150), medium (300), large (500), and fullscreen (800) contexts. It
chooses the smallest measured variant meeting the target, otherwise the largest known variant. Unknown arbitrary
URLs are preserved and are never rewritten into invented larger URLs. See the detailed
[QQ Music artwork evidence](qqmusic-artwork.md) for verified CDN samples and cache/security rules.
