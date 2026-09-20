/**
 * @fileoverview 把角色字段拼成文生图 prompt。
 *
 * 画风：浪漫古典仙侠油画风格、古典大师画作般的意境人物肖像（厚涂色块、伦勃朗式单一侧光、
 * 主体外轮廓卡实、背景极简平涂留白）。所有角色共用同一套模板，只替换模板变量，
 * 保证 NPC 立绘与主角立绘画风统一、不随角色漂移。
 *
 * 模板变量与角色字段的对应关系：
 *   subject_type  ← 种族（修仙者 / 人形妖兽 / 妖兽）
 *   gender        ← 性别
 *   action        ← 由身份 / 功法体系推断的静态肖像姿态
 *   location      ← 当前所在地点（只取光线、材质与空间氛围，不画无关人物）
 *   portrait_prompt ← 额外画像提示（主角「人物档案·外貌」；NPC 的 profile.appearance）
 *   figure        ← 体态（由种族 + 性别 + 境界气度推断）
 *   appearance    ← 面容、五官、气质（NPC 核心字段 appearance）
 *   appearance_details ← 更细的外貌信息（身份 / 境界 / 灵气 / 外貌年龄）
 *   hair_style    ← 发型（从 appearance 里截出发型子句，无则给古典发式）
 *   attire        ← 服装与随身外观（NPC 核心字段 clothing）
 *
 * 字段缺失时填「未注明」——模板自带「未注明项直接忽略」的硬约束，不会诱导模型臆造。
 */

import { Character } from "../role_core/Character";
import type { Npc } from "../role_core/Npc";
import type { Protagonist } from "../role_core/Protagonist";
import type { TraitEntry } from "../role_core/types/playInfo";
import type { WorldLocation } from "../role_core/types/worldLocation";
import { formatWorldLocation } from "../role_core/types/worldLocation";
import { storyStore } from "../role_core/storyStore";

/** 模板约定：未提供的项一律写「未注明」，由模型直接忽略，绝不臆造。 */
const UNSET = "未注明";

/** 境界 major → 视觉灵气描述（境界越高越超凡）。 */
const REALM_AURA: Record<string, string> = {
  "凡人": "未入仙途，凡躯浊质，气质平实朴素",
  "练气": "凡尘气息，气质质朴",
  "筑基": "气息内敛，神采清朗",
  "结丹": "周身隐现金丹灵光，气度沉稳",
  "元婴": "元婴威压隐隐外溢，气度超凡，灵气环绕",
  "化神": "化神气息如渊似海，超然物外，周身仙气氤氲",
};

/** 境界 major → 视觉灵气描述；未知境界返回空。 */
function realmAuraDescriptor(major?: string): string {
  return major ? (REALM_AURA[major] ?? "") : "";
}

// ── 肖像模板 ────────────────────────────────────────────────────────────────

/** 文生图模板变量（与提示词模板一一对应）。 */
interface PortraitVars {
  /** 画面主体类型，如「一位修仙者」。 */
  subjectType: string;
  /** 性别。 */
  gender: string;
  /** 动作与姿态（静态、无发力）。 */
  action: string;
  /** 场景：只取此地带来的光线 / 材质 / 空间氛围。 */
  location: string;
  /** 额外画像提示（最高优先级视觉锚点），无则「未注明」。 */
  portraitPrompt: string;
  /** 内容模式补充指令。 */
  portraitModeInstruction: string;
  /** 角色设定表（最高优先级准则），无则「未注明」。 */
  designSheet: string;
  /** 体态。 */
  figure: string;
  /** 面容、五官与气质。 */
  appearance: string;
  /** 更细的外貌信息。 */
  appearanceDetails: string;
  /** 发型。 */
  hairStyle: string;
  /** 服装与随身外观。 */
  attire: string;
}

/**
 * 渲染肖像 prompt。
 *
 * 模板固定，只替换变量：这样任何角色生成的都是同一套古典油画语汇，
 * 不会因为字段长短不同而画风漂移。
 */
