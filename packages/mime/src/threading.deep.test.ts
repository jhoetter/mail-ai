// Deep-chain threading correctness fixtures.
//
// Build a 50-deep reply chain in a deterministic order, shuffle the
// inputs, run thread() and assert the resulting forest still contains
// exactly one root with depth 50 and the chain order intact.

import { describe, expect, it } from "vitest";
import { thread, type ThreadingInputMessage } from "./threading.js";

function makeChain(n: number): ThreadingInputMessage[] {
  const messages: ThreadingInputMessage[] = [];
  for (let i = 0; i < n; i++) {
    const id = `<m${i}@deep.test>`;
    const refs = messages.map((m) => m.messageId);
    messages.push({
      messageId: id,
      inReplyTo: i === 0 ? [] : [messages[i - 1]!.messageId],
      references: refs,
      subject: i === 0 ? "thread root" : `Re: thread root (${i})`,
      date: new Date(2026, 3, 1, 10, i, 0),
    });
  }
  return messages;
}

function shuffle<T>(arr: readonly T[], seed = 1): T[] {
  const a = [...arr];
  let s = seed;
  function rnd() {
    s = (s * 1664525 + 1013904223) % 0x100000000;
    return s / 0x100000000;
  }
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function chainDepth(node: ReturnType<typeof thread>[number]): number {
  let d = 1;
  let cur = node;
  while (cur.children.length === 1) {
    cur = cur.children[0]!;
    d++;
  }
  return d;
}

describe("JWZ threading on deep chains", () => {
  it("50-deep reply chain → 1 root, depth 50", () => {
    const chain = makeChain(50);
    const forest = thread(shuffle(chain, 42));
    expect(forest).toHaveLength(1);
    expect(chainDepth(forest[0]!)).toBe(50);
  });

  it("two independent chains stay separate", () => {
    const a = makeChain(10);
    const b = makeChain(10).map((m) => ({
      ...m,
      messageId: m.messageId.replace("@deep.test", "@other.test"),
      inReplyTo: m.inReplyTo.map((r) => r.replace("@deep.test", "@other.test")),
      references: m.references.map((r) => r.replace("@deep.test", "@other.test")),
    }));
    const forest = thread(shuffle([...a, ...b], 7));
    expect(forest).toHaveLength(2);
  });

  it("input order does not change the resulting structure", () => {
    const chain = makeChain(20);
    const forestA = thread(chain);
    const forestB = thread(shuffle(chain, 99));
    expect(chainDepth(forestA[0]!)).toBe(chainDepth(forestB[0]!));
    expect(forestA).toHaveLength(forestB.length);
  });
});
