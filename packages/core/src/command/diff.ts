// Tiny diff utility: produce EntityDiff between two EntitySnapshot.data
// objects. Only handles flat object diffing (sufficient for Phase 1
// commands; richer paths added when nested fields appear).

import type { EntityDiff, EntityDiffOp, EntitySnapshot } from "./types.js";

export function diffSnapshots(before: EntitySnapshot, after: EntitySnapshot): EntityDiff {
  if (before.id !== after.id || before.kind !== after.kind) {
    throw new Error("diffSnapshots: kind/id mismatch");
  }
  const ops: EntityDiffOp[] = [];
  const keys = new Set([...Object.keys(before.data), ...Object.keys(after.data)]);
  for (const k of keys) {
    const a = before.data[k];
    const b = after.data[k];
    if (Object.is(a, b)) continue;
    if (b === undefined) ops.push({ op: "unset", path: k });
    else ops.push({ op: "set", path: k, value: b });
  }
  return { kind: after.kind, id: after.id, ops };
}