function renderPortraitPrompt(v: PortraitVars): string {
  return [
    `生成一张浪漫古典仙侠油画风格、古典大师画作般的意境人物肖像。世界背景是东方玄幻修仙、宗门山川、法器灵光与古代服饰体系；画面主体是${v.subjectType}，性别为${v.gender}。`,
    `动作与姿态：${v.action}。`,
    `场景与氛围：环境只取${v.location}带来的光线、材质和空间氛围，不要加入无关人物。若有额外画像提示，请作为最高优先级的视觉锚点自然融入角色设计：${v.portraitPrompt}。`,
    `内容模式为安全肖像：姿态自然，画面重点放在身份气质、外貌辨识度和服饰设计。${v.portraitModeInstruction}`,
    `镜头与构图：采用半身或近景特写镜头，通过浅景深、大量留白、柔光与自然虚化突出主体，强调静态叙事瞬间与情绪表达，无动作张力，情绪克制安静。保持单人主体构图，背景必须具备空间景深与空气透视感，只有环境氛围暗示和少量虚化道具。`,
    ``,
    `若${v.designSheet}有内容则以其为最高优先级准则。否则保持${v.gender}框架。`,
    `人物的体态参考${v.figure}；面容、五官和气质以${v.appearance}为基础；更细的外貌信息参考${v.appearanceDetails}；发型参考${v.hairStyle}；服装和随身外观以${v.attire}为准。人物遵循半写实，五官精致，双眸微敛，目光低垂或平视远方，眼神深邃；双唇微启，呈现自然呼吸的瞬间。`,
    ``,
    `浪漫古典仙侠油画风格——古典大师画作般的意境人物肖像。以厚涂色块为骨，笔触厚重松散。`,
    `核心：主体外轮廓必须清晰、干净、利落。视觉中心配合高饱和明暗、实边、侧光，细腻温润；其他局部采用低饱和暖灰、米色与深色调，红色仅作局部视觉点缀。`,
    `边缘与轮廓处理：采用古典大师经典的单一侧光（如伦勃朗光），光源质地柔且透，形成明确的受光面与背光面。主体外轮廓在暗部也要通过微弱的反光或边缘线卡实，绝不与暗色背景融为一体。`,
    `厚涂色块与刮刀痕迹主要用于塑造主体外轮廓、肉体体积与衣褶内部结构；若包含轻纱材质，则需在厚涂体系中采用透明薄涂法，以大笔触透出背景底色，表现轻纱的透光感，但轻纱的外边缘仍需保持干净的形体界限，绝不糊进背景。`,
    `背景以极简的暖黑色或冷色调平涂为主，辅以极其微弱、松散的笔触暗示深远的空间景深与空气透视感，不画具体实物，保持大面积留白。`,
    `禁止：任何“未注明”的项目直接忽略，不要把字段名、说明文字、角色名、地点名或设定文本画进画面。不出现文字、水印、路人、第二主体、屏幕人物或海报人物；不得出现现代元素（现代城市、汽车、枪械、电子屏幕、现代服装、科幻机械、霓虹招牌或摄影棚器材）。`,
    `材质与细节禁忌：绝对禁止出现过分密集的细节、毛絮、漂浮的羽毛、碎片、网状纹理以及褶皱堆积。服饰与材质表现必须遵循大色块概括原则，衣褶线条流畅大方，绝不堆砌细碎繁杂的布料纹理。`,
    `若为女子，服饰为极简古风仙侠汉服，款式追求大道至简的仙气，表面为纯色或素雅大色块，无密集刺绣、无繁复花纹图案、无多余金属饰品，依靠流畅的衣褶线条和布料质感体现高级感。`,
  ].join("\n");
}

/** 安全肖像模式的固定补充指令。 */
const PORTRAIT_MODE_INSTRUCTION =
  "（安全肖像：不写暴露、挑逗或身体特化描写，靠服饰剪影、五官神情与整体配色体现人物气质。）";

// ── 字段推断 ────────────────────────────────────────────────────────────────

