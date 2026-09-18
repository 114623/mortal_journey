# 无限仙途

基于 OpenAI 兼容大语言模型（LLM）驱动的浏览器文字 RPG。单页 Vue 3 + Vite + TypeScript 应用，讲述凡人踏入修仙界、一路修炼成长的故事。所有叙事由 AI 实时生成，配合回合制战斗、境界突破与 NPC 交互。

- 在线体验：<https://wangkkkkkkkk.github.io/mortal_journey/>
- 源码仓库：<https://github.com/Wangkkkkkkkk/mortal_journey>

## 功能特性

- **气运抉择**：开局通过性格、资质等抉择生成主角初始命格。
- **AI 叙事生成**：故事文本与状态变更均由 LLM 产出，使用自定义 XML 标签结构化解析。
- **回合制战斗引擎**：独立的纯逻辑战斗模块，含伤害管线、效果管理、架势条与战斗 AI。
- **修仙境界体系**：功法修炼、境界突破、灵石与装备系统。
- **NPC 与世界观**：层级化世界地图、可交互的 NPC 状态再评估。
- **本地存档**：基于 `localStorage` 的自包含 JSON 存档，支持多存档管理与断点续玩。

## 技术栈

- Vue 3.5（Composition API + `<script setup>`）
- Vite 6
- TypeScript 6
- Font Awesome 6 / LXGW WenKai（CDN 加载）

## 快速开始

```bash
npm install
npm run dev
```

默认开发地址：<http://localhost:5173>。

> 首次启动后，需在启动页填写 OpenAI 兼容的 API 配置（Base URL 与 API Key）方可开始游戏。

## 构建与预览

```bash
npm run build      # 先执行 typecheck，再构建生产包到 dist/
npm run preview    # 本地预览生产构建
```

## 项目结构

```
src/
├── ai/            # OpenAI 兼容对话桥、提示词、故事/状态生成、修炼与 NPC 重评管线
├── battle_engine/ # 纯逻辑回合制战斗：类型、公式、伤害/效果管线、战斗 AI
├── battle_view/   # 战斗 Vue UI（BattleScreen、useBattle）
├── composables/   # 共享组合式函数（滚动锁等）
├── fate_choice/   # 角色创建（气运抉择）界面
├── log/           # 内存环形日志缓冲（调试用，不持久化）
├── main-screen/   # 主游戏界面：故事聊天、玩家面板、工具栏、弹窗
├── role_core/     # 领域模型：主角、NPC、装备、境界、世界地图、故事存储
├── save/          # 存档服务：序列化主角/NPC/世界/故事，支持后端抽象
└── start_frame/   # 启动闪屏：API 设置、存档管理
```

## 质量检查

```bash
npm run typecheck  # vue-tsc --noEmit，项目唯一的自动化质量检查
```

## 说明

- 无 Vue Router，界面切换由 `App.vue` 中的响应式 `ref` 布尔值驱动。
- 全局样式集中导入 `src/main.ts`；部分组件使用 `<style scoped>` 局部覆盖。
- AI 调用均为非流式，超时 300 秒；Base URL 缺少 `/vN` 后缀时自动追加 `/v1`。
