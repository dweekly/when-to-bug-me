// DOM helpers: h() builds an element (model text always goes in as text, never as HTML), $() looks
// one up by id, and announce() speaks a status line to screen readers.

export type Child = Node | string | null | undefined | false;
export function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
export const $ = (id: string) => document.getElementById(id)!;
export function announce(text: string): void {
  $("announce").textContent = text;
}
