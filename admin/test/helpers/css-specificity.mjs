/** A comparable specificity for plain selectors; complex selectors are refused instead of guessed. */
export function specificity(selector) {
  if (/:(?:is|not|where|has)\(|::/.test(selector)) throw new Error(`specificity: not a plain selector: ${selector}`);
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  const types = (selector.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}
