# 战斗引擎功能文档

> 本文档介绍 `battle_engine/` 目录下战斗引擎支持的完整功能，便于后续扩展和对接外部系统。

## 目录结构

| 文件 | 职责 |
|---|---|
| `types.ts` | 所有类型定义（战斗者、技能、效果、状态、日志等） |
| `constants.ts` | 引擎常量（行动条上限、各行动消耗、基础暴击伤害等） |
| `formulas.ts` | 底层公式（防御减免、暴击/闪避判定、ID 生成） |
| `BattleEngine.ts` | 引擎核心：回合流程、行动执行、胜负判定、治疗/法力应用 |
| `DamagePipeline.ts` | 伤害结算管线：闪避→暴击→防御→修正→护盾→反伤/反击/分摊 |
| `EffectHandler.ts` | 技能效果分发与执行（21 种 SkillEffect 的具体实现） |
| `EffectManager.ts` | 效果生命周期管理：添加/叠加/移除、每回合 tick、CC/状态查询 |
| `GaugeManager.ts` | 行动条管理：速度计算、行动条消耗/重置、就绪检测 |
| `BattleAI.ts` | AI 决策：技能选择、丹药使用、目标选择 |
| `EventDispatcher.ts` | 事件总线：17 种战斗事件的订阅/派发 |
| `battleInit.ts` | 外部适配器：将 domain 模型转换为战斗战斗者/技能/效果 |
| `battleSettle.ts` | 战后结算：同步 HP/MP、消耗丹药、标记 NPC 死亡 |

---

## 一、回合制 & 行动条系统

### 行动条（Gauge）

每个战斗者拥有 `actionGauge`（0~200），达到 `GAUGE_MAX`（100）时可行动。

**充能公式**（`useBattle.ts` rAF 驱动）：

```
rate = (GAUGE_MAX / BASE_GAUGE_TIME_MS) * (1 + effectiveSpeed / AGILITY_DIVISOR) * dt
```

- `BASE_GAUGE_TIME_MS = 5000`：基础 5 秒填满
- `AGILITY_DIVISOR = 100`：身法作为加速因子
- `effectiveSpeed = max(1, round(baseSpeed * (1 + speedMod%)))`

### 行动消耗

| 行动 | 消耗 | 常量 |
|---|---|---|
| 普通攻击 | 50 | `NORMAL_ATTACK_COST` |
| 技能 | 100（即一整条） | 写在 skill.actionCost |
| 丹药 | 30 | `ELIXIR_COST` |
| 逃跑 | 100（即一整条） | `FLEE_COST` |

### 回合流程

```
gaugeLoop (rAF)
  └→ checkActorReady()  →  按行动条高低 + 速度排序，选出行动者
       └→ executeTurn()
            1. actionCount++
            2. tickEffects()     ← DoT/HoT/hpRecover/mpRecover 结算
            3. tickCooldowns()
            4. 死亡/胜负检查
            5. canAct() 检查     ← 眩晕时跳过行动
            6. 玩家? → phase = "playerAction"，等待 UI 操作
               AI?   → ai.decide() → executeAction()
            7. triggerSummons("on_turn_end")
```

### 逃跑机制

1. 玩家点击逃跑 → `consumeGauge(actor, FLEE_COST)` → 行动条归零，`isFleeing = true`
2. 行动条重新从 0 开始累积
3. 每帧 `checkFleeSuccess()`：行动条再次满 100 → 逃跑成功，战斗结束
4. 逃跑中的角色不参与 `checkActorReady()`（无法行动）
5. 未来可通过降低 `FLEE_COST` 实现特殊效果减少逃跑消耗

---

## 二、伤害系统

### 伤害类型

| 类型 | 说明 |
|---|---|
| `physical` | 物理伤害，被 `physDefense` 减免 |
| `magical` | 法术伤害，被 `magDefense` 减免 |
| `true` | 真实伤害，无视防御 |

### 防御公式

```
finalDamage = max(MIN_DAMAGE, rawDamage - defense)   // 减法制
// true 伤害无视防御：finalDamage = rawDamage
```

### 伤害结算管线（DamagePipeline.execute）

完整结算流程，按顺序执行：

