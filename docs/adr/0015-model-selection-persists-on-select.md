# ADR-0015：`/model` 选中即写回 config.json

- 状态：采纳（2026-10）
- 修订：ADR-0004 决策四（「启动默认存在 config.json，会话选择存在内存」，Enter 只改内存、Ctrl+S 才写盘）被本 ADR **取代**。ADR-0004 的其余决策仍然有效。
- 背景：`/model` 的默认用法是「Enter 选中」，而写盘要另按 `Ctrl+S`。绝大多数用户按完 Enter 就跑了，配置从未被更新过——于是「下次启动又变回旧模型」，而面板上那个「默认」徽章一直指着 config.json 里的旧值，看起来像是坏的。同时 ADR-0004 决策四把「当前用哪个」与「下次默认哪个」当成两个意图，实测中区分它们带来的困惑大于价值。

## 决策

### 1. 选中即写盘，两套状态合并成一个
`/model` 按 Enter 选中一个模型，就同时切换本次会话并写回 `config.json` 的 `modelProvider`/`model`。不再有「只改内存」这条路。

理由：「我选了它」与「以后默认用它」在真实使用里几乎从不分离；把它们绑在一起同时消掉了两个长期存在的错觉——「默认徽章为什么不变」和「我改了为什么下次没变」。

代价是明确的：失去了「临时试一个模型、不污染默认」的能力。等真有人为此受阻，再加一个显式的「仅本次会话」键（`openSelector` 已经把 `value` 与副作用分开，加键不需要动数据结构）。

### 2. 启动默认不可用时顺手自愈 config.json
`resolveInitialChoice()` 在配置里的默认选择已不可用（provider 未登录 / 模型下线）时，退回自定义端点的第一个模型，并**把这个纠正写回 config.json**。

理由：配置里留着一个已知不可用的值，等于每次启动都重演同一个警告。既然「选中即写盘」已是常态，这里只是同一条规则的延伸。写盘失败就算了——本次会话照样能跑，只是下次还会再警告一次（文案如实区分这两种结局：`tui.model.fallbackHealed` / `tui.model.fallbackKept`）。

### 3. 环境变量在场时如实点破
`PAGEQA_LLM_MODEL` / `PAGEQA_LLM_PROVIDER` 的优先级**高于** config.json。因此用 env 启动时，Enter 写完 config 也不会改变实际生效的模型。优先级本身不动（env 是更强的显式覆盖），但写盘成功后补一条提示 `tui.model.envOverride`——否则「我明明改了怎么没变」是一个查不到出处的疑问。

### 4. 写盘失败不回滚内存
`applyModel` 先改内存再写盘。写盘失败时**保留**已经切换的会话模型，并如实告知「本次会话已切到 X，下次启动仍用旧的」。

理由：用户按下 Enter 当下要的是「这条场景跑得起来」。配置文件不可写（只读挂载、CI 容器）不该拦住一次运行——那等于把次要目标压过主要目标。此刻 `currentChoice` 与 `defaultChoice` 会短暂不一致，面板上的「默认」徽章因此仍指向真正落盘的那个值。

### 5. `Ctrl+S` 移除，不留等价别名
删掉 `openSelector` 的 `allowSaveDefault`、全局输入监听里的截获逻辑，以及 `SelectorPick.save` 字段。

理由：留着它就得在文案里撒谎——浮层提示原本写「Enter 本次会话使用 · Ctrl+S 设为启动默认」，本 ADR 之后这句直接是假的。这个项目一贯不肯留「按了没反应」的键（ADR-0004 决策六当初专门为 Ctrl+S 写截获，正因为 `SelectList` 不认它）。删掉后按 Ctrl+S 只是无动作，不报错也不丢数据。

### 6. 成功提示合并成一条
原先「本次会话模型已切换为 X」与「已把 X 设为启动默认（已写入 …）」是两行，区别只在「一个改内存、一个改文件」。现在这是同一个动作，合并为 `tui.model.applied`，顺带把「下次启动生效」这个用户最该知道的事实说出口。

## 未采纳的替代方案

- **Enter 后弹「是否同时设为启动默认？」**：最保守，但每次切换多一次交互。确认框本来是为了保护一个大多数人不想要的区分。
- **保留 `Ctrl+S` 作为等价别名**：不破坏肌肉记忆，但两份一模一样的入口需要文案二选一，且两份都不能说清自己到底做了什么。留着不写更糟。
- **自动写盘时若 env 在场则拒绝**：太粗暴。env 常是 CI 的固定配置，用户仍可能想在本地 config 里备好。

## 影响

- `src/tui/app.ts`：`applyModel` 去掉 `persist` 参数、提示合并；`resolveInitialChoice` 增加自愈写盘；`openSelector` 去掉 `allowSaveDefault`；`SelectorOverlay` 不再把 `ctrl+s` 路由给列表；文件头注释同步。
- `src/i18n.ts`：`tui.model.switched` / `tui.model.savedDefault` 删除，新增 `tui.model.applied` / `tui.model.envOverride` / `tui.model.fallbackHealed` / `tui.model.fallbackKept`；`tui.model.saveDefaultFailed` 改为说明「本次会话已生效」；`tui.model.hint`、`help.full`、`tui.help`（中英双语）不再提 Ctrl+S。
- `src/config.ts`：`saveModelSelection` 的文档注释改为「选中即调用」。
- 词汇表：`CONTEXT.md` 新增「启动默认模型」，并登记被弃用的说法「本次会话模型」。
- 测试：`tests/model-default-persistence.test.mjs` 是一条**文案守卫**——浮层按键交互在本仓库没有可驱动的夹具，但帮助文本最容易在改行为后忘记同步；文案留着 Ctrl+S，用户按了没反应就会认定功能坏了。