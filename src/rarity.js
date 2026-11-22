// Rarity is derived, never asked of the model and never a second request.
// These thresholds are the only place the tiers are decided.

export const TIERS = ["common", "notable", "rare", "singular"];

/** Specificity score (0-100) to tier. */
export function rarityFor(specificity) {
  const score = Math.min(100, Math.max(0, Math.round(Number(specificity) || 0)));
  if (score >= 90) return "singular";
  if (score >= 70) return "rare";
  if (score >= 40) return "notable";
  return "common";
}

/** Album order: rarest first. */
export const RARITY_RANK = { singular: 0, rare: 1, notable: 2, common: 3 };

export const TIER_LABEL = {
  common: "Common",
  notable: "Notable",
  rare: "Rare",
  singular: "Singular",
};
