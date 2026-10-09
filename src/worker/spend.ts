// The daily spend counter: one Durable Object instance for the whole deployment, so every live call
// everywhere passes through a single, serialized ledger. A call reserves a worst-case charge before
// it is made and reconciles to the actual charge afterwards; a call that fails keeps its reservation,
// because a failed request may still have been billed. Days are UTC.

import { DurableObject } from "cloudflare:workers";
import { DAILY_SPEND_CAP_USD } from "../shared/constants";

export interface SpendState {
  day: string;
  spent: number;
  cap: number;
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export class SpendCounter extends DurableObject {
  private async read(): Promise<SpendState> {
    const day = utcDay();
    const spent = ((await this.ctx.storage.get<number>(`spent:${day}`)) ?? 0) as number;
    return { day, spent, cap: DAILY_SPEND_CAP_USD };
  }

  /** Reserve `amount` dollars if it fits under today's cap. Calls on one object run one at a time. */
  async reserve(amount: number): Promise<{ ok: boolean; state: SpendState }> {
    const s = await this.read();
    if (s.spent + amount > s.cap) return { ok: false, state: s };
    s.spent += amount;
    await this.ctx.storage.put(`spent:${s.day}`, s.spent);
    return { ok: true, state: s };
  }

  /** Replace a reservation with the actual charge, once the response's usage is known. */
  async reconcile(reserved: number, actual: number): Promise<SpendState> {
    const s = await this.read();
    s.spent = Math.max(0, s.spent - reserved + actual);
    await this.ctx.storage.put(`spent:${s.day}`, s.spent);
    return s;
  }

  async state(): Promise<SpendState> {
    return this.read();
  }
}