```
1. 闪避判定
   dodgeRate = getModifierTotal(target, "dodgeRate")
   if random() < dodgeRate% → 闪避，伤害为 0

2. 暴击判定
   critRate = source.stats.critRate + getModifierTotal(source, "critRate")
   if random() < critRate% → 暴击
   critDmg = source.stats.critDmg + getModifierTotal(source, "critDmg")
   rawDamage *= critDmg / 100

3. 防御减免
   defense = physDefense 或 magDefense（true 伤害跳过）
   破甲：effectiveDef = round(defense × (1 - defensePenetration% / 100))
   baseDamage = max(1, rawDamage - effectiveDef)

4. 伤害修正（乘算）
   dealtMult  = 1 + (damageDealt% + physDamageDealt%或magDamageDealt%) / 100
   takenMult  = 1 + damageTaken% / 100
   finalDamage = max(1, round(baseDamage × dealtMult × takenMult))

5. 护盾吸收
   shield -= min(shield, finalDamage)
   超出护盾部分扣 HP

6. 致命伤害处理
   if HP <= 0:
     emit "fatal" 事件
     if 免死护盾 → HP = 1
     else        → 死亡

7. 反伤（Reflect）
   if 攻击者造成了 HP 损失:
     reflectDmg = max(1, round(finalDamage × reflectPercent%))
     攻击者损失 HP

8. 反击（Counter）
   counterDmg = max(1, counterValue × stacks)
   攻击者损失 HP

9. 伤害分摊（DamageShare）
   同队持有 damageShare 效果的队友分摊伤害
   总分摊上限 50%，被分摊者 HP 回退

10. 吸血（Lifesteal）
    if hpLost > 0:
      lifestealHeal = round(hpLost × lifesteal% / 100)
      攻击者恢复 HP（由调用方通过 applyHeal 应用，产出浮动文字+日志）
```

### 暴击/闪避基础值

- 暴击伤害基础倍率：`BASE_CRIT_DMG = 150%`
- 闪避率来源：仅 `dodgeRate` 修正（身法不影响闪避）

---

## 三、技能效果系统（21 种 SkillEffect）

每种技能在 `BattleSkill.effects` 中定义一个或多个 `SkillEffect`，由 `EffectHandler.executeEffects()` 逐个执行。

### 伤害类

| 效果 | 说明 |
|---|---|
| `dealDamage` | 造成指定类型和数值的伤害 |
| `dealDamageExecute` | 斩杀伤害：目标 HP 低于 `threshold` 时伤害提升 `bonusPercent%` |
| `dealDamagePierce` | 真实伤害，无视防御 |
| `lifesteal` | 以自身攻击力 × `damagePercent%` 造成伤害，回复等量 HP |

### 治疗类

| 效果 | 说明 |
|---|---|
| `heal` | 直接治疗目标 `value` 点 HP（受 `healReceived` 倍率加成） |
| `shield` | 为目标添加 `value` 点护盾 |

### 修正类（Buff/Debuff）

| 效果 | 说明 |
|---|---|
| `applyModifier` | 对目标施加修正效果，持续 `duration` 回合，可叠加至 `maxStacks` |

### 控制类（CC）

| 效果 | 说明 |
|---|---|
| `applyCc` | 以 `chance` 概率施加控制效果，持续 `duration` 回合 |

### 状态类（DoT/HoT）

| 效果 | 说明 |
|---|---|
| `applyStatus` | 施加持续状态，每回合 tick 造成伤害或治疗 |

### 特殊类

| 效果 | 说明 |
|---|---|
| `cleanse` | 净化自身/目标的 CC 和 DoT 效果 |
| `dispel` | 驱散目标的 modifier 和 HoT 效果 |
| `revive` | 复活已阵亡的队友，恢复 `hpPercent%` HP |
| `deathWard` | 免死护盾：受到致命伤害时保留 1 点 HP（消耗一次） |
| `extraAction` | 以 `chance` 概率获得额外行动（行动条回补） |
| `counter` | 反击姿态：被攻击时对攻击者造成固定伤害 |
| `reflect` | 伤害反弹：被攻击时反弹 `percent%` 伤害 |
| `damageShare` | 伤害分摊：为同队队友分担 `percent%` 伤害 |
| `gaugeManipulate` | 操控目标行动条 ±`value` |
| `stealth` | 隐匿状态 |
| `summon` | 召唤物：在特定触发条件下执行效果 |

---

## 四、修正类型（ModifierType）

共 17 种，通过 `applyModifier` 技能效果或被动效果施加：

### 进攻轴（通用 + 物理专用 + 法术专用，加法叠加）

| 类型 | 说明 | 生效位置 |
|---|---|---|
| `damageDealt` | 造成的伤害 +X%（所有伤害类型） | DamagePipeline 进攻方 |
| `physDamageDealt` | 物理伤害额外 +X% | DamagePipeline 进攻方 |
| `magDamageDealt` | 法术伤害额外 +X% | DamagePipeline 进攻方 |
| `defensePenetration` | 破甲 X%（削减目标有效防御，所有伤害类型） | DamagePipeline 防御减免前 |
| `physDefensePenetration` | 物理破甲 X% | DamagePipeline 防御减免前 |
| `magDefensePenetration` | 法术破甲 X% | DamagePipeline 防御减免前 |
| `lifesteal` | 攻击吸血 X%（恢复造成 HP 损失的 X%） | DamagePipeline 计算后，调用方应用 |

### 防御轴（通用 + 物理专用 + 法术专用，加法叠加）

