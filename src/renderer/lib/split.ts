// Width for the pixel-sized panel of a splitter group whose sibling flexes to
// fill the remainder: half of the group minus the handle's own space, rounded
// to whole pixels and clamped to the panel's minimum. Equalizing then leaves
// the flexible sibling with the matching half.
export function equalSplitWidth(totalWidth: number, handleWidth: number, minWidth: number): number {
  return Math.max(minWidth, Math.round((totalWidth - handleWidth) / 2));
}
