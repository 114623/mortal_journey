/**
 * 命运抉择确认后：同步写入主角、请求开局剧情 AI、维护剧情正文与阶段状态。
 *
 * 全部持久化剧情状态存放在 {@link storyStore} 模块单例（与世界地图/NPC 单例对齐），
 * 本 composable 只负责「开局 AI 流程」并把结果写入 storyStore。`errorMessage` 为
 * 非持久化的 UI 状态，留在本地。
 *
 * 读档会话下（`storyStore.restored === true`）本 composable 既不清空状态也不重跑 AI。
 */

import { ref, watch, type ComputedRef, type Ref } from "vue";
import { generateInitStory } from "./init_story_generate";
import { generateInitState } from "./init_state_generate";
import type { ActionSuggestions } from "./state_generate";
import { gameLog } from "../log/gameLog";
import {
  cloneWorldTime,
  createDefaultWorldTime,
  type WorldTime,
} from "../role_core/worldTime";
import { Protagonist, protagonist } from "../role_core/Protagonist";
import { npcStore } from "../role_core/npcStore";
import { worldMapStore } from "../role_core/worldMapStore";
import { storyStore } from "../role_core/storyStore";
import { writeActiveSave, hasActiveSave } from "../save/gameSave";
import { autoGeneratePortraits } from "../image_generate";
import type { FateChoiceResult } from "../fate_choice/types";
import type { WorldLocation } from "../role_core/types/worldLocation";
import { isEmptyWorldLocation } from "../role_core/types/worldLocation";

export type OpeningStoryPhase = "idle" | "loading" | "ready" | "error" | "ended";

/** 与启动页 API 表单对应的网关参数（空串表示未填）。 */
export interface OpeningStoryApiSlice {
  apiUrl: string;
  apiKey: string;
  apiModel: string;
}

/**
 * 监听 `fateChoice`：非空时 `Protagonist.loadFromFateChoice` 并拉取开局剧情；空时清空主角与剧情 UI。
 *
 * 读档会话下（`storyStore.restored`）直接返回——状态已由 `restoreSave` 灌满。
 *
 * @param fateChoice - 通常 `toRef(props, "fateChoice")`
 * @param api - 通常 `computed(() => ({ apiUrl, apiKey, apiModel }))`，在发起请求时读取最新值
 */
