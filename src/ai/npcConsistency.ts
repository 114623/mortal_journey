import { REALM_ORDER, SUB_STAGES } from "../role_core/types/playInfo";
import { gameLog } from "../log/gameLog";

/**
 * NPC 与剧情正文的一致性校验。
 *
 * 背景：状态 AI 输出的 nearbyNpcs 直接渲染成玩家可见的 NPC 面板，
 * 一旦与剧情正文对不上（多出人、少人、修为不符），玩家一眼就能发现。
 * 提示词约束只能降低概率，这里补一道**确定性的事后校验**：
 * 以剧情正文为唯一事实来源，把 AI 给的境界纠正回正文原词。
 *
 * 只做一件确定能做对的事，其余只告警不擅改：
 * 1. 境界不符 → 直接纠正（正文是事实来源，且只在"名字与境界紧邻、中间无句读、
 *    也无他人姓名"时才认定归属，避免张冠李戴）。
 * 2. 名字未在正文出现 / 新增人数过多 → 只告警（既有 NPC 本轮未被点名是正常的）。
 */

/** 单回合新增 NPC 的软上限，超过只告警。 */
export const MAX_NEW_NPC_PER_TURN = 10;

/** 名字与境界原词之间允许的最大间隔（字）。超过则认为不指向同一人。 */
const MAX_REALM_DISTANCE = 12;

/**
 * 名字与境界之间的间隔里若出现这些字符，认为已经换了句子或换了层意思，不予认定。
 * 只认句末标点、换行和引号——逗号顿号属于正常修饰间距，不能算断（"掌柜，是个练气后期的老者"）。
 */
