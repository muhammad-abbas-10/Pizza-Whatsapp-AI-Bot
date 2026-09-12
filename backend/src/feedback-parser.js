function parseFeedback(input) {
  const original = String(input || "").trim().slice(0, 2000);
  let remainder = original;
  let rawRating = null;

  const takeNumericMatch = (pattern, ratingGroup = 1) => {
    const match = remainder.match(pattern);
    if (!match) return false;
    rawRating = Number(match[ratingGroup]);
    remainder = `${remainder.slice(0, match.index)} ${remainder.slice(match.index + match[0].length)}`;
    return true;
  };

  takeNumericMatch(
    /\b(?:i(?:\s+would|'d)?\s+)?(?:would\s+)?(?:give|rate)(?:\s+(?:it|this|the\s+(?:order|experience)))?(?:\s+(?:a|as))?\s*(-?\d+)(?:\s*\/\s*\d+|\s+out\s+of\s+\d+)?\b/i
  )
    || takeNumericMatch(/^\s*(-?\d+)(?:\s*(?:\/\s*\d+|out\s+of\s+\d+))?/i)
    || takeNumericMatch(/\b(?:rating|score)\s*(?::|is)?\s*(-?\d+)(?:\s*\/\s*\d+|\s+out\s+of\s+\d+)?\b/i)
    || takeNumericMatch(/(-?\d+)\s*\/\s*\d+\b/i);

  if (rawRating === null) {
    const stars = remainder.match(/(?:⭐\uFE0F?\s*)+/u);
    if (stars) {
      rawRating = (stars[0].match(/⭐/gu) || []).length;
      remainder = `${remainder.slice(0, stars.index)} ${remainder.slice(stars.index + stars[0].length)}`;
    }
  }

  const rating = rawRating === null || !Number.isFinite(rawRating)
    ? null
    : Math.max(0, Math.min(5, Math.trunc(rawRating)));
  const message = remainder
    .replace(/^\s*(?:[-–—,:;.!]+\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim() || null;

  return { rating, message };
}

module.exports = { parseFeedback };
