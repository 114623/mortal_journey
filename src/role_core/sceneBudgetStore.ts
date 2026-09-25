/**
 * @fileoverview 场景配额与场景进度（防「打完一波又来一波」的无限刷波）。
 *
 * 解决的问题：秘境、擂台赛这类场景，AI 容易口胡出没完没了的新敌人、新一层、下一轮。
 *
 * 设计要点（第二版，相比第一版的「只靠 AI 自报层数」有三处关键修正）：
 *
 *  1. **主轴是程序侧的回合预算，不是 AI 自报的层数。**
 *     AI 报的 stage 只用来「加速」；真正的推进由程序按「每层/每轮允许几个回合」
 *     （`turnsPerStage`）累加。AI 赖在第 1 层不报进度也没用——回合数到了程序自己往下推，
 *     推到最后一层并写满配额回合后必然触顶。这是「AI 不报数也能拦住」的根本保障。
 *
 *  2. **触顶后进入「收束锁」，且逐级加压，直到 AI 真的收掉。**
 *     第一版只在触顶那一回合给一次指令，AI 不听就白搭。现在触顶后每回合都注入收束指令，
 *     且第 2 回合起加压（要求一句话转场，禁止任何新内容）；万一三回合还没收掉，程序强制
 *     清零进度避免死锁。
 *
 *  3. **收束锁期间程序直接吃掉战斗触发。**
 *     光靠提示词"不许再打"是靠不住的——收束锁生效时 `BATTLE_TRIGGER_TAG` 会被程序丢弃，
 *     AI 想再开一场也开不起来，只能写收尾。这是真正的硬闸。
 *
 * 配额持久化到 localStorage（跨存档生效）；场景进度只在会话内维护（读档即重置）。
 */

import { ref } from "vue";

const SETTINGS_KEY = "MJ_SCENE_BUDGET_V2";

/** 场景配额设置。 */
export interface SceneBudgetSettings {
  /** 秘境层数上限（如 3 = 该秘境最多三层）。 */
  secretRealmLayers: number;
  /** 擂台赛 / 大比轮次上限。 */
  arenaRounds: number;
  /** 每层 / 每轮允许写几个回合。层/轮上限 × 此值 = 该场景的总回合预算。 */
  turnsPerStage: number;
  /** 同一场景内允许的战斗总数上限（防止一回合内连打、或一层里刷出多场）。 */
  battleWavesPerScene: number;
}

export const SCENE_BUDGET_DEFAULT: SceneBudgetSettings = {
  secretRealmLayers: 3,
  arenaRounds: 3,
  turnsPerStage: 2,
  battleWavesPerScene: 3,
};

/** 各配额的允许区间（防止玩家填出 0 或 999 这种破坏体验的值）。 */
export const SCENE_BUDGET_MIN: Record<keyof SceneBudgetSettings, number> = {
  secretRealmLayers: 1,
  arenaRounds: 1,
  turnsPerStage: 1,
  battleWavesPerScene: 1,
};
export const SCENE_BUDGET_MAX: Record<keyof SceneBudgetSettings, number> = {
  secretRealmLayers: 9,
  arenaRounds: 9,
  turnsPerStage: 5,
  battleWavesPerScene: 9,
};

/**
 * 收束锁的宽限回合数。
 *
 * 触顶后给 AI 这么多回合把场景收掉；超过仍未收束（AI 既不报 ended 也不离场）
 * 则程序强制清零进度，避免一个场景永久卡住。
 */
const SCENE_CLOSING_GRACE_TURNS = 3;

/** 场景类型：只有这两类有明确的「层 / 轮」结构；其余场景靠战斗波次兜底。 */
export type SceneKind = "秘境" | "擂台" | "无";

/** 状态 AI 每回合报告的场景进度（对应 <MJ_SCENE_TAG>）。 */
export interface SceneReport {
  kind: SceneKind;
  /** 场景专名，如「血色禁地」「宗门大比」；无则空串。 */
  name: string;
  /** 当前层 / 轮，从 1 起。 */
  stage: number;
  /** 本次场景计划的总层 / 轮（不得超过对应配额）。 */
  total: number;
  /** 本场景是否已收束离场；true 时程序清空进度。 */
  ended: boolean;
}

