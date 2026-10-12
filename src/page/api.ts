// Calls to the Worker. A live call that needs a session first shows a Turnstile check and trades
// its token for a session token, which every later call carries.

import { h } from "./dom";
import { OWNER_PAGE } from "./livemode";
import { Q } from "./state";

/** The session token that lets this visit make live calls, once a Turnstile check has passed. */
let session: string | null = null;
let sessionPending: Promise<string | null> | null = null;

export async function api<T>(path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers["x-bugme-session"] = session;
  // On the owner's page every call is about the live queue (docs/STAGE-7.md): /api/X becomes /api/me/X.
  const url = OWNER_PAGE && !path.startsWith("/api/me/") ? path.replace(/^\/api\//, "/api/me/") : path;
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers, body: JSON.stringify(body) });
  const data = (await res.json()) as { error?: string; unavailable?: boolean; needs_session?: boolean };
  if (res.status === 401 && data.needs_session && !retried) {
    session = await (sessionPending ??= humanCheck().finally(() => (sessionPending = null)));
    if (session) return api<T>(path, body, true);
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { unavailable: Boolean(data.unavailable || data.needs_session) });
  return data as T;
}

/**
 * Show a Turnstile check in a small dialog and trade its token for a session. Resolves null if the
 * check cannot run (no site key, script blocked) or the visitor closes it.
 */
export function humanCheck(): Promise<string | null> {
  const siteKey = Q?.turnstile_site_key;
  if (!siteKey) return Promise.resolve(null);
  return new Promise((resolve) => {
    const box = h("div", { class: "ts-box" });
    const close = h("button", { type: "button", class: "ghost" }, "Not now");
    const dlg = h(
      "dialog",
      { class: "ts", "aria-labelledby": "ts-h" },
      h("h2", { id: "ts-h" }, "One quick check before live calls"),
      h("p", {}, "Live Claude calls cost real money, so the first one needs a check that you're a person. Recorded answers never do."),
      box,
      close,
    ) as HTMLDialogElement;
    document.body.append(dlg);
    const finish = (v: string | null) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    close.addEventListener("click", () => finish(null));
    dlg.showModal();
    const W = window as unknown as { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => void } };
    const render = () =>
      W.turnstile!.render(box, {
        sitekey: siteKey,
        callback: async (token: string) => {
          try {
            const r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
            const d = (await r.json()) as { session?: string };
            finish(r.ok && d.session ? d.session : null);
          } catch {
            finish(null);
          }
        },
        "error-callback": () => finish(null),
      });
    if (W.turnstile) render();
    else {
      const sc = document.createElement("script");
      sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      sc.async = true;
      sc.onload = render;
      sc.onerror = () => finish(null);
      document.head.append(sc);
    }
  });
}
