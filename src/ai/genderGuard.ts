/**
 * 主角性别 → 提示词中的「称呼硬约束」。
 *
 * 为什么需要单独一条：出生背景（originStory）由玩家自由书写，常含与「性别」字段
 * 冲突或易被误读的描述（如「外表女性，生殖器是男性的非二元性别」），而各条 AI 链路
 * 有的给了性别字段、有的没给（状态 AI 原先只有姓名/境界），模型于是按默认性别摇摆——
 * 同一存档里出现「大小姐」与「大公子」并存、NPC 记忆把主角写成「儿子」等串味。
 *
 * 这里把「性别」字段升格为最高优先级约束，并提供两个注入点：
 * - {@link genderLine}：user 提示词里紧贴「姓名」的性别行（含称谓口径）。
 * - {@link genderRule}：追加到 system 提示词末尾的硬约束段（优先级最高，且显式声明
 *   与出身背景、NPC 记忆冲突时的裁决顺序，用于打断「旧记忆 → 新一轮生成」的污染循环）。
 */

/** 女性主角自身适用的对外称谓。 */
export const FEMALE_ADDRESS = "姑娘/小姐/大小姐/仙子/女道友";

/** 男性主角自身适用的对外称谓。 */
export const MALE_ADDRESS = "公子/少爷/小兄弟/少年/郎君";

/** 性别无法判定或无性别设定时的中性称谓。 */
export const NEUTRAL_ADDRESS = "道友/小友/阁下";

interface GenderAddress {
  /** 面向模型的性别标签（原样回填玩家填写的值）。 */
  label: string;
  /** 该性别适用的称谓白名单。 */
  selfWords: string;
  /** 需明令禁用的相反性别称谓。 */
  banWords: string;
  /** 需明令禁用的相反性别亲属称谓。 */
  banKin: string;
}

/**
 * 把玩家填写的性别文本归一到「称谓口径」。
 *
 * 判定规则刻意宽松：文本含「女」按女性处理、含「男」按男性处理（因此「女性」
 * 「女」「外表女性」都按女性），其余（含「非二元」「无」等自定义写法）走中性称谓，
 * 既不误判也不强行套用男女专属称谓。
 */
export function resolveGenderAddress(gender: string | null | undefined): GenderAddress | null {
  const label = String(gender ?? "").trim();
  if (!label || label === "—" || label === "-") return null;
  if (label.includes("女")) {
    return { label, selfWords: FEMALE_ADDRESS, banWords: MALE_ADDRESS, banKin: "儿子/兄弟/少侠/公子" };
  }
  if (label.includes("男")) {
    return { label, selfWords: MALE_ADDRESS, banWords: FEMALE_ADDRESS, banKin: "女儿/姐妹/姑娘" };
  }
  return { label, selfWords: NEUTRAL_ADDRESS, banWords: "", banKin: "" };
}

/**
 * user 提示词用的性别行：替代原先光秃秃的 `性别：${gender}`。
 *
 * 只做「当场可读」的口径说明，不展开裁决规则（那部分交给 {@link genderRule} 放 system）。
 */
export function genderLine(gender: string | null | undefined): string {
  const a = resolveGenderAddress(gender);
  if (!a) return "性别：—";
  if (!a.banWords) {
    return `性别：${a.label}（对外一律用中性称谓：${a.selfWords}，不得套用男女专属称谓）`;
  }
  const kind = a.label.includes("女") ? "女性" : "男性";
  return `性别：${a.label}（对外称谓与代词一律用${kind}：${a.selfWords}；禁用 ${a.banWords}）`;
}

/**
 * system 提示词用的硬约束段（无性别设定时返回空串，调用方可直接拼接）。
 *
 * 关键在最后一句的裁决顺序：明确「本规则 > 出身背景 > NPC 记忆 > 历史剧情」，
 * 并允许 AI 在正文里自然纠正旧记忆里的相反称谓——否则已被污染的 NPC 记忆
 * 会每轮把主角重新拽回默认性别。
 */
export function genderRule(gender: string | null | undefined): string {
  const a = resolveGenderAddress(gender);
  if (!a) return "";
  const head = `【称呼硬约束 · 优先级最高】主角性别为「${a.label}」。`;
  const tail =
    "本规则与出身背景、主角画像、NPC 记忆、历史剧情中的任何描述冲突时，一律以本规则为准；" +
    "若旧记忆或旧剧情中出现相反性别的称谓，应在正文中自然带过并纠正，不得沿用。";
  if (!a.banWords) {
    return (
      `${head}所有 NPC 对主角的称呼、旁白代词一律使用中性称谓（${a.selfWords}），` +
      `不得套用男性或女性专属称谓；涉及亲属关系时用中性说法（孩子、晚辈、血亲等）。${tail}`
    );
  }
  const kind = a.label.includes("女") ? "女性" : "男性";
  return (
    `${head}所有 NPC 对主角的称呼、旁白代词、亲属称谓一律按${kind}书写（${a.selfWords}），` +
    `禁止使用相反性别的称谓（${a.banWords}），亲属称谓同理（不得写作 ${a.banKin}）。${tail}`
  );
}