/** 程序侧维护的场景进度（合并 AI 报告与程序计数）。 */
export interface SceneProgress {
  kind: SceneKind;
  name: string;
  stage: number;
  total: number;
  /** 当前层 / 轮内已经过的回合数（写满 turnsPerStage 即推进到下一层）。 */
  turnsInStage: number;
  /** 本场景累计回合数（展示与诊断用）。 */
  turns: number;
  /** 本场景内已发生的战斗次数（程序计数，不依赖 AI）。 */
  battles: number;
  /** 是否已进入收束锁：触顶后每回合强制收尾，并拦截战斗触发。 */
  closing: boolean;
  /** 收束锁已持续的回合数。 */
  closingTurns: number;
  /**
   * 场景锚点（地点串）。
   *
   * 只有程序兜底的场景（kind="无"）用它判断「是否还是同一个场景」——
   * 主角换了个地方，战斗计数就从头算，避免把沿途两场偶遇算成同一场景刷波。
   */
  locationKey: string;
}

function clampField(k: keyof SceneBudgetSettings, v: number): number {
  if (!Number.isFinite(v)) return SCENE_BUDGET_DEFAULT[k];
  const n = Math.round(v);
  return Math.min(SCENE_BUDGET_MAX[k], Math.max(SCENE_BUDGET_MIN[k], n));
}

function readStored(): SceneBudgetSettings {
  const fallback = { ...SCENE_BUDGET_DEFAULT };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const o = JSON.parse(raw) as Partial<SceneBudgetSettings>;
    return {
      secretRealmLayers: clampField("secretRealmLayers", Number(o.secretRealmLayers)),
      arenaRounds: clampField("arenaRounds", Number(o.arenaRounds)),
      turnsPerStage: clampField("turnsPerStage", Number(o.turnsPerStage)),
      battleWavesPerScene: clampField("battleWavesPerScene", Number(o.battleWavesPerScene)),
    };
  } catch {
    return fallback;
  }
}

/** 当前场景配额（可在「设置」里改，持久化到本机）。 */
export const sceneBudget = ref<SceneBudgetSettings>(readStored());

/** 当前场景进度；null = 不在秘境/擂台这类分层场景中。 */
export const sceneProgress = ref<SceneProgress | null>(null);

/** 修改配额（部分字段），夹取后落盘。 */
export function setSceneBudget(patch: Partial<SceneBudgetSettings>): void {
  const next = { ...sceneBudget.value };
  for (const key of Object.keys(SCENE_BUDGET_DEFAULT) as (keyof SceneBudgetSettings)[]) {
    const v = patch[key];
    if (typeof v === "number") next[key] = clampField(key, v);
  }
  sceneBudget.value = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 配额不足时仅本次会话生效 */
  }
}

/** 恢复默认配额。 */
export function resetSceneBudget(): void {
  sceneBudget.value = { ...SCENE_BUDGET_DEFAULT };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sceneBudget.value));
  } catch {
    /* ignore */
  }
}

/** 清空场景进度（开新人生 / 读档 / 场景已收束时调用）。 */
export function resetSceneProgress(): void {
  sceneProgress.value = null;
}

/** 当前场景的层/轮上限：秘境与擂台各有配额，其余场景无层/轮概念。 */
export function stageCapOf(kind: SceneKind): number {
  if (kind === "秘境") return sceneBudget.value.secretRealmLayers;
  if (kind === "擂台") return sceneBudget.value.arenaRounds;
  return 0;
}

/**
 * 合并状态 AI 的场景报告。
 *
 * AI 报的 stage 只用来「加速」推进（取 max、不倒退），total 一律夹到配额上限
 * （AI 不得自己把秘境写成十层）。真正的推进节奏由 {@link noteSceneTurn} 掌握。
 */
