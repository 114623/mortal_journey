import { Character } from "../role_core/Character";
import { Npc } from "../role_core/Npc";

function favorabilityLabel(f: number): string {
  if (f >= 80) return "生死之交";
  if (f >= 60) return "亲密无间";
  if (f >= 40) return "亲密";
  if (f >= 20) return "朋友";
  if (f >= -19) return "普通";
  if (f >= -39) return "疏离";
  if (f >= -59) return "厌恶";
  if (f >= -79) return "仇视";
  return "不死不休";
}

export function buildNpcListEntryPayload(npc: Npc): {
  title: string;
  subtitle: string;
  hpPct: number;
  mpPct: number;
  isDead: boolean;
  favorability: number;
  favorLabel: string;
} {
  return {
    title: npc.displayName,
    subtitle: `${npc.identity} · ${Character.formatRealm(npc.realm)}`,
    hpPct: npc.maxHp > 0 ? Math.round((npc.currentHp / npc.maxHp) * 100) : 0,
    mpPct: npc.maxMp > 0 ? Math.round((npc.currentMp / npc.maxMp) * 100) : 0,
    isDead: npc.isDead,
    favorability: npc.favorability,
    favorLabel: favorabilityLabel(npc.favorability),
  };
}
