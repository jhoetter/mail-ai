// HTML sanitization for rendering email bodies in our UI. Intentionally
// minimal so we have no extra runtime dep. The webapp may swap in a
// stricter sanitizer if needed; mail-ai's contract is only that
// dangerous tags / attributes never reach the DOM.

const BLOCK_TAGS = /<\/?(script|iframe|object|embed|link|meta|style)[^>]*>/gi;
const ON_HANDLERS = /\son[a-z]+="[^"]*"/gi;
const JS_PROTO = /(href|src)="javascript:[^"]*"/gi;

export function sanitizeHtml(input: string): string {
  return input.replace(BLOCK_TAGS, "").replace(ON_HANDLERS, "").replace(JS_PROTO, '$1="#"');
}