export function applySceneReport(report: SceneReport | null): void {
  if (!report) return;
  const name = (report.name || "").trim();
  const kind: SceneKind = report.kind === "秘境" || report.kind === "擂台" ? report.kind : "无";

  // 已不在分层场景中 → 清空进度。
  if (kind === "无") {
    sceneProgress.value = null;
    return;
  }

  // 场景收束离场：名字对得上（或任一方无名）才清空，避免误清另一个新开的场景。
  if (report.ended) {
    const cur = sceneProgress.value;
    if (!cur || !cur.name || !name || cur.name === name || cur.kind !== kind) {
      sceneProgress.value = null;
      return;
    }
  }

  const cap = stageCapOf(kind);
  const safeStage = Math.max(1, Math.min(cap, Math.floor(report.stage || 1)));
  const safeTotal = Math.max(1, Math.min(cap, Math.floor(report.total || cap)));

  const cur = sceneProgress.value;
  const isSameScene = cur && cur.kind === kind && (!name || !cur.name || cur.name === name);
  const prevStage = isSameScene ? cur!.stage : 0;
  const stage = isSameScene ? Math.max(cur!.stage, safeStage) : safeStage;

  sceneProgress.value = {
    kind,
    name: name || cur?.name || "",
    stage,
    total: Math.max(stage, safeTotal),
    // AI 主动推进了层/轮 → 本层的回合计数从零开始。
    turnsInStage: isSameScene ? (stage > prevStage ? 0 : cur!.turnsInStage) : 0,
    turns: isSameScene ? cur!.turns : 0,
    battles: isSameScene ? cur!.battles : 0,
    closing: isSameScene ? cur!.closing : false,
    closingTurns: isSameScene ? cur!.closingTurns : 0,
    locationKey: cur?.locationKey ?? "",
  };
}

/**
 * 登记一场已发生的战斗（战斗结果回写时调用）。
 *
 * AI 不报 `<MJ_SCENE_TAG>` 时也要能拦住刷波，所以这里会自建一条兜底进度：
 * 按「同一个地点内连续打了多少场」计数，换地点自动重新计。
 *
 * @param locationKey 当前地点串（如"天南-越国-七玄门"）；留空表示地点未知。
 */
export function noteBattleInScene(locationKey = ""): void {
  const key = locationKey.trim();
  const cur = sceneProgress.value;

  // 分层场景（秘境 / 擂台）：AI 自己在报进度，战斗计数照常累加即可。
  if (cur && cur.kind !== "无") {
    sceneProgress.value = { ...cur, battles: cur.battles + 1 };
    return;
  }

  // 程序兜底场景：换地点即视为新场景，从 1 重新计。
  if (!cur || (key && cur.locationKey && cur.locationKey !== key)) {
    sceneProgress.value = {
      kind: "无", name: "", stage: 1, total: 0,
      turnsInStage: 0, turns: 0, battles: 1,
      closing: false, closingTurns: 0, locationKey: key,
    };
    return;
  }
  sceneProgress.value = {
    ...cur,
    battles: cur.battles + 1,
    locationKey: key || cur.locationKey,
  };
}

/**
 * 登记本场景又过了一个回合（每回合剧情生成成功后调用，是推进节奏的真正来源）。
 *
 * - 本层 / 本轮写满 `turnsPerStage` 个回合 → 自动推进到下一层 / 下一轮；
 * - 已到最后一层且写满 → 进入收束锁；
 * - 战斗次数到上限 → 同样进入收束锁；
 * - 收束锁持续超过 {@link SCENE_CLOSING_GRACE_TURNS} 回合仍没收掉 → 强制清零防死锁。
 *
 * 【回合权重】配额要防的是「无限刷**非战斗**回合赖在秘境里」——
 * 战斗回合自带战损与消耗，本来就有成本，不该同价。所以调用方按
 * 战斗回合传 1、非战斗回合传 0.5（见 {@link noteSceneTurn} 的 weight 参数）。
 *
 * @param weight 本回合的权重（战斗回合 1，非战斗回合 0.5）。
 * @return `forceCleared` 为真表示本次触发了强制清零，**调用方应补一段转场**——
 *         否则玩家视角是「场景限制突然消失」，没有任何交代。
 *         `sceneName` / `locationName` 是清零前的快照，供转场文案使用。
 */