| 类型 | 说明 | 生效位置 |
|---|---|---|
| `damageTaken` | 受到的伤害 +X%（负值=减伤，所有伤害类型） | DamagePipeline 受击方 |
| `physDamageTaken` | 物理减伤 X% | DamagePipeline 受击方 |
| `magDamageTaken` | 法术减伤 X% | DamagePipeline 受击方 |

### 通用属性（不区分伤害类型）

| 类型 | 说明 | 生效位置 |
|---|---|---|
| `healReceived` | 受到治疗量 +X% | doHeal / executeElixir |
| `hpRecover` | 每回合恢复 X% 最大生命 | tickEffects |
| `mpRecover` | 每回合恢复 X% 最大法力 | tickEffects |
| `speed` | 速度 +X% | GaugeManager.getEffectiveSpeed |
| `critRate` | 暴击率 +X% | DamagePipeline |
| `critDmg` | 暴击伤害 +X% | DamagePipeline |
| `dodgeRate` | 闪避率 +X% | DamagePipeline |

---

## 五、控制效果（CC）

共 6 种，通过 `applyCc` 施加：

| 类型 | 效果 |
|---|---|
| `stun` | 眩晕：无法行动（`canAct` 返回 false） |
| `silence` | 沉默：无法使用技能（`canUseSkills` 返回 false） |
| `freeze` | 冰冻：行动条直接清零 |
| `fear` | 恐惧：攻击随机目标 |
| `confusion` | 混乱：攻击同队目标 |
| `taunt` | 嘲讽：只能攻击嘲讽者 |

CC 效果不可叠加（同名 CC 会被替换）。

---

## 六、状态效果（StatusType / DoT / HoT）

共 5 种，通过 `applyStatus` 施加，在 `tickEffects` 中每回合结算：

| 类型 | 分类 | tick 资源 | 说明 |
|---|---|---|---|
| `poison` | DoT | HP | 每回合损失生命 |
| `burn` | DoT | HP | 每回合损失生命 |
| `bleed` | DoT | HP | 每回合损失生命 |
| `mpDrain` | DoT | MP | 每回合损失法力 |
| `hpRegen` | HoT | HP | 每回合恢复生命 |

- 支持 `isPercent`：按最大 HP/MP 百分比结算
- 支持 `maxStacks`：同种状态可叠加层数
- 效果持续时间在**被影响者自己的回合**递减

---

## 七、召唤物系统

通过 `summon` 技能效果创建，在特定触发条件下自动执行。

### 触发条件（SummonTrigger）

| 触发 | 时机 |
|---|---|
| `on_attack` | 攻击时 |
| `on_hit` | 被攻击时 |
| `on_turn_start` | 回合开始时 |
| `on_turn_end` | 回合结束时 |
| `on_kill` | 击杀目标时 |
| `on_crit` | 暴击时 |
| `on_dodge` | 闪避时 |

### 召唤效果（SummonEffectPayload）

| 类型 | 说明 |
|---|---|
| `dealDamage` | 对随机敌方造成伤害 |
| `heal` | 治疗施放者 |
| `healMp` | 恢复施放者法力 |
| `applyModifier` | 为施放者添加修正 |
| `applyStatus` | 对随机敌方施加状态 |

---

## 八、特殊效果（SpecialType）

通过技能效果创建，存储在 `BattleEffect` 中，由 DamagePipeline / EffectManager 处理：

| 类型 | 说明 | 触发位置 |
|---|---|---|
| `deathWard` | 免死护盾，致命伤保留 1 HP | DamagePipeline 致命伤害检查 |
| `counter` | 反击，被攻击时反弹固定伤害 | DamagePipeline 结算后 |
| `reflect` | 反伤，被攻击时反弹百分比伤害 | DamagePipeline 结算后 |
| `damageShare` | 伤害分摊，为队友承担伤害 | DamagePipeline 结算后 |
| `stealth` | 隐匿 | EffectManager.hasStealth() 查询 |
| `extraAction` | 额外行动 | 技能执行时即时判定 |
| `shield` | 护盾（初始护盾，init 时应用） | battleInit applyInitialShields |

---

## 九、效果叠加规则

`EffectManager.addEffect()` 根据效果类别决定叠加方式：

| 类别 | 叠加规则 |
|---|---|
| `cc` | 不叠加，同名 CC 直接替换 |
| `modifier` | 同名+同类型：取较大 modifierValue，刷新持续时间 |
| `modifier`（maxStacks > 1） | 叠加层数至 maxStacks，刷新持续时间 |
| `dot` / `hot` | 同名+同 statusType：叠加层数至 maxStacks，刷新持续时间 |
| `summon` | 同名：刷新持续时间 |
| `special` | 同名+同 specialType：刷新持续时间 |

---

## 十、事件系统

