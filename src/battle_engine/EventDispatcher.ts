import type { BattleEvent, EventHandler, EventContext } from "./types";

export class EventDispatcher {
  private handlers = new Map<BattleEvent, EventHandler[]>();

  on(event: BattleEvent, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: BattleEvent, handler: EventHandler): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  emit(event: BattleEvent, ctx: EventContext): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const handler of list) {
      handler(ctx);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
