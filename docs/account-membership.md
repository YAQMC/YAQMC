# QQ Music account membership

> [简体中文](zh-CN/account-membership.md) | **English**

YAQMC models the primary tier, membership lifecycle, and secondary entitlements independently. The primary tier is
one of Free, Green Diamond, Super VIP, or Unknown. Luxury/annual/family/trial and similar flags are understated
secondary entitlements and never overwrite the primary tier.

The QQ normalizer treats `identity.vip` as Green Diamond and the top-level `svip` result as Super VIP. `HugeVip` is
a Luxury Green Diamond secondary entitlement rather than Super VIP. Missing, malformed, or contradictory flags
produce Unknown; expired authorization is an account state and is never shown as Free.

The UI displays only the normalized nickname, allowlisted avatar URL, masked identity, tier, lifecycle, expiry, and
secondary entitlements. Raw provider responses, cookies, UINs, and authorization material never enter component
props or diagnostic copy. See [Playback entitlement](entitlement.md) for the separate quality-selection model.
