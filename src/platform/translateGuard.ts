// ============================================================
// TRANSLATE GUARD — keep page translation from crashing React.
//
// Chrome's built-in translator (and some extensions) wrap the text
// nodes React rendered in <font> tags. When React later removes or
// moves one of those nodes it calls removeChild/insertBefore on the
// parent it remembers, the node is no longer that parent's child, and
// the DOM throws "NotFoundError: Failed to execute 'removeChild' on
// 'Node'". That takes the whole app down at the top-level boundary.
//
// Seen on prod: a new player arriving on an invite link crashed twice
// this way (client_crashes, scope App, 2026-10-02). Orbital has players
// reading it in other languages, so turning translation off would
// trade a crash for an unreadable game.
//
// The fix is the one React's maintainers suggest (facebook/react#11538):
// when the node is not actually a child, do nothing instead of throwing.
// The node has already been moved by the translator; React's own tree
// stays correct and re-renders the text on the next update.
// ============================================================

let installed = false;

export function installTranslateGuard(): void {
  if (installed || typeof Node !== 'function' || !Node.prototype) return;
  installed = true;

  const removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function guardedRemoveChild<T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child) as T;
  };

  const insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function guardedInsertBefore<T extends Node>(
    this: Node, node: T, ref: Node | null,
  ): T {
    if (ref && ref.parentNode !== this) return node;
    return insertBefore.call(this, node, ref) as T;
  };
}