/** 从外貌描述里截出「发型 / 发色」子句；截不到给一个古典发式兜底。 */
function inferHairStyle(appearance: string): string {
  if (!appearance) return "古典仙侠发式，与身份相称（束发、高髻或垂发皆可），发丝走向简洁成块";
  const clauses = appearance.split(/[，,。；;]/).map(s => s.trim()).filter(Boolean);
  for (const c of clauses) {
    if (c.includes("发") && c.length <= 24) return c;
  }
  return "古典仙侠发式，与身份相称（束发、高髻或垂发皆可），发丝走向简洁成块";
}

/** 由身份 / 体系关键词推断一个静态、无发力的肖像姿态。 */
function inferAction(hints: string[], isBeast: boolean): string {
  if (isBeast) return "伏身低踞，四足抓地，头颈微抬，目光平视前方，力量内敛而不发";
  const text = hints.filter(Boolean).join(" ");
  if (/剑/.test(text)) return "侧身而立，单手轻按腰间剑柄，肩背舒展，目光低垂";
  if (/丹|药|炉/.test(text)) return "垂手端坐，一手虚托玉瓶，袖口微拢，神情沉静";
  if (/琴|笛|箫/.test(text)) return "临案静坐，双手虚按琴身，身形端正，气息平缓";
  if (/符|阵|诀|法|术/.test(text)) return "端身而立，一手结印于胸前，指尖灵光微凝，衣袖自然垂落";
  if (/体|力|拳|罡/.test(text)) return "抱臂沉肩而立，气沉丹田，身形稳如磐石，无发力动作";
  if (/贾|商|掌柜|市/.test(text)) return "坐于案侧，一手轻搭算珠或货单，上身微前倾，神色客气";
  return "端身而立（或盘膝静坐），双手自然收拢于身前，重心沉稳，无发力动作";
}

/** 体态：种族 + 性别 + 境界气度。 */
function inferFigure(race: string, gender: string, realmMajor?: string): string {
  if (race === "妖兽") return "兽形躯干，肌骨矫健，四肢有力，比例写实，重心压低";
  if (race === "人形妖兽") return "人形体态，肩腰比例矫健，保留兽类骨架与肌肉走向，站姿沉稳";
  const base = gender === "女性"
    ? "身形纤修，颈肩线条流畅，体态轻盈而不孱弱"
    : "身形修长挺拔，肩背舒展，体态沉稳而不笨重";
  if (realmMajor === "元婴" || realmMajor === "化神") return `${base}，举止间有久居上位的从容与压迫感`;
  if (realmMajor === "凡人") return `${base}，带凡俗之躯的朴实质感`;
  return base;
}

/** 角色设定表（有内容时作为最高优先级准则）；无则「未注明」。 */
function buildDesignSheet(parts: string[]): string {
  const text = parts.filter(Boolean).join("；").trim();
  return text || UNSET;
}

// ── NPC 立绘 Prompt ─────────────────────────────────────────────────────────

/**
 * 按「年龄 / 寿元」比例推算外貌年龄档位。
 *
 * 修者寿元绵长（化神可达数千岁），同比例下外貌远比凡人年轻；凡人接近寿元上限则显老。
 * age 或 shouyuan 非正时返回空串（不臆造）。
 */
function computeApparentAge(age: number, shouyuan: number): string {
  if (age <= 0 || shouyuan <= 0) return "";
  const ratio = age / shouyuan;
  if (ratio < 0.15) return "外貌年轻，宛如少年";
  if (ratio < 0.35) return "外貌为青年";
  if (ratio < 0.6) return "外貌为盛年";
  if (ratio < 0.8) return "外貌为沉稳中年";
  if (ratio < 0.92) return "外貌略显老态";
  return "外貌苍老，暮气沉沉";
}

/** 拼装「更细的外貌信息」：身份 / 境界 / 灵气 / 外貌年龄，逗号连接。 */
function buildAppearanceDetails(parts: string[]): string {
  const text = parts.filter(Boolean).join("，").trim();
  return text || UNSET;
}

/**
 * 依据 NPC 的种族 / 外貌 / 服装 + 角色信息构建文生图 prompt。
 *
 * - 修仙者：正常人形 + appearance + clothing
 * - 人形妖兽：人形体态但保留兽特征（兽耳 / 兽角 / 鳞片 / 毛色）+ appearance + clothing
 * - 妖兽：纯兽形 + appearance；无服饰、无发型
 *
 * 字段缺失时填「未注明」，保证 prompt 始终可生成且不诱导臆造。
 */
