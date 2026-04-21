// Tag color validation. We store the hex string as-is in the DB; this
// helper keeps the surface symmetrical with status/assignment.

const HEX = /^#[0-9a-fA-F]{6}$/;
export function isValidTagColor(s: string): boolean {
  return HEX.test(s);
}