const GAP_BREAK_RE = /[。！？；\n“”"「」『』（）()]/;

const MAJOR_PATTERN = REALM_ORDER.join("|");
const MINOR_PATTERN = SUB_STAGES.join("|");

/** 匹配"筑基中期""练气初期""结丹"这类境界原词。 */
const REALM_RE = new RegExp(`(${MAJOR_PATTERN})(${MINOR_PATTERN})?`, "g");

export interface RealmMention {
  major: string;
  minor: string;
  /** 是否带小境界（"筑基" 无，"筑基中期" 有）。 */
  hasMinor: boolean;
  /** 在原文中的起始下标。 */
  index: number;
  /** 匹配文本长度。 */
  length: number;
}

export interface NpcConsistencyIssue {
  kind: "realm_mismatch" | "name_missing" | "too_many_new";
  /** 涉及的 NPC 名字（too_many_new 时为全部新名字的顿号连接）。 */
  name: string;
  message: string;
}

export interface NpcConsistencyFix {
  /** nearbyNpcs 数组下标。 */
  index: number;
  major: string;
  minor: string;
}

export interface NpcConsistencyResult {
  issues: NpcConsistencyIssue[];
  fixes: NpcConsistencyFix[];
}

/** 找出 text 中所有境界原词提及（含位置）。 */
export function findRealmMentions(text: string): RealmMention[] {
  const out: RealmMention[] = [];
  let m: RegExpExecArray | null;
  REALM_RE.lastIndex = 0;
  while ((m = REALM_RE.exec(text)) !== null) {
    out.push({
      major: m[1],
      minor: m[2] ?? "",
      hasMinor: Boolean(m[2]),
      index: m.index,
      length: m[0].length,
    });
    // 吃掉已匹配的小境界，避免"筑基中期"里的"筑基"被再匹配一次。
    if (m[2]) REALM_RE.lastIndex = m.index + m[0].length;
  }
  return out;
}

/**
 * 判断剧情正文里与 name **紧邻**的境界原词是哪个。
 *
 * 归属判定（三条同时满足才算指向该 NPC）：
 * - 名字与境界原词的间隔 ≤ {@link MAX_REALM_DISTANCE} 字；
 * - 间隔文本中没有句读（否则多半已经换了一层意思）；
 * - 间隔文本中没有其他 NPC 的姓名（否则是别人的境界）。
 *
 * 多个候选时取间隔最小者；同等间隔下优先带小境界的。
 */
function detectRealmNearName(
  storyBody: string,
  name: string,
  otherNames: string[],
): RealmMention | null {
  if (!name || !storyBody) return null;

  let best: { mention: RealmMention; dist: number } | null = null;

  let from = 0;
  for (;;) {
    const at = storyBody.indexOf(name, from);
    if (at < 0) break;
    const nameEnd = at + name.length;

    const scanStart = Math.max(0, at - MAX_REALM_DISTANCE - 6);
    const scanEnd = Math.min(storyBody.length, nameEnd + MAX_REALM_DISTANCE + 6);
    const offset = scanStart;
    const mentions = findRealmMentions(storyBody.slice(scanStart, scanEnd));

    for (const raw of mentions) {
      const mStart = raw.index + offset;
      const mEnd = mStart + raw.length;

      // 间隔文本与距离
      let dist: number;
      let gap: string;
      if (mEnd <= at) {
        gap = storyBody.slice(mEnd, at);
        dist = at - mEnd;
      } else if (mStart >= nameEnd) {
        gap = storyBody.slice(nameEnd, mStart);
        dist = mStart - nameEnd;
      } else {
        continue; // 重叠，忽略
      }
      if (dist > MAX_REALM_DISTANCE) continue;
      if (GAP_BREAK_RE.test(gap)) continue;
      if (otherNames.some((n) => n && n !== name && gap.includes(n))) continue;

      const mention: RealmMention = { ...raw, index: mStart };
      if (
        !best ||
        dist < best.dist ||
        (dist === best.dist && raw.hasMinor && !best.mention.hasMinor)
      ) {
        best = { mention, dist };
      }
    }

    from = nameEnd;
  }

  return best ? best.mention : null;
}

/**
 * 校验并（在可能时）纠正 nearbyNpcs 与剧情正文的不一致。
 *
 * 会**就地修改**传入数组中不符的 realm 字段。
 *
 * @param storyBody       本轮剧情正文（事实来源）
 * @param npcs            AI 解析出的 NPC 列表
 * @param protagonistName 主角名（可选）。传入后，若名字与境界之间隔着主角名，
 *                        则不认定该境界属于这个 NPC——避免"练气初期的韩立与李长风同行"
 *                        把主角的境界安到李长风头上。
 */
export function checkNpcConsistency(
  storyBody: string,
  npcs: Array<{ displayName: string; realm: { major: string; minor: string }; npcId?: string }>,
  protagonistName?: string,
): NpcConsistencyResult {
  const issues: NpcConsistencyIssue[] = [];
  const fixes: NpcConsistencyFix[] = [];

  if (!npcs.length) return { issues, fixes };

  // 需要排除的姓名：其他 NPC + 主角。间隔里出现任何一个都说明这段境界不属于当前 NPC。
  const allNames = npcs.map((n) => n.displayName);
  if (protagonistName) allNames.push(protagonistName);

  // ── 1. 境界对齐：正文是事实来源，不符直接纠正 ────────────────────────────
  if (storyBody) {
    npcs.forEach((npc, index) => {
      const mentioned = detectRealmNearName(storyBody, npc.displayName, allNames);
      if (!mentioned) return;

      // 正文只给了大境界时，保留 AI 给的小境界（"筑基" + AI 的"后期" → 筑基后期）。
      const expectedMinor = mentioned.minor || npc.realm.minor;
      if (mentioned.major === npc.realm.major && expectedMinor === npc.realm.minor) return;

      const from = `${npc.realm.major}${npc.realm.minor}`;
      const to = `${mentioned.major}${expectedMinor}`;
      issues.push({
        kind: "realm_mismatch",
        name: npc.displayName,
        message: `境界与剧情不符：剧情写「${mentioned.major}${mentioned.minor}」，AI 输出「${from}」，已自动纠正为「${to}」`,
      });
      fixes.push({ index, major: mentioned.major, minor: expectedMinor });
      npc.realm.major = mentioned.major;
      npc.realm.minor = expectedMinor;
    });
  }

  // ── 2. 名字是否在正文中出现（只告警：既有 NPC 本轮未被点名属正常）────────
  if (storyBody) {
    for (const npc of npcs) {
      if (npc.displayName && !storyBody.includes(npc.displayName)) {
        issues.push({
          kind: "name_missing",
          name: npc.displayName,
          message: `剧情正文未出现「${npc.displayName}」，若为新增人物请核对数量是否与剧情一致`,
        });
      }
    }
  }

  // ── 3. 新增人数上限（无 npcId 视为新增）─────────────────────────────────
  const newOnes = npcs.filter((n) => !n.npcId);
  if (newOnes.length > MAX_NEW_NPC_PER_TURN) {
    issues.push({
      kind: "too_many_new",
      name: newOnes.map((n) => n.displayName).join("、"),
      message: `本回合新增 ${newOnes.length} 名 NPC，超过建议上限 ${MAX_NEW_NPC_PER_TURN} 名，请核对剧情是否真的写到这么多人`,
    });
  }

  if (issues.length) {
    gameLog.warn(
      `[NPC一致性] ${issues.length} 处不一致（自动纠正 ${fixes.length} 处）：` +
        issues.map((i) => i.message).join("；"),
    );
  }

  return { issues, fixes };
}