export function buildNpcPortraitPrompt(npc: Npc): string {
  const appearance = String(npc.appearance || "").trim();
  const clothing = String(npc.clothing || "").trim();
  const race = String(npc.race || "修仙者");
  const gender = String(npc.gender || "").trim() || UNSET;

  let subjectType: string;
  let attire: string;
  let hairStyle: string;
  switch (race) {
    case "妖兽":
      subjectType = "一只妖兽（灵兽形态，兽形躯干，非人形）";
      attire = "不穿戴任何人类服饰";
      hairStyle = "无人类发型，按兽类毛羽与鬃毛走向处理";
      break;
    case "人形妖兽":
      subjectType = "一位人形妖兽（整体人形，头部与躯干保留兽类特征）";
      attire = clothing || "古朴修仙服饰，大色块、无繁复纹样";
      hairStyle = inferHairStyle(appearance);
      break;
    case "修仙者":
    default:
      subjectType = "一位修仙者";
      attire = clothing || "素色修仙长袍，大色块，无繁复纹样";
      hairStyle = inferHairStyle(appearance);
      break;
  }

  const details: string[] = [];
  const identity = String(npc.identity || "").trim();
  if (identity) details.push(`身份为${identity}`);
  const realmZh = Character.formatRealm(npc.realm);
  if (realmZh && realmZh !== "—") details.push(`境界${realmZh}`);
  const aura = realmAuraDescriptor(npc.realm?.major);
  if (aura) details.push(aura);
  const ageDesc = computeApparentAge(npc.age, npc.shouyuan);
  if (ageDesc) details.push(ageDesc);

  const location = npc.currentLocation ? formatWorldLocation(npc.currentLocation) : UNSET;

  const designParts: string[] = [];
  if (identity) designParts.push(`身份：${identity}`);
  const personality = String(npc.profile?.personality || "").trim();
  if (personality) designParts.push(`气质：${personality.slice(0, 60)}`);
  if (realmZh && realmZh !== "—") designParts.push(`境界：${realmZh}`);

  return renderPortraitPrompt({
    subjectType,
    gender,
    action: inferAction([identity, String(npc.realm?.major || "")], race === "妖兽"),
    location,
    portraitPrompt: String(npc.profile?.appearance || "").trim() || UNSET,
    portraitModeInstruction: PORTRAIT_MODE_INSTRUCTION,
    designSheet: buildDesignSheet(designParts),
    figure: inferFigure(race, gender, npc.realm?.major),
    appearance: appearance || UNSET,
    appearanceDetails: buildAppearanceDetails(details),
    hairStyle,
    attire,
  });
}

// ── 主角立绘 Prompt ─────────────────────────────────────────────────────────

function extractOriginIdentity(originStory: string): string {
  const s = (originStory || "").trim();
  if (!s) return "";
  if (s.includes("散修")) return "散修出身";
  if (s.includes("家族") || s.includes("世家")) return "修仙世家出身";
  if (s.includes("宗门") || s.includes("门派")) return "宗门弟子";
  if (s.includes("凡人") || s.includes("国")) return "凡人修仙";
  if (s.includes("魔") || s.includes("邪")) return "魔道出身";
  return "";
}

function extractTraitHints(traits: TraitEntry[]): string {
  if (!traits || traits.length === 0) return "";
  const names = traits
    .map((t) => (typeof t === "string" ? t : t.name))
    .filter((n) => n && n.length <= 6)
    .slice(0, 2);
  if (names.length === 0) return "";
  return names.join("、");
}

/** 收集主角的手持物 / 功法体系线索，用于推断姿态。 */
function extractProtagonistHints(p: Protagonist): string[] {
  const hints: string[] = [];
  for (const item of p.equippedSlots) {
    if (item && item.name) hints.push(item.name);
  }
  for (const cell of p.gongfaSlots) {
    if (cell && cell.name) hints.push(cell.name);
    const sys = (cell as { system?: string }).system;
    if (sys) hints.push(sys);
  }
  return hints;
}

