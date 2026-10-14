// The owner's live queue (docs/STAGE-7.md): one Durable Object holding the tickets real sessions have
// asked, the owner's rules and facts. Calls on one object run one at a time, so a resolution and a
// re-route can't interleave. The logic is in live.ts; this only adapts the object's storage to it.

import { DurableObject } from "cloudflare:workers";
import { AskError, type KV, LiveQueue, type Resolution, type Ticket } from "./live";
import type { Card, Decision, Fact, Rule } from "../shared/types";
import type { Brief, BriefEdits, Catalog, Launch, Report } from "../shared/dispatch";

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

  async report(id: string, r: Report): Promise<Brief | undefined> {
    return this.q().report(id, r);
  }

  async reroute(id: string, card: Card, instruction: string, rev: number): Promise<Ticket | undefined> {
    return this.q().reroute(id, card, instruction, rev);
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
