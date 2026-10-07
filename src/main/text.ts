/** Non-empty text without control characters (tabs/newlines excluded) or U+FFFD. */
export function isPrintable(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return text.length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f�]/.test(text)
}