`EventDispatcher` 支持 17 种战斗事件，可在战斗前注册 handler：

| 事件 | 触发时机 |
|---|---|
| `battle_start` | 战斗开始 |
| `turn_start` | 回合开始 |
| `turn_end` | 回合结束 |
| `action_start` | 行动开始 |
| `action_end` | 行动结束 |
| `pre_damage` | 伤害结算前 |
| `damage_dealt` | 造成伤害后 |
| `damage_taken` | 受到伤害后 |
| `heal` | 治疗后 |
| `crit` | 暴击后 |
| `dodge` | 闪避后 |
| `kill` | 击杀目标后 |
| `death` | 角色死亡后 |
| `fatal` | 受到致命伤害时（免死护盾判定前） |
| `effect_expire` | 效果到期 |
| `battle_end` | 战斗结束 |

---

## 十一、AI 行为

`BattleAI.decide()` 决策优先级：

1. **技能**（60% 概率跳过每个技能）：MP 够、无冷却时随机选择可用技能
2. **丹药**：HP < 30% 时用回血丹；MP < 30% 时用回法丹
3. **普通攻击**：选择 HP 最低的敌人（60% 概率）或随机目标

---

## 十二、战斗者属性

```typescript
interface CombatantStats {
  maxHp: number;
  maxMp: number;
  speed: number;         // 身法（影响行动条充能速度）
  physAttack: number;    // 物攻（普通攻击伤害 + 物理技能 scaling）
  magAttack: number;     // 法攻（法术技能 scaling）
  physDefense: number;   // 物防（减法制）
  magDefense: number;    // 法防（减法制）
  critRate: number;      // 暴击率（百分比）
  critDmg: number;       // 暴击伤害（百分比，如 150 = 1.5 倍）
}
```

普通攻击固定为物理伤害，伤害值 = `physAttack`。

---

## 十三、战斗日志

所有战斗事件通过 `addLog()` / `addLogEntries()` 推入 `state.log`，UI 直接渲染。

### 日志类型

| type | 图标 | 颜色 | 用途 |
|---|---|---|---|
| `damage` | ⚔ | 红 `#f88` | 普通伤害 |
| `crit` | ⚔ | 黄 `#ff4` | 暴击伤害 |
| `heal` | 💚 | 绿 `#8f8` | HP/MP 恢复 |
| `shield` | 🛡 | 蓝 `#8af` | 护盾 |
| `buff` | ⬆ | 蓝 `#8af` | 增益 |
| `debuff` | ⬇ | 橙 `#fa8` | 减益 |
| `cc` | ❄ | 橙 `#fa8` | 控制 |
| `dot` | ⚔ | 红 `#f88` | 持续伤害 |
| `miss` | 💨 | 灰 `#888` | 闪避 |
| `death` | 💀 | 红 `#f44` | 阵亡 |
| `flee_success` | 🏃 | 黄 `#ff8` | 逃跑成功 |
| `flee_fail` | ✋ | 黄 `#ff8` | 逃跑失败 |
| `summon` | ✨ | - | 召唤 |
| `gauge` | ⏳ | - | 行动条操控 |
| `info` | • | 灰 `#aaa` | 回合信息等 |
| `debug` | 🔍 | 灰 `#888` | 伤害计算 trace（`BATTLE_DEBUG` 开关） |

---

## 十四、浮动文字

`pushFloat()` 向 `state.floatingTexts` 推入浮动文字，UI 在战斗者卡片上方显示：

- HP 恢复：绿色 `+N`
- MP 恢复：蓝色 `+N`
- 动画 1.5 秒后消失

---

## 十五、战斗结局

| 阶段 | 触发条件 |
|---|---|
| `victory` | 所有敌方死亡 |
| `defeat` | 所有己方死亡 |
| `fled` | 逃跑成功 |

战后通过 `battleSettle.ts` 结算：
- 主角 HP/MP 按百分比同步回 domain 模型
- 消耗使用的丹药
- 标记被击杀的 NPC 为死亡

---

## 十六、常量速查

| 常量 | 值 | 说明 |
|---|---|---|
| `GAUGE_MAX` | 100 | 行动条满值 |
| `NORMAL_ATTACK_COST` | 50 | 普通攻击消耗 |
| `ELIXIR_COST` | 30 | 使用丹药消耗 |
| `FLEE_COST` | 100 | 逃跑消耗 |
| `MIN_DAMAGE` | 1 | 最低伤害 |
| `BASE_CRIT_DMG` | 150 | 基础暴击伤害（150%） |
| `BASE_GAUGE_TIME_MS` | 5000 | 基础行动条填满时间 |
| `AGILITY_DIVISOR` | 100 | 身法除数 |
| `ACTION_DELAY_MS` | 300 | 行动间延迟 |
| `BATTLE_DEBUG` | true | 伤害 trace 日志开关 |