export function noteSceneTurn(weight: number = 1): {
  forceCleared: boolean;
  sceneName: string;
  locationName: string;
} {
  const cur = sceneProgress.value;
  if (!cur) return { forceCleared: false, sceneName: "", locationName: "" };
  const per = sceneBudget.value.turnsPerStage;
  const waves = sceneBudget.value.battleWavesPerScene;
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;

  const next: SceneProgress = {
    ...cur,
    turns: cur.turns + w,
    turnsInStage: cur.turnsInStage + w,
  };

  if (cur.kind === "无") {
    // 普通场景没有层/轮概念，只靠战斗次数触顶。
    if (next.battles >= waves) {
      next.closing = true;
      next.closingTurns += 1;
    }
  } else if (next.closing || next.battles >= waves) {
    // 已在收束锁中，或战斗波次用尽。
    next.closing = true;
    next.closingTurns += 1;
  } else if (next.stage >= next.total) {
    // 已在最后一层 / 最后一轮：写满配额回合即收束。
    if (next.turnsInStage >= per) {
      next.closing = true;
      next.closingTurns += 1;
    }
  } else if (next.turnsInStage >= per) {
    // 本层 / 本轮写满 → 推进到下一层 / 下一轮。
    next.stage = Math.min(next.total, next.stage + 1);
    next.turnsInStage = 0;
  }

  if (next.closingTurns > SCENE_CLOSING_GRACE_TURNS) {
    // 给了足够回合仍没收束 —— 判定场景已事实上结束，清零避免永久卡住。
    // 清零前先把名字快照出来返回给调用方：它要据此给玩家补一句转场，
    // 不然「场景限制突然消失」这件事在玩家侧毫无交代。
    sceneProgress.value = null;
    return {
      forceCleared: true,
      sceneName: cur.name || "",
      locationName: cur.locationKey || "",
    };
  }
  sceneProgress.value = next;
  return { forceCleared: false, sceneName: "", locationName: "" };
}

/** 场景是否触顶（层/轮用尽、战斗用尽，或已在收束锁中）。 */
export function isSceneExhausted(): boolean {
  const cur = sceneProgress.value;
  if (!cur) return false;
  if (cur.closing) return true;
  if (cur.kind !== "无" && cur.total > 0 && cur.stage >= cur.total && cur.turnsInStage >= sceneBudget.value.turnsPerStage) {
    return true;
  }
  return cur.battles >= sceneBudget.value.battleWavesPerScene;
}

/**
 * 是否处于收束锁中。
 *
 * 为真时程序会**直接丢弃**本回合的战斗触发标签——不是求 AI 别打，是让它打不起来，
 * 只能把场景收掉。这是整套配额里唯一一道 AI 无法绕过的硬闸。
 */
export function isSceneClosing(): boolean {
  return sceneProgress.value?.closing === true;
}

/**
 * 生成注入给 AI 的【场景配额】指令块；不在场景中返回空串。
 *
 * 分四档，越往后越强硬：
 *   - 常规：只给一句进度提示，让 AI 心里有数（不打扰叙事）；
 *   - 预警：进入最后一层 / 只剩一波，提醒本层（本波）写完就收；
 *   - 收束（第 1 回合）：必须收束，给出「写什么」的正向清单 + 禁令；
 *   - 收束（第 2 回合起）：加压——一句话转场，禁止任何新内容。
 */
