// JWZ threading. Pure data → data: takes a list of message-id +
// references and returns a forest of threads. Used by overlay-db for
// idempotent thread reconstruction across folders/labels.
//
// References:
//   https://www.jwz.org/doc/threading.html
//
// We implement the canonical JWZ algorithm (steps 1-6) without
// step 5 (subject-based merging) by default — subject merging is
// configurable because Gmail-style label duplication already produces
// strong reference chains.

export interface ThreadingInputMessage {
  readonly messageId: string;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly subject?: string;
  readonly date?: Date;
}

export interface ThreadNode {
  messageId: string | null; // null = ghost container
  message?: ThreadingInputMessage;
  parent: ThreadNode | null;
  children: ThreadNode[];
}

interface IdTable {
  [id: string]: ThreadNode;
}

function getOrCreate(table: IdTable, id: string): ThreadNode {
  let n = table[id];
  if (!n) {
    n = { messageId: id, parent: null, children: [] };
    table[id] = n;
  }
  return n;
}

function isAncestor(maybeAncestor: ThreadNode, node: ThreadNode): boolean {
  let cur: ThreadNode | null = maybeAncestor;
  while (cur) {
    if (cur === node) return true;
    cur = cur.parent;
  }
  return false;
}

function unlink(node: ThreadNode) {
  if (!node.parent) return;
  const idx = node.parent.children.indexOf(node);
  if (idx >= 0) node.parent.children.splice(idx, 1);
  node.parent = null;
}

function link(parent: ThreadNode, child: ThreadNode) {
  if (child.parent === parent) return;
  unlink(child);
  if (isAncestor(child, parent)) return; // would create cycle
  child.parent = parent;
  parent.children.push(child);
}

export function thread(messages: readonly ThreadingInputMessage[]): ThreadNode[] {
  const table: IdTable = {};
  // 1. Index every message and link References chain.
  for (const m of messages) {
    const node = getOrCreate(table, m.messageId);
    node.message = m;
    const refs = m.references.length ? m.references : m.inReplyTo;
    let prev: ThreadNode | null = null;
    for (const ref of refs) {
      const refNode = getOrCreate(table, ref);
      if (prev && !refNode.parent && !isAncestor(refNode, prev)) {
        link(prev, refNode);
      }
      prev = refNode;
    }
    if (prev && !isAncestor(node, prev)) link(prev, node);
  }
  // 2. Find roots.
  const roots: ThreadNode[] = [];
  for (const id of Object.keys(table)) {
    const node = table[id]!;
    if (!node.parent) roots.push(node);
  }
  // 3. Prune empty containers (ghosts) with no children.
  function prune(node: ThreadNode): ThreadNode[] {
    const newChildren: ThreadNode[] = [];
    for (const c of node.children) {
      const result = prune(c);
      newChildren.push(...result);
    }
    node.children = newChildren;
    for (const c of newChildren) c.parent = node;
    if (!node.message && newChildren.length === 0) return [];
    if (!node.message && newChildren.length === 1) {
      const only = newChildren[0]!;
      only.parent = node.parent;
      return [only];
    }
    return [node];
  }
  const pruned: ThreadNode[] = [];
  for (const r of roots) pruned.push(...prune(r));
  return pruned;
}