export function useOpeningStoryFromFateChoice(
  fateChoice: Ref<FateChoiceResult | null | undefined>,
  api: Ref<OpeningStoryApiSlice> | ComputedRef<OpeningStoryApiSlice>,
): {
  storyBody: Ref<string>;
  phase: Ref<OpeningStoryPhase>;
  errorMessage: Ref<string>;
  worldTime: Ref<WorldTime>;
  worldTimeBaseline: Ref<WorldTime>;
  worldLocation: Ref<WorldLocation | null>;
  initSnapshot: Ref<string>;
  initActionOptions: Ref<ActionSuggestions | null>;
} {
  const errorMessage = ref("");

  let abortCtl: AbortController | null = null;

  function resetWorldClock(): void {
    const w = createDefaultWorldTime();
    storyStore.worldTime.value = w;
    storyStore.worldTimeBaseline.value = cloneWorldTime(w);
    storyStore.worldLocation.value = null;
    storyStore.initSnapshot.value = "";
    storyStore.actionOptions.value = null;
  }

  function resetStoryOnly(): void {
    storyStore.storyBody.value = "";
    errorMessage.value = "";
    storyStore.phase.value = "idle";
    storyStore.chatMessages.value = [];
    resetWorldClock();
  }

  /** 开局状态完成后：把开局正文灌入 chatMessages[0]（携带开局快照）。 */
  function seedOpeningChatMessage(): void {
    const body = storyStore.storyBody.value.trim();
    if (!body) return;
    if (storyStore.chatMessages.value.length > 0) return;
    storyStore.chatMessages.value.push({
      type: "story",
      content: body,
      snapshot: storyStore.initSnapshot.value.trim() || undefined,
    });
  }

  watch(
    fateChoice,
    async (fc) => {
      abortCtl?.abort();
      abortCtl = null;

      // 读档会话：storyStore 已由 restoreSave 灌满，既不清空也不重跑 AI。
      if (storyStore.restored.value) return;

      if (!fc) {
        // 有活动存档时不清主角：读档会话若因某步异常没走到 restoreStory（restored 未置位），
        // 走到这里会把刚恢复的主角清空，主界面只剩占位文案。宁可不清，也不要清掉存档数据。
        if (!hasActiveSave()) {
          Protagonist.clear();
          resetStoryOnly();
        } else {
          gameLog.warn("[OpeningStory] 无命运抉择数据但存在活动存档，跳过清空主角（读档会话？）");
        }
        return;
      }

      Protagonist.loadFromFateChoice(fc);
      storyStore.storyBody.value = "";
      errorMessage.value = "";
      storyStore.chatMessages.value = [];
      resetWorldClock();

      const { apiUrl, apiKey, apiModel } = api.value;
      const url = String(apiUrl || "").trim();
      const model = String(apiModel || "").trim();
      if (!url || !model) {
        storyStore.phase.value = "error";
        errorMessage.value = "未配置 API URL 或模型，无法生成开局剧情。";
        gameLog.warn("[OpeningStory] " + errorMessage.value);
        return;
      }

      const p = protagonist.value;
      if (!p) {
        storyStore.phase.value = "error";
        errorMessage.value = "主角数据未就绪。";
        return;
      }

      const ac = new AbortController();
      abortCtl = ac;
      storyStore.phase.value = "loading";

      try {
        const storyResult = await generateInitStory({
          apiUrl: url,
          apiKey: String(apiKey || "").trim() || undefined,
          model,
          protagonist: p,
          signal: ac.signal,
        });
        if (abortCtl !== ac) return;

        if (!storyResult.storyBody.trim()) {
          storyStore.phase.value = "error";
          errorMessage.value = "模型返回的开局正文为空。";
          return;
        }

        storyStore.storyBody.value = storyResult.storyBody;

        try {
          const stateResult = await generateInitState({
            apiUrl: url,
            apiKey: String(apiKey || "").trim() || undefined,
            model,
            storyBody: storyResult.storyBody,
            protagonist: p,
            signal: ac.signal,
          });
          if (abortCtl !== ac) return;

          if (stateResult.worldLocation && !isEmptyWorldLocation(stateResult.worldLocation)) {
            storyStore.worldLocation.value = stateResult.worldLocation;
          }

          if (stateResult.storySnapshot.trim()) {
            storyStore.initSnapshot.value = stateResult.storySnapshot.trim();
          }

          if (stateResult.actionOptions) {
            storyStore.actionOptions.value = stateResult.actionOptions;
          }

          const current = protagonist.value;
          if (current) {
            current.applyInitState(stateResult);
          }
          if (stateResult.nearbyNpcs.length > 0) {
            const createdNpcs = npcStore.applyNpcUpdates(stateResult.nearbyNpcs, p.linggen, {
              currentLocation: stateResult.worldLocation ?? null,
              currentWorldTime: storyStore.worldTime.value,
            });
            autoGeneratePortraits(createdNpcs);
          }

          if (stateResult.worldLocation && !isEmptyWorldLocation(stateResult.worldLocation)) {
            worldMapStore.addLocation(stateResult.worldLocation);
          }
        } catch (stateErr) {
          gameLog.error("[OpeningStory] 状态生成失败：" + (stateErr instanceof Error ? stateErr.message : String(stateErr)));
        }

        // 无论开局状态生成成功与否，统一结算天赋效果（物品/灵石/属性）：
        // 成功时叠加在 applyInitState 之上；失败时也保住天赋物品与属性加成。
        const traitsOwner = protagonist.value;
        if (traitsOwner) {
          traitsOwner.applyTraitEffects();
        }

        seedOpeningChatMessage();
        storyStore.phase.value = "ready";
        // 开局完成：把完整初始状态写入当前活动存档（覆盖命运抉择时的占位载荷）。
        writeActiveSave();
      } catch (e) {
        if (ac.signal.aborted) return;
        storyStore.phase.value = "error";
        errorMessage.value = e instanceof Error ? e.message : String(e);
        gameLog.error("[OpeningStory] " + errorMessage.value);
      } finally {
        if (abortCtl === ac) abortCtl = null;
      }
    },
    { immediate: true },
  );

  return {
    storyBody: storyStore.storyBody,
    phase: storyStore.phase,
    errorMessage,
    worldTime: storyStore.worldTime,
    worldTimeBaseline: storyStore.worldTimeBaseline,
    worldLocation: storyStore.worldLocation,
    initSnapshot: storyStore.initSnapshot,
    initActionOptions: storyStore.actionOptions,
  };
}