export function buildSceneDirective(): string {
  const cur = sceneProgress.value;
  if (!cur) return "";
  const waves = sceneBudget.value.battleWavesPerScene;
  const per = sceneBudget.value.turnsPerStage;

  // ── 收束锁 ────────────────────────────────────────────────────────────────
  if (cur.closing) {
    const unit = cur.kind === "秘境" ? "层" : "轮";
    const where = cur.kind === "无"
      ? "当前地点"
      : `${cur.kind}「${cur.name || "未命名"}」第 ${cur.stage}/${cur.total} ${unit}`;
    const header =
      `【场景配额·收束令】${where}已到上限（已 ${cur.turns} 回合 / ${cur.battles} 场战斗）。` +
      `本回合必须把这个场景写完收掉，这是硬性要求，不是建议。`;
    const body = [
      `必须写到：①主角如何脱离该场景——离场、通关、被送出、中止、认负、被引走，任选一个写清楚；`,
      `②这场经历的收获与代价——伤势、损耗、所得物品或灵石、欠下或结下的人情、得到的信息，挑与本场景相关的写；`,
      `③一句话转场到下一个具体地点，或交待主角接下来的去向。`,
    ].join("\n");
    const ban = [
      `禁止：新的敌人 / 妖兽 / 挑战者登场；第 ${cur.stage + 1} ${unit}或"下一${unit}"；`,
      `"又一批""紧接着又扑上来""源源不断""还没完"这类接续写法；`,
      `在本场景里再开新谜题、新分支或未解答的新悬念（已有悬念可以给一个阶段性的了结或搁置，不要再加）。`,
    ].join("\n");

    if (cur.closingTurns >= 2) {
      return [
        header,
        `这是收束的最后机会：不要展开任何新的描写、新的对手或新的发现。`,
        `用最简短的篇幅完成「脱离 + 结算 + 转场」三件事，然后收笔。`,
        ban,
      ].join("\n");
    }
    return [header, body, ban].join("\n");
  }

  // ── 程序兜底场景（普通地点连打数场）────────────────────────────────────────
  if (cur.kind === "无") {
    if (cur.battles >= waves) return ""; // 下一回合 noteSceneTurn 会进收束锁
    if (cur.battles === waves - 1) {
      return [
        `【场景配额】当前地点已连打 ${cur.battles} 场（同场景战斗上限 ${waves}）。`,
        `本回合可以写完这一场，但收笔时必须把主角带离当前处境`,
        `（撤离、疗伤、清点、被人劝开、转场都可以），不要留下继续动手的钩子。`,
      ].join("\n");
    }
    return "";
  }

  // ── 分层场景：常规进度提示 / 预警 ──────────────────────────────────────────
  const unit = cur.kind === "秘境" ? "层" : "轮";
  const isLast = cur.stage >= cur.total;
  const header =
    `【场景进度】${cur.kind}「${cur.name || "未命名"}」第 ${cur.stage}/${cur.total} ${unit}` +
    `（本${unit}已 ${cur.turnsInStage}/${per} 回合，累计战斗 ${cur.battles}/${waves}）。`;

  if (isLast) {
    return [
      header,
      `这是最后${unit === "层" ? "一层" : "一轮"}：本回合写完就该收束了。`,
      `请把这一${unit}的高潮写足，并在收笔时把主角带离该场景（离场、通关、中止、转场），`,
      `顺带结清本场景的收获与代价。不要再开新的分支或新的敌人。`,
    ].join("\n");
  }

  if (cur.battles >= waves - 1 && waves > 1) {
    return [
      header,
      `本场景的战斗次数接近上限（${waves}）：后续的推进优先用探索、解谜、争夺、`,
      `遭遇对峙或关系交涉来写，不要每${unit}都靠打一场解决。`,
    ].join("\n");
  }

  // 常规回合只给一句轻量提示，不干扰叙事。
  return header;
}

/** 面板展示用的场景进度文案（如「秘境·血色禁地 2/3 层 · 收束中」）。 */
export function formatSceneProgress(): string {
  const cur = sceneProgress.value;
  if (!cur) return "";
  const waves = sceneBudget.value.battleWavesPerScene;
  const tail = cur.closing ? " · 收束中" : "";
  if (cur.kind === "无") return `当前地点 战斗 ${cur.battles}/${waves}${tail}`;
  const unit = cur.kind === "秘境" ? "层" : "轮";
  const name = cur.name ? `·${cur.name}` : "";
  // turnsInStage 可能是 0.5 的奇数倍（非战斗回合按半回合计），展示一律向上取整，
  // 免得 UI 上冒出「本层 2.5/3 回合」这种看着像 bug 的数字。
  return `${cur.kind}${name} ${cur.stage}/${cur.total} ${unit}` +
    `（本${unit} ${Math.ceil(cur.turnsInStage)}/${sceneBudget.value.turnsPerStage} 回合，战斗 ${cur.battles}/${waves}）${tail}`;
}

export const sceneBudgetStore = {
  sceneBudget,
  sceneProgress,
  setSceneBudget,
  resetSceneBudget,
  resetSceneProgress,
  applySceneReport,
  noteBattleInScene,
  noteSceneTurn,
  isSceneExhausted,
  isSceneClosing,
  buildSceneDirective,
  formatSceneProgress,
  stageCapOf,
};