/**
 * 为主角构建文生图 prompt。
 *
 * 玩家在「人物档案」里填写的外貌（profile.appearance）走 portrait_prompt，
 * 是最高优先级的视觉锚点；其余字段（性别、境界、灵根、出身、天赋、法宝功法）
 * 只作为气质与姿态依据，不堆砌成画面文字。
 */
export function buildProtagonistPortraitPrompt(protagonist: Protagonist): string {
  const gender = String(protagonist.gender || "").trim() || UNSET;
  const realmZh = Character.formatRealm(protagonist.realm);
  const realmMajor = protagonist.realm?.major;

  const appearanceHint = String(protagonist.profile?.appearance || "").trim();

  const details: string[] = [];
  if (realmZh && realmZh !== "—") details.push(`境界${realmZh}`);
  const aura = realmAuraDescriptor(realmMajor);
  if (aura) details.push(aura);
  const ageDesc = computeApparentAge(protagonist.age, protagonist.shouyuan);
  if (ageDesc) details.push(ageDesc);
  const originId = extractOriginIdentity(protagonist.originStory);
  if (originId) details.push(originId);
  if (protagonist.linggen && protagonist.linggen.length > 0) {
    details.push(`${protagonist.linggen.join("、")}灵根`);
  }
  const traitHints = extractTraitHints(protagonist.traits);
  if (traitHints) details.push(`天赋${traitHints}`);

  // 基础面容/气质：以性别为框架，玩家填的外貌走 portrait_prompt 覆盖。
  const baseAppearance = gender === "女性"
    ? "容颜清丽，骨相精致，眉目疏朗，气质清冷出尘"
    : "面容俊朗，眉骨分明，鼻梁挺直，气度沉稳内敛";

  const curLoc = storyStore.worldLocation.value;
  const location = curLoc ? formatWorldLocation(curLoc) : UNSET;

  const designParts: string[] = [];
  if (originId) designParts.push(`出身：${originId}`);
  if (realmZh && realmZh !== "—") designParts.push(`境界：${realmZh}`);
  const personality = String(protagonist.profile?.personality || "").trim();
  if (personality) designParts.push(`气质：${personality.slice(0, 60)}`);

  return renderPortraitPrompt({
    subjectType: "一位修仙者",
    gender,
    action: inferAction(extractProtagonistHints(protagonist), false),
    location,
    portraitPrompt: appearanceHint || UNSET,
    portraitModeInstruction: PORTRAIT_MODE_INSTRUCTION,
    designSheet: buildDesignSheet(designParts),
    figure: inferFigure("修仙者", gender, realmMajor),
    appearance: appearanceHint ? `${baseAppearance}；${appearanceHint}` : baseAppearance,
    appearanceDetails: buildAppearanceDetails(details),
    hairStyle: inferHairStyle(appearanceHint),
    attire: "精致而不繁复的修仙服饰，大色块纯色或素雅配色，衣褶线条流畅，无密集纹样",
  });
}

// ── 地点背景 Prompt ─────────────────────────────────────────────────────────

/** 地点背景的画风前缀：无人物、广角场景、仙侠氛围。 */
const LOCATION_STYLE_PREFIX =
  "修仙题材场景背景，写实厚涂风，虚幻引擎5渲染，电影级广角镜头，8k超高清，" +
  "PBR材质，丁达尔效应体积光，仙侠氛围，景深效果，古风意境，" +
  "无文字，无水印，画面纯净";

/**
 * 为地点构建背景图 prompt，综合地点四层名称和当前境界氛围生成仙侠场景图。
 */
export function buildLocationBackgroundPrompt(
  loc: WorldLocation,
  realmMajor?: string,
): string {
  const locDesc = formatWorldLocation(loc);
  const aura = realmMajor ? (REALM_AURA[realmMajor] ?? "") : "";
  const parts = [locDesc];
  if (aura) parts.push(aura);
  return `${LOCATION_STYLE_PREFIX}，场景为${parts.join("，")}。`;
}
