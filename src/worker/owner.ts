// The owner's live queue (docs/STAGE-7.md): one Durable Object holding the tickets real sessions have
// asked, the owner's rules and facts. Calls on one object run one at a time, so a resolution and a
// re-route can't interleave. The logic is in live.ts; this only adapts the object's storage to it.

import { DurableObject } from "cloudflare:workers";
import { AskError, type KV, LiveQueue, type MirrorItem, type Resolution, type Ticket } from "./live";
// A cycle (index.ts re-exports this class), safe because routeMirrorTicket is only called at run time.
import { routeMirrorTicket } from "./index";
import type { Env } from "./model";
import type { Card, Decision, Fact, Rule } from "../shared/types";
import type { Brief, BriefEdits, Catalog, Launch, Report, StoredWalk } from "../shared/dispatch";

export class OwnerQueue extends DurableObject {
  private q(): LiveQueue {
    const s = this.ctx.storage;
    const kv: KV = {
      get: (k) => s.get(k),
      put: (k, v) => s.put(k, v),
      list: (prefix) => s.list({ prefix }),
    };
    return new LiveQueue(kv);
  }

  async context(): Promise<{ rules: Rule[]; facts: Fact[]; rev: number }> {
    return this.q().context();
  }

  async setContext(rules: Rule[], facts: Fact[]): Promise<void> {
    return this.q().setContext(rules, facts);
  }

  /** One call, so no other request can change the rules between the save and the read. */
  async snapshot(rules?: Rule[], facts?: Fact[]): Promise<{ rules: Rule[]; facts: Fact[]; rev: number }> {
    return this.q().snapshot(rules, facts);
  }

  async recentlyAnswered(): Promise<Ticket[]> {
    return this.q().recentlyAnswered();
  }

  async ticket(id: string): Promise<Ticket | undefined> {
    return this.q().get(id);
  }

  async shown(): Promise<Ticket[]> {
    return this.q().shown();
  }

  async add(decision: Decision, card: Card, instruction: string, rev: number, unrouted?: string, projectName?: string, brief?: string): Promise<Ticket> {
    return this.q().add(decision, card, instruction, rev, new Date(), unrouted, projectName, brief);
  }

  // Dispatch (docs/STAGE-8.md): the catalog and the briefs.
  async catalog(): Promise<Catalog> {
    return this.q().catalog();
  }

  async setCatalog(c: Catalog): Promise<void> {
    return this.q().setCatalog(c);
  }

  async brief(id: string): Promise<Brief | undefined> {
    return this.q().brief(id);
  }

  async briefs(): Promise<Brief[]> {
    return this.q().briefs();
  }

  async addBrief(b: Brief): Promise<void> {
    return this.q().addBrief(b);
  }

  async dispatched(id: string, edits: BriefEdits): Promise<Brief | undefined> {
    return this.q().dispatched(id, edits);
  }

  async launch(id: string, l: Launch): Promise<{ brief: Brief; ok: boolean } | undefined> {
    return this.q().launch(id, l);
  }

  async walk(id: string, w: StoredWalk): Promise<Brief | undefined> {
    return this.q().walk(id, w);
  }

  async report(id: string, r: Report): Promise<Brief | undefined> {
    return this.q().report(id, r);
  }

  async reroute(id: string, card: Card, instruction: string, rev: number): Promise<Ticket | undefined> {
    return this.q().reroute(id, card, instruction, rev);
  }

  // Mirrors (docs/STAGE-10.md, 10d). The hook's request is answered as soon as the mirror is stored;
  // routing runs afterwards from the alarm, which (unlike a request's waitUntil) may run for minutes.
  async mirrorOpen(items: MirrorItem[]): Promise<string[]> {
    const ids = await this.q().mirrorOpen(items);
    await this.schedule();
    return ids;
  }

  async mirrorAnswer(items: MirrorItem[]): Promise<string[]> {
    const ids = await this.q().mirrorAnswer(items);
    await this.schedule();
    return ids;
  }

  async mirrorEnd(session: string, why: string, at: number): Promise<number> {
    return this.q().mirrorEnd(session, why, at);
  }

  async mirrorRouted(id: string, card: Card, unrouted?: string): Promise<Ticket | undefined> {
    return this.q().mirrorRouted(id, card, unrouted);
  }

  async recentMirrors(): Promise<Ticket[]> {
    return this.q().recentMirrors();
  }

  /** Route now if anything waits for it, else wake when the next waiting mirror would become an orphan. */
  private async schedule(): Promise<void> {
    const q = this.q();
    if ((await q.unroutedMirrors()).length) return this.ctx.storage.setAlarm(Date.now());
    const next = await q.sweepMirrors();
    if (next) await this.ctx.storage.setAlarm(next);
  }

  /**
   * Route every mirror that hasn't been, side by side (on the runner, its own limit on model calls
   * queues them). Other requests run while the model calls are out, so an answer can arrive meanwhile;
   * mirrorRouted keeps it. A failure is routed as "couldn't route", never retried forever.
   */
  async alarm(): Promise<void> {
    const q = this.q();
    const [snap, shown] = [await q.snapshot(), await q.shown()];
    await Promise.all(
      (await q.unroutedMirrors()).map(async (t) => {
        const r = await routeMirrorTicket(this.env as Env, t, snap, shown);
        await q.mirrorRouted(t.decision.id, r.card, r.unrouted);
      }),
    );
    await this.schedule();
  }

  /** A refusal (an unknown ticket, a follow-up whose answer changed) comes back as a value: an error's class doesn't survive the RPC. */
  async resolve(id: string, r: Resolution): Promise<{ ticket: Ticket } | { refused: string }> {
    try {
      return { ticket: await this.q().resolve(id, r) };
    } catch (e) {
      if (e instanceof AskError) return { refused: e.message };
      throw e;
    }
  }
}
