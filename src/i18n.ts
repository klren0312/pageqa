/**
 * i18n：把散落在 TUI / 日志 / 报告 / 导航诊断里的用户可见文案集中管理。
 *
 * 默认中文（保持既有行为不变，现有测试不受影响，且不随环境区域设置漂移）。切换到英文的两种方式：
 * - CLI `--locale en`（由 `src/index.ts` 解析后调用 `setLocale`）；
 * - 环境变量 `PAGEQA_LOCALE=en`。
 *
 * 调用处统一走 `t('key', { var })`。未收录的 key 回退到英文目录，再回退到 key 本身，
 * 因此即便某语言缺译也不会整段崩掉——只会显示 key 或英文，而不是抛错。
 *
 * zh 目录的文案与改造前的原始字符串逐字一致（保证默认输出不变），en 目录为新译。
 */

/** 支持的语种。新增语种只需在 `catalogs` 里再加一份。 */
export type Locale = "zh" | "en";

/** 插值变量：`t('x', { n: 3 })` 会把 `{n}` 替换成 `3`。 */
export type Vars = Record<string, string | number>;

/** 一份目录：key → 文案。文案里用 `{name}` 表示可插值变量。 */
type Catalog = Record<string, string>;

const catalogs: Record<Locale, Catalog> = {
  zh: {
    // ── 通用 ──
    "app.locale": "语种",
    "common.pass": "PASS",
    "common.fail": "FAIL",
    "common.cancelled": "已取消",
    "common.status": "状态",
    "common.enabled": "已启用",
    "common.disabled": "未启用",
    "common.scenarioDefault": "场景 1",

    // ── 进度日志（src/log.ts 的调用点，文案来自 agent.ts / index.ts）──
    "log.startup": "[pageqa] ===== 启动 =====",
    "log.startupInteractive": "[pageqa] ===== 启动（交互模式）=====",
    "log.replayStartup": "[pageqa] ===== 回放启动 =====",
    "log.warn": "[pageqa] 警告：{msg}",
    "log.readScriptFile": "[pageqa] 已读取脚本文件 {path}（{chars} 字符）",
    "log.readInline": "[pageqa] 已读取内联用例（{chars} 字符）",
    "log.runModeSingle": "[pageqa] 运行模式：单场景",
    "log.runModeSuite": "[pageqa] 运行模式：多场景套件",
    "log.sessionNote": "，session={id}",
    "log.debugNote": "，debug=on（stderr 含调试明细）",
    "log.scriptWillEmit": "[pageqa] 运行结束将生成回放脚本：{path}",
    "log.replayScriptGenerated":
      "[pageqa] 回放脚本已生成：{path}（{scenes} 个场景，共 {steps} 步）",
    "log.replayScriptGeneratedInteractive":
      "[pageqa] 回放脚本已生成：{path}（{scenes} 个场景，共 {steps} 步；已取消的场景不含在内）",
    "log.replayNext": "[pageqa] 下次可零模型回放：pageqa --replay {path}",
    "log.wroteBackScenarios": "[pageqa] 已写回 {n} 个追加场景到 {path}",
    "log.lostScenarios":
      "[pageqa] 本次有 {n} 个追加场景没有落点、未写入任何文件（关掉就没了）",
    "log.scriptSkippedNoScenarios":
      "[pageqa] 本次没有跑过任何场景，未生成回放脚本",
    "log.caseStart": "[pageqa] 用例开始：{text}（{chars} 字符，{steps} 个步骤）",
    "log.llmReady": "[pageqa] LLM 已就绪：model={model}",
    "log.checkModel": "[pageqa] 检查模型连通性：{model}…",
    "log.checkDaemon": "[pageqa] 检查 bsk daemon 与浏览器连接…",
    "log.createSession": "[pageqa] 创建/复用 bsk session…",
    "log.session": "[pageqa] bsk session={id}",
    "log.jev": "[pageqa] 语义断言（Jev）{state}",
    "log.toolsReady":
      "[pageqa] 工具已就绪：{n} 个；用例已编号为 {steps} 个步骤（报告按此定位卡点）",
    "log.toolStart": "[pageqa] ▶ #{n} {tool} …",
    "log.modelOutput": "[pageqa] 模型已开始输出，正在推进步骤…",
    "log.toolEnd":
      "[pageqa] {mark} #{n} {tool}{reason}{retry} {cost}ms",
    "log.cancelledBeforeStart":
      "[pageqa] 该场景在开始执行前已被取消，跳过",
    "log.caseSubmitted": "[pageqa] 已提交用例，等待模型与浏览器执行…",
    "log.continuation":
      "[pageqa] 步骤未跑完，发起第 {n} 次续跑（进度 {progress}，断言 {a}/{b}）",
    "log.caseEnd":
      "[pageqa] 用例结束：{status}，断言 {n} 条，耗时 {dur}s",
    "log.suiteStart": "[pageqa] 套件共 {n} 个场景：{names}",
    "log.suiteScenario": "[pageqa] ═══ 场景 {i}/{n}：{name} ═══",
    "log.suiteScenarioEnd": "[pageqa] ═══ 场景 {i}/{n} 结束：{status} ═══",
    "log.undeclared": "未声明",

    // ── CLI 错误（src/index.ts）──
    "err.sessionRequired": "--session 需要一个 session id 参数",
    "err.modelNotFound":
      "找不到模型 {provider}/{model}：该 provider 未注册或模型 id 不存在。\n  交互模式下可用 /model 重新选择（或 /login 登录 provider）；批处理模式请检查 ~/.pageqa/config.json 的 modelProvider 与 model 字段。",
    "err.localeRequired": "{arg} 需要一个语种参数（zh 或 en）",
    "err.modelUnreachable": "模型不可达：{provider}/{model}：{msg}",
    "err.modelUnreachableHint":
      "本次没有执行任何用例。修好端点后重试：交互模式用 /model 换一个模型（或 /login 登录 provider）；批处理模式检查 ~/.pageqa/config.json 的 baseUrl 与 apiKey（本地反代没起也会这样）。",
    "err.modelProbeTimeout": "探活请求 {ms} 毫秒内没有响应",
    "err.modelProbeNoReason": "端点未给出失败原因",
    "err.outRequired": "--out 需要一个文件路径参数",
    "err.replayRequired": "--replay 需要一个回放脚本路径",
    "err.extraPositional":
      "多余的位置参数：{a}（只接受一个用例输入；路径含空格请用引号包裹，输出路径请放在 --emit-script 之后）",
    "err.param": "参数错误：{msg}",
    "err.notFound":
      "找不到脚本文件：{path}\n  - 请确认路径存在且拼写正确\n  - 若路径含空格，请用引号包裹（如 \"C:\\dir\\my case.md\"）\n  - 若只想跑内联文本，请不要让文本以 .md/.txt 结尾",
    "err.replayWithInput": "参数错误：--replay 不能与用例输入同时使用",
    "err.emitWithReplay":
      "参数错误：--emit-script 用于生成回放脚本，不能与 --replay 同时使用",
    "err.tuiWithReplay":
      "参数错误：--tui 不能与 --replay 同时使用（回放是秒级零模型执行，既没有等待也没有追加输入的诉求）",
    "err.tuiConflict": "--tui 与 --no-tui 不能同时使用",
    "err.tuiWithJson":
      "--tui 不能与 --json 同时使用：JSON 报告要求 stdout 只放机器可读内容",
    "err.tuiWithSession":
      "--tui 不能与 --session 同时使用：交互模式下每个场景各自建一个 bsk session（场景拥有独立 session 与浏览器窗口是既有约定，不能给单个 session 塞多个场景）",
    "err.tuiNeedsFile":
      "--tui 不能与内联文本一起用：追加场景要写回一个用例文件，内联文本没有落点。想临时试一条请去掉 --tui 走批处理；想开一个可以随时加载用例文件的会话，请无参运行 pageqa",
    "err.emitMultiSource":
      "回放脚本与用例文件是一对一的，而本次运行有 {n} 个来源（{paths}），一个脚本装不下：请去掉 --emit-script 的路径，让每个来源各自贴着源用例写出，或分两次运行",
    "err.tuiNeedsTty":
      "--tui 需要交互式终端（stdin 与 stdout 都必须是 TTY）。在管道/重定向下请去掉 --tui（会自动走批处理）",
    "err.execFailed": "执行失败: {msg}",
    "err.uncaught": "执行失败（未捕获异常）: {msg}",
    "err.unhandled": "执行失败（未处理的 Promise rejection）: {msg}",
    "config.created": "配置文件已创建/确认：{path}\n目录：{dir}",
    "config.current": "当前生效配置：{json}",

    // ── 交互模式（src/tui/app.ts）──
    "tui.title": "pageqa 交互模式",
    "tui.hint":
      "Enter 提交 · Shift+Enter 换行 · Esc 中止当前场景 · ↑↓/PgUp/PgDn 滚日志 · Ctrl+P 历史 · Ctrl+C 收工 · /help",
    "tui.help":
      "命令：\n  /status        查看运行队列\n  /run <文件>    加载一个已有用例文件（路径或文件名关键字）并加入运行队列\n  /new           开一个新会话（清空视口与运行队列；已跑过的场景仍会进退出报告与回放脚本）\n  /cancel <n>    取消一个尚未开始的待办（n 为队列编号）\n  /model         选择本次会话使用的模型（Ctrl+S 设为启动默认）\n  /login         登录一个 provider（API Key 或订阅登录），凭据写入 ~/.pageqa/auth.json\n  /logout        移除某个 provider 的本地凭据\n  /help          显示本帮助\n  /exit          收工（等同于 Ctrl+C）\n  /toggle-language  切换界面语种并保存到配置（zh ⇄ en）\n键位：\n  Enter          提交输入（写了 `## 标题` 就是场景名，否则取首行摘要）\n  Shift+Enter    换行（写多场景用例时用）\n  Esc            中止当前场景，队列继续跑下一个\n  Ctrl+P/Ctrl+N  历史输入：上一条 / 下一条提交过的文本（↑/↓ 让给了日志滚动）\n  Ctrl+C         收工：中止当前 + 取消全部待办 → 还原终端 → 输出汇总报告（正常退出，不是硬杀）\n  Ctrl+C ×2      收尾期间再按一次：不再等队列停下，立刻收尾（报告照打）\n日志视口：\n  PageUp/PageDown   上下翻一页日志\n  ↑ / ↓             滚动日志（输入框为空时；有内容时它们是光标/历史）\n  Ctrl+↑ / Ctrl+↓   逐行滚动（任何时候都生效）\n  Home / End        跳到日志开头 / 回到末尾继续跟随\n  鼠标滚轮           滚动日志（一格 {wheel} 行）。有些终端会把滚轮当作 ↑/↓ 送来，走上面那条\n状态栏：运行进度（第几条/共几条、已耗时）· 待办数 · 当前模型 · 已写回数 · 落点\n输入框下方：本次会话的 token 消耗（输入/输出/缓存读/缓存写/合计/调用次数，每轮 LLM 调用后刷新）",
    "tui.scroll.paused": "↓ 已暂停跟随 · End 回到底部",
    "tui.appended": "（追加）",
    "tui.originAdded": "追加",
    "tui.queueEmpty": "运行队列为空",
    "tui.shuttingDown": "正在收尾…",
    "tui.allDone": "已全部结束，可继续追加场景",
    "tui.starting": "启动中…",
    "tui.pending": "待办 {n}",
    "tui.writtenBack": "已写回 {n}",
    "tui.state.queued": "待办",
    "tui.state.running": "运行中",
    "tui.kanban.waiting": "等待中",
    "tui.kanban.running": "进行中",
    "tui.kanban.pass": "成功",
    "tui.kanban.fail": "失败",
    "tui.kanban.more": "更多",
    "tui.sceneStart": '场景「{name}」{appended}',
    "tui.sceneEnd":
      '场景「{name}」结束：{tag}（断言 {n} 条，耗时 {duration}）',
    "tui.sceneError": '场景「{name}」执行出错：{msg}',
    "tui.wroteBack": "已写回源用例文件：## {name}",
    "tui.writeBackFail":
      "写回源用例文件失败（该场景仍会执行）：{msg}",
    "tui.notWrittenBack":
      "未写回（本次没有落点）：## {name}（关掉就没了）",
    "tui.queued":
      "已加入运行队列 #{id}：{name}（用例已写回 {path}）",
    "tui.queuedNoTarget":
      "已加入运行队列 #{id}：{name}（未写回任何文件）",
    "tui.cancelOk": '已取消待办 #{id}「{name}」',
    "tui.cancelNotFound":
      "没有找到可取消的待办 #{arg}（已开始执行的场景请用 Esc 中止）",
    "tui.unknownCmd":
      "未知命令：/{cmd}（可用：/help /status /run <文件> /new /cancel <n> /model /login /logout /toggle-language /exit）",
    "tui.languageSwitched": "界面语种已切换为 {locale}（已保存到配置）",
    "tui.languageSwitchFailed":
      "界面语种已切换为 {locale}（写入配置失败：{msg}）",
    "tui.run.usage":
      "用法：/run <用例文件路径或关键字>（如 /run examples/smoke.md、/run plm）",
    "tui.run.searching": "正在查找用例文件：{hint}",
    "tui.run.notFound":
      "没有找到匹配的用例文件：{hint}\n  可以给一个 .md/.txt 路径，或一个文件名关键字（查找会跳过 node_modules/.git 等目录）",
    "tui.run.overflow": "（另有 {n} 个匹配未列出）",
    "tui.run.ambiguous": "匹配到 {n} 个用例文件，先交给模型挑选：{paths}",
    "tui.run.picked": "已按模型的选择加载：{path}",
    "tui.run.pickFailed": "模型没能挑出唯一文件（{msg}），改为手动选择",
    "tui.run.pickTitle": "选择要加载的用例文件（{hint}）",
    "tui.run.loaded": "已加载 {n} 个场景：{path}",
    "tui.run.empty": "该文件里没有可用场景：{path}",
    "tui.run.readFailed": "读取用例文件失败：{path}（{msg}）",
    "tui.run.targetSwitched": "写回落点已切换为 {path}",
    "tui.noSource": "未指定用例文件（用 /run <路径或关键字> 加载一个）",
    "tui.target": "落点 {path}",
    "tui.noTarget": "落点：无（追加场景不会写回任何文件）",
    "tui.cmd.status": "查看运行队列",
    "tui.cmd.run": "加载一个已有用例文件并加入运行队列",
    "tui.cmd.cancel": "取消一个尚未开始的待办",
    "tui.cmd.new":
      "开一个新会话（清空视口与运行队列；已跑过的场景仍会进退出报告）",
    "tui.new.banner":
      "── 新会话 ──（上一批：{n} 个场景 · 通过 {pass} / 失败 {fail} / 已取消 {cancel}）",
    "tui.new.reset":
      "视口与运行队列已清空，token 计数从头开始；上一批的场景仍会进退出时的汇总报告与回放脚本",
    "tui.new.targetKept": "落点仍是 {path}（想换用例文件用 /run）",
    "tui.new.busyRunning":
      "当前场景「{name}」还在跑：先按 Esc 中止它，再 /new",
    "tui.new.busyWaiting":
      "队列里还有 {n} 个待办：先用 /cancel <n> 取消它们（或用 Ctrl+C 收工），再 /new",
    "tui.cmd.model": "选择本次会话使用的模型",
    "tui.cmd.login": "登录一个 provider（API Key 或订阅登录）",
    "tui.cmd.logout": "移除已登录 provider 的本地凭据",
    "tui.cmd.help": "显示本帮助",
    "tui.cmd.toggleLanguage": "切换界面语种（zh ⇄ en）并保存到配置",
    "tui.cmd.exit": "收工（等同于 Ctrl+C）",

    // ── 模型切换与登录 ──
    "tui.model.status": "模型 {model}",
    "tui.model.title": "选择模型（当前 {current}）",
    "tui.model.loading": "正在准备模型列表…",
    "tui.model.hint":
      "↑↓ 选择 · Enter 本次会话使用 · Ctrl+S 设为启动默认 · Esc 取消",
    "tui.model.badgeCurrent": "当前",
    "tui.model.badgeDefault": "默认",
    "tui.select.hint": "↑↓ 选择 · Enter 确认 · Esc 取消",
    "tui.model.fallback":
      "启动默认模型 {provider}/{model} 当前不可用（provider 未登录或模型已下线），本次先退回 {next}；可用 /model 重新选择",
    "tui.model.switched":
      "本次会话模型已切换为 {provider}/{model}（后续场景生效；当前正在跑的场景不受影响）",
    "tui.model.savedDefault":
      "已把 {provider}/{model} 设为启动默认（已写入 {path}）",
    "tui.model.saveDefaultFailed": "写入默认模型失败：{msg}",
    "tui.model.switchFailed": "切换模型失败：{provider}/{model} 未在模型目录中",
    "tui.model.empty":
      "没有可用模型：自定义端点未配置，且没有任何已登录的 provider。请先用 /login 登录。",
    "tui.model.loadFailed": "加载模型列表失败：{msg}",
    "tui.model.expectation": "模型可连通（不通则不执行用例）",
    "tui.model.stopRun":
      "已停止执行剩余 {n} 个场景：模型不通时继续跑，只会把一次配置错误摊成一堆「用例失败」，每个还要白开一次浏览器。",
    "tui.model.stopNote": "模型不可达，已停止执行",
    "tui.login.title": "选择要登录的 provider（Esc 取消）",
    "tui.login.methodTitle": "选择 {provider} 的登录方式（Esc 取消）",
    "tui.login.methodOauth": "订阅登录：{label}",
    "tui.login.methodApiKey": "API Key 登录",
    "tui.login.loggedIn": "已登录",
    "tui.login.noProviders":
      "没有可交互登录的 provider（内置 provider 未加载或都不提供登录流程）",
    "tui.login.loadFailed": "读取 provider 列表失败：{msg}",
    "tui.login.pending":
      "登录 {provider}：{method}（Esc 取消；凭据会写入 {path}）",
    "tui.login.promptSelect": "请选择一个选项（输入编号后回车）：",
    "tui.login.promptInput": "请输入（回车提交，Esc 取消）：",
    "tui.login.promptManual":
      "请把浏览器里显示的授权码/回调地址粘贴到下面（回车提交，Esc 取消）：",
    "tui.login.openUrl": "请在浏览器中打开以下地址完成授权：",
    "tui.login.deviceCode": "请在浏览器打开 {url} 并输入验证码：{code}",
    "tui.login.waiting": "等待授权完成…",
    "tui.login.info": "{msg}",
    "tui.login.success": "已登录 {provider}（凭据已写入 {path}）；可用 /model 选择它的模型",
    "tui.login.failed": "登录 {provider} 失败：{msg}",
    "tui.login.cancelled": "已取消登录 {provider}",
    "tui.login.invalidOption":
      "无效选项：{input}（请输入 1-{n} 的编号，或直接输入选项 id）",
    "tui.logout.title": "选择要移除凭据的 provider（Esc 取消）",
    "tui.logout.empty":
      "没有由 pageqa 保存的凭据可移除（环境变量与 config.json 提供的鉴权不受影响）",
    "tui.logout.success": "已移除 {provider} 的本地凭据",
    "tui.logout.failed": "移除 {provider} 的凭据失败：{msg}",
    "tui.logout.loadFailed": "读取已保存凭据失败：{msg}",
    "tui.shutdown": "收工：{reason}",
    "tui.signalReason": "Ctrl+C（终端信号）",
    "tui.shutdownNow":
      "再按一次 Ctrl+C：不再等队列停下，立刻收尾（汇总报告照打）",
    "tui.abortingCurrent": "正在中止当前场景…",
    "tui.cancelledWaiting": "已取消 {n} 个未开始的待办",
    "tui.abortTimeout":
      "中止超时，强制收尾（该场景的报告可能缺失）",
    "tui.abortScene":
      '已请求中止场景「{name}」，剩余步骤不再执行',
    "tui.enterHint":
      "输入一段自然语言用例并回车即可追加场景（有落点时写回该文件）；/run <用例文件> 加载已有用例；/help 查看命令。",
    "tui.interactiveStart": "交互模式：{n} 个初始场景已入队",
    "tui.sourceFile": "源用例文件：{path}（追加场景会写回这里）",
    "tui.running": "运行中 {i}/{n}（{duration}）",
    "tui.notExecuted": "未执行",
    "tui.notRunSuffix": "（该场景未运行）",
    "tui.scenarioErrorExpectation": "场景正常执行完毕（未因错误中断）",
    "tui.exitReason": "用户输入 /exit",
    "tui.debugOn": "，debug=on",

    // ── 报告（src/report.ts）──
    "report.title": "=== 页面测试报告 ===",
    "report.titleSuite": "=== 页面测试套件报告 ===",
    "report.modeReplay": "模式: 回放（未调用大模型）",
    "report.conclusion": "结论: {status}",
    "report.overall": "整体结论: {status}",
    "report.cancelled": "中止: {reason}",
    "report.assertCount": "断言数: {n}",
    "report.scenarioCount": "场景数: {n}",
    "report.scenarioOrigin": "（来源: {origin}）",
    "report.skipped":
      "跳过 {n} 步（元素未找到，当前页面状态下不需要该步）:",
    "report.skippedSuite":
      "  跳过 {n} 步（元素未找到，详见执行轨迹）",
    "report.summary": "摘要: {text}",
    "report.script": "回放脚本: {path}",
    "report.scenarioHeader":
      "--- 场景 {i}/{n}：{name} [{status}] ---",
    "report.traceTitle": "  执行轨迹（末尾 {shown}/{total} 条）:",
    "report.summaryLine": "汇总: {text}",
    "report.usage.replay": "Token 消耗: 未调用大模型（回放模式）",
    "report.usage.unavailable": "Token 消耗: 不可用（未采集到用量）",
    "report.usage.line":
      "Token 消耗: 输入 {in} / 输出 {out} / 缓存读 {cr} / 缓存写 {cw} / 合计 {total}（LLM 调用 {calls} 次）",
    "report.usage.noUsage": "（端点未返回 usage）",
    "report.assertIncomplete":
      "用例中的断言全部执行（实际 {got}/{expected}）",
    "report.assertIncompleteEvidence1":
      "解析到的断言少于用例中的断言数量，疑似步骤未执行完就结束",
    "report.assertIncompleteEvidence2": "最后进展：{note}",
    "report.stepsIncomplete": "全部步骤执行完成（{done}/{total}）",
    "report.stepsIncompleteEvidence1": "agent 自报的步骤完成度不足",
    "report.stepsIncompleteEvidence2": "最后进展：{note}",
    "report.stepsIncompleteEvidence3":
      "未执行到的步骤（第 {next}/{total} 步）：{step}",
    "report.traceTail": "轨迹末尾：{tail}",
    "report.cancelWithProgress":
      "用户中止了该场景（已完成 {done}/{total} 步），剩余步骤未执行",
    "report.cancel": "用户中止了该场景，剩余步骤未执行",
    "report.agentErrorExpectation": "agent 正常执行完毕（未因错误中断）",
    "report.suiteSummaryBase": "共 {n} 个场景，通过 {passed} 个",
    "report.suiteSummaryCancelled": "，已取消 {cancelled} 个",

    // ── HTML 报告（src/report-html.ts）──
    "reportHtml.generatedAt": "生成时间: {time}",
    "reportHtml.duration": "耗时: {dur}",
    "reportHtml.durationLabel": "耗时",
    "reportHtml.total": "总场景",
    "reportHtml.countPass": "通过",
    "reportHtml.countFail": "失败",
    "reportHtml.countCancelled": "已取消",
    "reportHtml.scenario": "场景",
    "reportHtml.steps": "用例步骤",
    "reportHtml.expectation": "期望",
    "reportHtml.verdict": "结论",
    "reportHtml.evidence": "证据",
    "reportHtml.trace": "执行轨迹",
    "reportHtml.expandAll": "全部展开",
    "reportHtml.collapseAll": "全部收起",
    "reportHtml.noAssertions": "无断言记录",
    "log.htmlReportWritten": "HTML 报告已生成: {path}",
    "log.htmlReportFailed": "HTML 报告生成失败: {msg}",

    // ── 导航失败诊断（src/bsk/navigate-diagnosis.ts）──
    "nav.notFound":
      "无法打开 {url}：浏览器报 {code}（此错误码尚未收录，未做解释）。",
    "nav.notFoundDetail": "原始信息：{detail}",
    "nav.local": "这是本机地址：请确认该端口的服务已启动。",
    "nav.failLine": "无法打开 {url}：{what}（net::{code}）。\n{steer}",
    // 各错误码的解释键（what / next / localNext）
    "nav.ERR_CONNECTION_REFUSED.what":
      "连接被拒绝——目标端口没有服务在监听",
    "nav.ERR_CONNECTION_REFUSED.next":
      "确认目标服务已启动、地址与端口写对了；服务未运行前重复 navigate 不会成功",
    "nav.ERR_CONNECTION_REFUSED.localNext":
      "这是本机地址：请先启动该端口的服务再重试；服务没起来之前重复 navigate 不会成功",
    "nav.ERR_UNSAFE_PORT.what":
      "浏览器把该端口列为不安全端口，直接拒绝了访问",
    "nav.ERR_UNSAFE_PORT.next":
      "换一个端口：Chrome/Edge 会拦掉一批低位端口（如 1、21、25、110），换个高位端口即可",
    "nav.ERR_NAME_NOT_RESOLVED.what": "域名解析不了",
    "nav.ERR_NAME_NOT_RESOLVED.next":
      "检查域名拼写、DNS 是否可达；内网域名通常需要先连上 VPN",
    "nav.ERR_NAME_RESOLUTION_FAILED.what": "域名解析失败",
    "nav.ERR_NAME_RESOLUTION_FAILED.next":
      "检查域名拼写、DNS 是否可达；内网域名通常需要先连上 VPN",
    "nav.ERR_CONNECTION_TIMED_OUT.what": "连接超时——主机不可达",
    "nav.ERR_CONNECTION_TIMED_OUT.next":
      "确认网络能到目标；也可能是被防火墙拦掉，或目标地址本身不通",
    "nav.ERR_TIMED_OUT.what": "连接超时——主机不可达",
    "nav.ERR_TIMED_OUT.next":
      "确认网络能到目标；也可能是被防火墙拦掉，或目标地址本身不通",
    "nav.ERR_CONNECTION_RESET.what": "连接被对端重置",
    "nav.ERR_CONNECTION_RESET.next":
      "目标服务可能正在重启或崩溃；确认它能正常响应后再试",
    "nav.ERR_HTTP_RESPONSE_CODE_FAILURE.what":
      "服务器返回了错误状态码，页面没能加载",
    "nav.ERR_HTTP_RESPONSE_CODE_FAILURE.next":
      "确认该 URL 在浏览器里直接打开是正常的；也可能是所在网络有代理/网关拦截",
    "nav.ERR_ABORTED.what": "导航被中止",
    "nav.ERR_ABORTED.next":
      "多见于页面自身触发了新的跳转或关闭；确认目标 URL 是否稳定",
    "nav.ERR_EMPTY_RESPONSE.what": "服务器没有返回任何内容",
    "nav.ERR_EMPTY_RESPONSE.next":
      "确认目标服务在正常响应（可用浏览器直接打开该地址核对）",
    "nav.ERR_ADDRESS_UNREACHABLE.what": "目标地址不可达",
    "nav.ERR_ADDRESS_UNREACHABLE.next": "确认主机在线、地址与端口写对了",
    "nav.ERR_CERT_.what": "TLS 证书校验不通过",
    "nav.ERR_CERT_.next":
      "自签或内网证书需要先在浏览器里信任；也可确认是否该改用 http",
    "nav.ERR_SSL_.what": "TLS 握手失败",
    "nav.ERR_SSL_.next": "确认目标是否支持 https、证书是否已信任",

    // ── 帮助文本（整段作为单键，{VAR_HELP} 由调用方替换）──
    "help.full": `pageqa - 自然语言驱动的页面测试工具（pi-agent-core + browserskill）

用法:
  pageqa [options] <input>

  <input>          自然语言脚本文件(.md/.txt，路径含空格请用引号包裹)，
                   或用引号包裹的内联文本
                  只接受一个用例输入；多给一个会直接报错
                  脚本中可用『## 场景名』分隔多个测试场景，自动批量运行
                  路径中粘贴带来的不可见字符（Bidi/零宽）会被自动清理；
                  若路径以 .md/.txt 结尾但文件不存在，会直接报错而非当作内联文本

选项:
  --session <id>   指定已存在的 bsk session（默认自动创建）
                  无论新建还是复用，用例跑完后都会自动关闭该 session
                  并关掉它对应的浏览器窗口（Agent Window）
  --locale <zh|en> 界面/日志/报告的显示语种（默认 zh；可用 PAGEQA_LOCALE 环境变量）
  --json           输出 JSON 报告
  --suite          强制按多场景套件运行（即使只有一个场景）
  --tui            强制进入交互模式（默认在交互式终端下自动进入，见下方「交互模式」）
  --no-tui         不要交互模式（只想看滚动日志、或排障时用）
                  也可用环境变量关闭：PAGEQA_NO_TUI=1
  --emit-script [path]
                   运行结束后把本次成功的操作序列固化成回放脚本（Replay Script）
                  不给 path 时写到源用例同目录 <用例名>.replay.json
                  （内联文本写 ./pageqa.replay.json）
                  path 建议写成路径形式（如 ./replay、reports/run1.json），
                  含空白请用引号包裹；紧跟其后的若是 .md/.txt 或含空白的文本，
                  会被当作用例输入而不是输出路径
                  无论 PASS/FAIL 都会生成，便于排查与续写
  --replay <file>  零模型回放已有的回放脚本（详见下方「回放脚本」）
  --semantic       回放时断言改用 Jev 语义判断（默认字符串包含）
  --init-config    在用户目录创建/重置配置文件
  --out <file>     将报告写入文件
  --debug          显示调试日志（bsk 命令、快照体积、上下文裁剪、Jev 请求详情）
  -h, --help       显示帮助

交互模式（跑用例的同时可以追加场景）:
  在交互式终端（stdin 与 stdout 都是 TTY）里直接运行、且未给 --json 时自动进入；
  用 --tui / --no-tui 可显式开关，也可用环境变量 PAGEQA_NO_TUI=1 关闭。
  要求必须传入源用例文件——追加场景要写回它，内联文本没有落点。

  Enter         提交（输入里写了「## 标题」就用它作场景名，否则取首行摘要）
  Shift+Enter   换行（写多场景用例时用）
  Esc           中止当前场景：记为「已取消」，不计入退出码、不写入回放脚本
  Ctrl+C        收工：中止当前 + 取消全部待办，然后输出汇总报告
  /status       查看运行队列；/cancel <n> 取消一个尚未开始的待办
  /model        选择本次会话使用的模型（Enter 本次生效，Ctrl+S 设为启动默认）
  /login        登录一个 provider（API Key 或订阅登录），凭据存到 ~/.pageqa/auth.json
  /logout       移除某个 provider 的本地凭据
  /help /exit

模型切换与登录:
  - /model 列出「已配好鉴权」的模型：自定义端点（config.json 的 baseUrl/apiKey/model）
    总是可用；内置 provider（anthropic / openai / deepseek / github-copilot …）只有
    在 /login 过、或设置了对应环境变量（如 ANTHROPIC_API_KEY）之后才会出现。
  - /model 的选择只作用于本次会话；按 Ctrl+S 才写入 config.json 的
    modelProvider/model，作为下次启动的默认。
  - 切换模型不会打断正在执行的场景：当前场景沿用开跑时的模型，下一个场景才用新模型。

  - 提交的场景会**立即追加写回源用例文件**（原文原样保留，含运行时占位符），
    因此「pageqa --tui examples/smoke.md」会改动该文件。
  - 场景串行执行：每个场景各自创建并关闭自己的 bsk session 与浏览器窗口，
    排队中的场景在轮到它执行时才创建 session。
  - 不能与 --json / --replay / --session 同时使用（前两个要独占 stdout 或无需等待，
    第三个与「场景各有独立 session」冲突）。
  - --emit-script 在交互模式下仍生效：退出时把跑过的场景一次性写入一个脚本，
    已取消的场景不含在内。

回放脚本（零模型重跑同一用例）:
  pageqa --replay <file.replay.json> [--session <id>] [--json] [--semantic] [--fail-fast]
                   按脚本逐步驱动浏览器，**不调用任何大模型**，断言默认走字符串包含
                   --semantic 可改用 Jev 语义判断（需已在配置里启用 Jev）
                   元素定位用录制时的语义定位符在当次快照里重新解析，
                   因此页面小幅调整后脚本仍可命中；源用例变更会在 stderr 提示
                   --fail-fast 任一失败即停止该场景；默认会跑完剩余步骤，
                   以便一次拿到整条用例的完整健康报告（失败仍会让退出码非零）

进度日志:
  - 运行进度会带时间戳实时输出到 stderr（bsk daemon 启动、session、每一步工具调用、
    续跑与最终结论等），stdout 只输出最终报告，两者互不干扰；长流程可据此判断进行到哪一步。
  - 加 --debug 可看到更细的 bsk 命令与耗时明细。

脚本占位符:
\${VAR_HELP}

配置:
  - 首次运行会在用户目录自动创建配置文件：~/.pageqa/config.json
    （Windows: %USERPROFILE%\\.pageqa\\config.json）
  - 可编辑该文件设置 baseUrl / apiKey / model / modelProvider
  - 也可用环境变量覆盖（优先级高于配置文件）：
      PAGEQA_LLM_BASE_URL / PAGEQA_LLM_API_KEY / PAGEQA_LLM_MODEL / PAGEQA_LLM_PROVIDER
  - 交互模式 /login 登录内置 provider 得到的凭据存在 ~/.pageqa/auth.json，
    /model 的选择可用 Ctrl+S 写回 config.json 作为启动默认（也可直接编辑上述字段）
  - Jev 语义判断（可选，用于增强断言精度；仅在字面匹配未命中时调用）：
      PAGEQA_JEV_ENABLED=true   启用 Jev 辅助断言
      PAGEQA_JEV_API_KEY=<key>  TypeSafe API 密钥
      PAGEQA_JEV_MODEL=<model>  Jev 模型（默认 jev-latest）
      PAGEQA_JEV_THRESHOLD=<n>  判定阈值 0-1（默认 0.5）
  - 运行 pageqa --init-config 可显式创建/重置配置文件

前置:
  - 已安装并启动 bsk daemon，且连接了一个浏览器（bsk session start）
  - 有一个可用的 OpenAI 兼容 LLM 端点（默认 http://127.0.0.1:3000/v1，模型 hunyuan-2.0-instruct，
    可通过 ~/.pageqa/config.json 或 PAGEQA_LLM_* 环境变量覆盖）

示例:
  pageqa --session ulao "打开 https://example.com 并断言标题包含 Example"
  pageqa examples/smoke.md --json
  pageqa examples/smoke.md --debug
  pageqa --tui examples/smoke.md        # 交互模式：跑用例的同时可以追加场景
  pageqa --tui examples/smoke.md --emit-script   # 顺手固化出回放脚本
`,
  },
  en: {
    // ── common ──
    "app.locale": "locale",
    "common.pass": "PASS",
    "common.fail": "FAIL",
    "common.cancelled": "cancelled",
    "common.status": "status",
    "common.enabled": "enabled",
    "common.disabled": "disabled",
    "common.scenarioDefault": "scenario 1",

    // ── progress log ──
    "log.startup": "[pageqa] ===== startup =====",
    "log.startupInteractive": "[pageqa] ===== startup (interactive mode) =====",
    "log.replayStartup": "[pageqa] ===== replay startup =====",
    "log.warn": "[pageqa] warning: {msg}",
    "log.readScriptFile":
      "[pageqa] read script file {path} ({chars} chars)",
    "log.readInline": "[pageqa] read inline case ({chars} chars)",
    "log.runModeSingle": "[pageqa] run mode: single scenario",
    "log.runModeSuite": "[pageqa] run mode: multi-scenario suite",
    "log.sessionNote": ", session={id}",
    "log.debugNote": ", debug=on (stderr shows debug details)",
    "log.scriptWillEmit":
      "[pageqa] a replay script will be generated at the end: {path}",
    "log.replayScriptGenerated":
      "[pageqa] replay script generated: {path} ({scenes} scenarios, {steps} steps)",
    "log.replayScriptGeneratedInteractive":
      "[pageqa] replay script generated: {path} ({scenes} scenarios, {steps} steps; cancelled scenarios excluded)",
    "log.replayNext":
      "[pageqa] next time, replay with zero models: pageqa --replay {path}",
    "log.wroteBackScenarios":
      "[pageqa] wrote back {n} appended scenario(s) to {path}",
    "log.lostScenarios":
      "[pageqa] {n} appended scenario(s) had no write-back target and were not written to any file (they are gone once you exit)",
    "log.scriptSkippedNoScenarios":
      "[pageqa] no scenario ran this session, no replay script generated",
    "log.caseStart":
      "[pageqa] case starts: {text} ({chars} chars, {steps} steps)",
    "log.llmReady": "[pageqa] LLM ready: model={model}",
    "log.checkModel": "[pageqa] checking model connectivity: {model}…",
    "log.checkDaemon":
      "[pageqa] checking bsk daemon and browser connection…",
    "log.createSession": "[pageqa] creating/reusing bsk session…",
    "log.session": "[pageqa] bsk session={id}",
    "log.jev": "[pageqa] semantic assertion (Jev) {state}",
    "log.toolsReady":
      "[pageqa] tools ready: {n}; case numbered into {steps} steps (report locates the stuck step by these)",
    "log.toolStart": "[pageqa] ▶ #{n} {tool} …",
    "log.modelOutput": "[pageqa] model started outputting, advancing steps…",
    "log.toolEnd":
      "[pageqa] {mark} #{n} {tool}{reason}{retry} {cost}ms",
    "log.cancelledBeforeStart":
      "[pageqa] this scenario was cancelled before it started, skipping",
    "log.caseSubmitted":
      "[pageqa] case submitted, waiting for model and browser to execute…",
    "log.continuation":
      "[pageqa] steps not finished, initiating retry #{n} (progress {progress}, assertions {a}/{b})",
    "log.caseEnd":
      "[pageqa] case ended: {status}, {n} assertions, elapsed {dur}s",
    "log.suiteStart": "[pageqa] suite has {n} scenario(s): {names}",
    "log.suiteScenario":
      "[pageqa] ═══ scenario {i}/{n}: {name} ═══",
    "log.suiteScenarioEnd":
      "[pageqa] ═══ scenario {i}/{n} ended: {status} ═══",
    "log.undeclared": "undeclared",

    // ── CLI errors ──
    "err.sessionRequired": "--session needs a session id argument",
    "err.modelNotFound":
      "model {provider}/{model} not found: the provider is not registered or the model id does not exist.\n  In interactive mode use /model to pick again (or /login to sign in a provider); in batch mode check the modelProvider and model fields in ~/.pageqa/config.json.",
    "err.localeRequired": "{arg} needs a locale argument (zh or en)",
    "err.modelUnreachable": "model unreachable: {provider}/{model}: {msg}",
    "err.modelUnreachableHint":
      "no scenario was executed. Fix the endpoint and retry: in interactive mode use /model to pick another model (or /login to sign in a provider); in batch mode check baseUrl and apiKey in ~/.pageqa/config.json (a stopped local proxy looks exactly like this).",
    "err.modelProbeTimeout": "the probe got no response within {ms} ms",
    "err.modelProbeNoReason": "the endpoint reported no failure reason",
    "err.outRequired": "--out needs a file path argument",
    "err.replayRequired": "--replay needs a replay script path",
    "err.extraPositional":
      "extra positional argument: {a} (only one case input is accepted; quote paths with spaces, put the output path after --emit-script)",
    "err.param": "argument error: {msg}",
    "err.notFound":
      "script file not found: {path}\n  - confirm the path exists and is spelled correctly\n  - if the path has spaces, quote it (e.g. \"C:\\dir\\my case.md\")\n  - if you only want to run inline text, do not let the text end with .md/.txt",
    "err.replayWithInput":
      "argument error: --replay cannot be used together with a case input",
    "err.emitWithReplay":
      "argument error: --emit-script generates a replay script and cannot be used with --replay",
    "err.tuiWithReplay":
      "argument error: --tui cannot be used with --replay (replay is sub-second and zero-model, with neither waiting nor appending input)",
    "err.tuiConflict": "--tui and --no-tui cannot be used together",
    "err.tuiWithJson":
      "--tui cannot be used with --json: the JSON report requires stdout to carry machine-readable content only",
    "err.tuiWithSession":
      "--tui cannot be used with --session: in interactive mode each scenario creates its own bsk session (scenarios owning independent sessions and browser windows is an established convention; a single session can't hold multiple scenarios)",
    "err.tuiNeedsFile":
      "--tui cannot be used with inline text: appended scenarios are written back to a case file, and inline text has nowhere to go. Drop --tui to run it in batch mode, or run pageqa with no arguments to open a session you can load case files into",
    "err.emitMultiSource":
      "a replay script maps one-to-one to a case file, but this run had {n} source(s) ({paths}) and a single script cannot hold them: drop the path from --emit-script so each source is written next to its own case file, or run twice",
    "err.tuiNeedsTty":
      "--tui needs an interactive terminal (both stdin and stdout must be TTY). Under a pipe/redirect, drop --tui (it auto-falls back to batch mode)",
    "err.execFailed": "execution failed: {msg}",
    "err.uncaught": "execution failed (uncaught exception): {msg}",
    "err.unhandled":
      "execution failed (unhandled Promise rejection): {msg}",
    "config.created": "config file created/confirmed: {path}\ndir: {dir}",
    "config.current": "current effective config: {json}",

    // ── interactive mode ──
    "tui.title": "pageqa interactive mode",
    "tui.hint":
      "Enter submit · Shift+Enter newline · Esc abort current scenario · ↑↓/PgUp/PgDn scroll log · Ctrl+P history · Ctrl+C finish · /help",
    "tui.help":
      "commands:\n  /status        view the run queue\n  /run <file>    load an existing case file (path or filename keyword) into the run queue\n  /new           start a new session (clears the viewport and run queue; scenarios that already ran still go into the exit report and the replay script)\n  /cancel <n>    cancel a not-yet-started pending item (n is the queue number)\n  /model         choose the model used by this session (Ctrl+S sets the startup default)\n  /login         sign in a provider (API key or subscription); credentials go to ~/.pageqa/auth.json\n  /logout        remove locally stored credentials for a provider\n  /help          show this help\n  /exit          finish (same as Ctrl+C)\n  /toggle-language  switch the UI language and save to config (zh ⇄ en)\nkeys:\n  Enter          submit input (with `## title` it becomes the scenario name, otherwise the first-line summary)\n  Shift+Enter    newline (for writing multi-scenario cases)\n  Esc            abort current scenario, queue continues to the next\n  Ctrl+P/Ctrl+N  input history: previous / next submitted text (↑/↓ went to the log)\n  Ctrl+C         finish: abort current + cancel all pending → restore the terminal → print the summary (a normal exit, never a hard kill)\n  Ctrl+C ×2      pressed again while winding down: stop waiting for the queue and finish now (the report is still printed)\nlog viewport:\n  PageUp/PageDown  scroll the log one page up/down\n  ↑ / ↓            scroll the log (when the input box is empty; otherwise they stay the editor's)\n  Ctrl+↑ / Ctrl+↓  scroll one line (always works)\n  Home / End       jump to the start of the log / back to the end\n  mouse wheel      scroll the log ({wheel} lines per notch). Some terminals report the wheel as ↑/↓ — that is the row above\nstatus bar: run progress (n of m, elapsed) · pending count · current model · written-back count · write-back target\nbelow the input box: the session's token usage (input / output / cache read / cache write / total / call count, refreshed after each LLM call)",
    "tui.scroll.paused": "↓ follow paused · End to jump to bottom",
    "tui.appended": " (appended)",
    "tui.originAdded": "appended",
    "tui.queueEmpty": "run queue is empty",
    "tui.shuttingDown": "winding down…",
    "tui.allDone": "all done, you can keep adding scenarios",
    "tui.starting": "starting…",
    "tui.pending": "pending {n}",
    "tui.writtenBack": "written back {n}",
    "tui.state.queued": "pending",
    "tui.state.running": "running",
    "tui.kanban.waiting": "Waiting",
    "tui.kanban.running": "Running",
    "tui.kanban.pass": "Pass",
    "tui.kanban.fail": "Failed",
    "tui.kanban.more": "more",
    "tui.sceneStart": 'scenario "{name}"{appended}',
    "tui.sceneEnd":
      'scenario "{name}" ended: {tag} ({n} assertions, elapsed {duration})',
    "tui.sceneError": 'scenario "{name}" errored: {msg}',
    "tui.wroteBack": "written back to source case file: ## {name}",
    "tui.writeBackFail":
      "failed to write back to source case file (scenario still runs): {msg}",
    "tui.notWrittenBack":
      "not written back (no write-back target this session): ## {name} (it is gone once you exit)",
    "tui.queued":
      "added to run queue #{id}: {name} (case written back to {path})",
    "tui.queuedNoTarget":
      "added to run queue #{id}: {name} (not written back to any file)",
    "tui.cancelOk": 'cancelled pending #{id} "{name}"',
    "tui.cancelNotFound":
      "no cancellable pending item #{arg} (for an already-running scenario use Esc to abort)",
    "tui.unknownCmd":
      "unknown command: /{cmd} (available: /help /status /run <file> /new /cancel <n> /model /login /logout /toggle-language /exit)",
    "tui.languageSwitched": "UI language switched to {locale} (saved to config)",
    "tui.languageSwitchFailed":
      "UI language switched to {locale} (failed to write config: {msg})",
    "tui.run.usage":
      "usage: /run <case file path or keyword> (e.g. /run examples/smoke.md, /run plm)",
    "tui.run.searching": "looking for a case file: {hint}",
    "tui.run.notFound":
      "no matching case file: {hint}\n  give a .md/.txt path, or a filename keyword (the search skips node_modules/.git and similar directories)",
    "tui.run.overflow": "({n} more match(es) not listed)",
    "tui.run.ambiguous":
      "{n} case files matched; asking the model to pick first: {paths}",
    "tui.run.picked": "loaded the model's pick: {path}",
    "tui.run.pickFailed":
      "the model did not pick a single file ({msg}), falling back to manual selection",
    "tui.run.pickTitle": "Choose a case file to load ({hint})",
    "tui.run.loaded": "loaded {n} scenario(s): {path}",
    "tui.run.empty": "that file has no usable scenario: {path}",
    "tui.run.readFailed": "failed to read the case file: {path} ({msg})",
    "tui.run.targetSwitched": "write-back target switched to {path}",
    "tui.noSource":
      "no case file specified (load one with /run <path or keyword>)",
    "tui.target": "target {path}",
    "tui.noTarget": "target: none (appended scenarios are not written anywhere)",
    "tui.cmd.status": "view the run queue",
    "tui.cmd.run":
      "load an existing case file and add it to the run queue",
    "tui.cmd.cancel": "cancel a not-yet-started pending item",
    "tui.cmd.new":
      "start a new session (clears the viewport and run queue; scenarios that already ran still go into the exit report)",
    "tui.new.banner":
      "── new session ── (previous batch: {n} scenario(s) · pass {pass} / fail {fail} / cancelled {cancel})",
    "tui.new.reset":
      "the viewport and run queue are cleared and the token counter starts over; the previous batch still goes into the exit summary and the replay script",
    "tui.new.targetKept":
      "write-back target is still {path} (use /run to switch case files)",
    "tui.new.busyRunning":
      "scenario \"{name}\" is still running: press Esc to abort it first, then /new",
    "tui.new.busyWaiting":
      "{n} pending item(s) are still queued: cancel them with /cancel <n> (or finish with Ctrl+C) first, then /new",
    "tui.cmd.model": "choose the model used by this session",
    "tui.cmd.login": "sign in a provider (API key or subscription login)",
    "tui.cmd.logout": "remove locally stored credentials for a provider",
    "tui.cmd.help": "show this help",
    "tui.cmd.toggleLanguage":
      "switch the UI language (zh ⇄ en) and save to config",
    "tui.cmd.exit": "finish (same as Ctrl+C)",

    // ── model switching & login ──
    "tui.model.status": "model {model}",
    "tui.model.title": "Select model (current: {current})",
    "tui.model.loading": "preparing the model list…",
    "tui.model.hint":
      "↑↓ move · Enter use for this session · Ctrl+S set as startup default · Esc cancel",
    "tui.model.badgeCurrent": "current",
    "tui.model.badgeDefault": "default",
    "tui.select.hint": "↑↓ move · Enter confirm · Esc cancel",
    "tui.model.fallback":
      "the startup default {provider}/{model} is unavailable (provider not signed in, or the model was retired); falling back to {next} for this session — use /model to pick again",
    "tui.model.switched":
      "session model switched to {provider}/{model} (takes effect for later scenarios; the running one is unaffected)",
    "tui.model.savedDefault":
      "set {provider}/{model} as the startup default (written to {path})",
    "tui.model.saveDefaultFailed": "failed to write the default model: {msg}",
    "tui.model.switchFailed":
      "failed to switch model: {provider}/{model} is not in the model catalog",
    "tui.model.empty":
      "no available models: the custom endpoint is unconfigured and no provider is signed in. Run /login first.",
    "tui.model.loadFailed": "failed to load the model list: {msg}",
    "tui.model.expectation":
      "the model is reachable (no scenario runs when it is not)",
    "tui.model.stopRun":
      "stopped the remaining {n} scenario(s): running on with a dead model only turns one config error into a pile of \"scenario failed\", each paying for a browser window that is thrown away.",
    "tui.model.stopNote": "model unreachable, run stopped",
    "tui.login.title": "Select a provider to sign in (Esc to cancel)",
    "tui.login.methodTitle":
      "Choose how to sign in to {provider} (Esc to cancel)",
    "tui.login.methodOauth": "subscription login: {label}",
    "tui.login.methodApiKey": "API key login",
    "tui.login.loggedIn": "signed in",
    "tui.login.noProviders":
      "no provider supports interactive login (built-in providers are not loaded or none offers a login flow)",
    "tui.login.loadFailed": "failed to read the provider list: {msg}",
    "tui.login.pending":
      "signing in to {provider} via {method} (Esc to cancel; credentials are written to {path})",
    "tui.login.promptSelect": "pick one option (enter its number and press Enter):",
    "tui.login.promptInput": "enter a value (Enter to submit, Esc to cancel):",
    "tui.login.promptManual":
      "paste the authorization code / callback URL shown in the browser below (Enter to submit, Esc to cancel):",
    "tui.login.openUrl": "open the following URL in a browser to authorize:",
    "tui.login.deviceCode": "open {url} in a browser and enter code: {code}",
    "tui.login.waiting": "waiting for authorization…",
    "tui.login.info": "{msg}",
    "tui.login.success":
      "signed in to {provider} (credentials written to {path}); use /model to pick one of its models",
    "tui.login.failed": "failed to sign in to {provider}: {msg}",
    "tui.login.cancelled": "cancelled signing in to {provider}",
    "tui.login.invalidOption":
      "invalid option: {input} (enter a number between 1 and {n}, or the option id)",
    "tui.logout.title": "Select a provider whose credentials to remove (Esc to cancel)",
    "tui.logout.empty":
      "no credentials stored by pageqa to remove (env vars and config.json auth are untouched)",
    "tui.logout.success": "removed locally stored credentials for {provider}",
    "tui.logout.failed": "failed to remove credentials for {provider}: {msg}",
    "tui.logout.loadFailed": "failed to read stored credentials: {msg}",
    "tui.shutdown": "finishing: {reason}",
    "tui.signalReason": "Ctrl+C (terminal signal)",
    "tui.shutdownNow":
      "Ctrl+C again: not waiting for the queue, finishing now (the summary is still printed)",
    "tui.abortingCurrent": "aborting current scenario…",
    "tui.cancelledWaiting": "cancelled {n} not-yet-started pending item(s)",
    "tui.abortTimeout":
      "abort timed out, forcing finish (this scenario's report may be missing)",
    "tui.abortScene":
      'requested abort of scenario "{name}", remaining steps will not run',
    "tui.enterHint":
      "type a natural-language case and press Enter to append a scenario (written back to the write-back target, if any); /run <case file> loads an existing case; /help for commands.",
    "tui.interactiveStart": "interactive mode: {n} initial scenario(s) queued",
    "tui.sourceFile":
      "source case file: {path} (appended scenarios are written back here)",
    "tui.running": "running {i}/{n} ({duration})",
    "tui.notExecuted": "not executed",
    "tui.notRunSuffix": " (this scenario did not run)",
    "tui.scenarioErrorExpectation":
      "scenario finished executing normally (not interrupted by an error)",
    "tui.exitReason": "user typed /exit",
    "tui.debugOn": ", debug=on",

    // ── report ──
    "report.title": "=== page test report ===",
    "report.titleSuite": "=== page test suite report ===",
    "report.modeReplay": "mode: replay (no LLM called)",
    "report.conclusion": "conclusion: {status}",
    "report.overall": "overall conclusion: {status}",
    "report.cancelled": "cancelled: {reason}",
    "report.assertCount": "assertions: {n}",
    "report.scenarioCount": "scenarios: {n}",
    "report.scenarioOrigin": " (origin: {origin})",
    "report.skipped":
      "skipped {n} step(s) (element not found, not needed in current page state):",
    "report.skippedSuite":
      "  skipped {n} step(s) (element not found, see execution trace)",
    "report.summary": "summary: {text}",
    "report.script": "replay script: {path}",
    "report.scenarioHeader":
      "--- scenario {i}/{n}: {name} [{status}] ---",
    "report.traceTitle": "  execution trace (last {shown}/{total}):",
    "report.summaryLine": "summary: {text}",
    "report.usage.replay": "Token usage: no LLM called (replay mode)",
    "report.usage.unavailable": "Token usage: unavailable (not collected)",
    "report.usage.line":
      "Token usage: input {in} / output {out} / cache read {cr} / cache write {cw} / total {total} (LLM calls {calls})",
    "report.usage.noUsage": " (endpoint returned no usage)",
    "report.assertIncomplete":
      "all assertions in the case executed (actual {got}/{expected})",
    "report.assertIncompleteEvidence1":
      "fewer assertions parsed than declared in the case; the run likely ended before finishing",
    "report.assertIncompleteEvidence2": "last progress: {note}",
    "report.stepsIncomplete": "all steps executed completely ({done}/{total})",
    "report.stepsIncompleteEvidence1":
      "agent self-reported step completeness is insufficient",
    "report.stepsIncompleteEvidence2": "last progress: {note}",
    "report.stepsIncompleteEvidence3":
      "unexecuted step (step {next}/{total}): {step}",
    "report.traceTail": "trace tail: {tail}",
    "report.cancelWithProgress":
      "user aborted this scenario (completed {done}/{total} steps), remaining steps not executed",
    "report.cancel": "user aborted this scenario, remaining steps not executed",
    "report.agentErrorExpectation":
      "agent finished executing normally (not interrupted by an error)",
    "report.suiteSummaryBase":
      "{n} scenario(s) in total, {passed} passed",
    "report.suiteSummaryCancelled": ", {cancelled} cancelled",

    "reportHtml.generatedAt": "generated at: {time}",
    "reportHtml.duration": "duration: {dur}",
    "reportHtml.durationLabel": "duration",
    "reportHtml.total": "total",
    "reportHtml.countPass": "pass",
    "reportHtml.countFail": "fail",
    "reportHtml.countCancelled": "cancelled",
    "reportHtml.scenario": "scenario",
    "reportHtml.steps": "case steps",
    "reportHtml.expectation": "expectation",
    "reportHtml.verdict": "verdict",
    "reportHtml.evidence": "evidence",
    "reportHtml.trace": "execution trace",
    "reportHtml.expandAll": "expand all",
    "reportHtml.collapseAll": "collapse all",
    "reportHtml.noAssertions": "no assertions recorded",
    "log.htmlReportWritten": "HTML report written: {path}",
    "log.htmlReportFailed": "HTML report write failed: {msg}",

    // ── navigate failure diagnosis ──
    "nav.notFound":
      "cannot open {url}: the browser reported {code} (this error code is not yet catalogued, no explanation given).",
    "nav.notFoundDetail": "original info: {detail}",
    "nav.local":
      "this is a local address: please confirm the service on that port is running.",
    "nav.failLine": "cannot open {url}: {what} (net::{code}).\n{steer}",
    "nav.ERR_CONNECTION_REFUSED.what":
      "connection refused — no service is listening on the target port",
    "nav.ERR_CONNECTION_REFUSED.next":
      "confirm the target service is up and the address/port are correct; retrying navigate before it is up will not succeed",
    "nav.ERR_CONNECTION_REFUSED.localNext":
      "this is a local address: please start the service on that port before retrying; retrying navigate before the service is up will not succeed",
    "nav.ERR_UNSAFE_PORT.what":
      "the browser listed this port as unsafe and refused access",
    "nav.ERR_UNSAFE_PORT.next":
      "use another port: Chrome/Edge block a range of low ports (e.g. 1, 21, 25, 110); use a higher port",
    "nav.ERR_NAME_NOT_RESOLVED.what": "domain name could not be resolved",
    "nav.ERR_NAME_NOT_RESOLVED.next":
      "check the domain spelling and DNS reachability; intranet domains usually need a VPN first",
    "nav.ERR_NAME_RESOLUTION_FAILED.what": "domain name resolution failed",
    "nav.ERR_NAME_RESOLUTION_FAILED.next":
      "check the domain spelling and DNS reachability; intranet domains usually need a VPN first",
    "nav.ERR_CONNECTION_TIMED_OUT.what":
      "connection timed out — host unreachable",
    "nav.ERR_CONNECTION_TIMED_OUT.next":
      "confirm the network can reach the target; it may also be blocked by a firewall or the address is simply down",
    "nav.ERR_TIMED_OUT.what": "connection timed out — host unreachable",
    "nav.ERR_TIMED_OUT.next":
      "confirm the network can reach the target; it may also be blocked by a firewall or the address is simply down",
    "nav.ERR_CONNECTION_RESET.what": "connection reset by peer",
    "nav.ERR_CONNECTION_RESET.next":
      "the target service may be restarting or crashed; confirm it responds normally before retrying",
    "nav.ERR_HTTP_RESPONSE_CODE_FAILURE.what":
      "the server returned an error status code and the page failed to load",
    "nav.ERR_HTTP_RESPONSE_CODE_FAILURE.next":
      "confirm the URL opens normally in a browser directly; a proxy/gateway on the network may also be intercepting",
    "nav.ERR_ABORTED.what": "navigation aborted",
    "nav.ERR_ABORTED.next":
      "often happens when the page itself triggered a new jump or close; confirm the target URL is stable",
    "nav.ERR_EMPTY_RESPONSE.what": "the server returned nothing",
    "nav.ERR_EMPTY_RESPONSE.next":
      "confirm the target service is responding normally (open the address directly in a browser to verify)",
    "nav.ERR_ADDRESS_UNREACHABLE.what": "target address unreachable",
    "nav.ERR_ADDRESS_UNREACHABLE.next":
      "confirm the host is online and the address/port are correct",
    "nav.ERR_CERT_.what": "TLS certificate validation failed",
    "nav.ERR_CERT_.next":
      "self-signed or intranet certificates must be trusted in the browser first; also consider switching to http",
    "nav.ERR_SSL_.what": "TLS handshake failed",
    "nav.ERR_SSL_.next":
      "confirm the target supports https and the certificate is trusted",

    // ── help (entire block as one key; {VAR_HELP} replaced by caller) ──
    "help.full": `pageqa - natural-language-driven page testing tool (pi-agent-core + browserskill)

Usage:
  pageqa [options] <input>

  <input>          a natural-language script file (.md/.txt, quote paths with spaces),
                   or inline text wrapped in quotes
                  only one case input is accepted; a second one errors out
                  use '## scenario name' in a script to split multiple scenarios, run in batch
                  invisible characters pasted from a path (Bidi/zero-width) are auto-cleaned;
                  if a path ends with .md/.txt but the file doesn't exist, it errors out instead of being treated as inline text

Options:
  --session <id>   use an existing bsk session (auto-created by default)
                  whether new or reused, the session is auto-closed after the run,
                  closing its browser window (Agent Window)
  --locale <zh|en> display language for the UI / logs / report (default zh; PAGEQA_LOCALE env also works)
  --json           output a JSON report
  --suite          force multi-scenario suite mode (even for a single scenario)
  --tui            force interactive mode (auto-enters in an interactive terminal by default, see "Interactive mode" below)
  --no-tui         don't use interactive mode (when you only want the scrolling log, or for troubleshooting)
                  also disablable via env: PAGEQA_NO_TUI=1
  --emit-script [path]
                  after the run, freeze the successful operations into a replay script (Replay Script)
                  without path, written next to the source case as <case>.replay.json
                  (inline text writes ./pageqa.replay.json)
                  path is best given as a path form (e.g. ./replay, reports/run1.json),
                  quote if it contains spaces; if what follows is .md/.txt or whitespace text,
                  it is treated as case input rather than an output path
                  generated for both PASS/FAIL, convenient for debugging and continuation
  --replay <file>  replay an existing script with zero models (see "Replay script" below)
  --semantic       at replay, assertions use Jev semantic judgment (default string contains)
  --init-config    create/reset the config file in the user directory
  --out <file>     write the report to a file
  --debug          show debug logs (bsk commands, snapshot size, context trimming, Jev request details)
  -h, --help       show help

Interactive mode (append scenarios while a run is in progress):
  auto-enters when run in an interactive terminal (both stdin and stdout are TTY) and --json is not given;
  use --tui / --no-tui to force it on/off, or env PAGEQA_NO_TUI=1 to disable.
  requires a source case file — appended scenarios are written back to it; inline text has no destination.

  Enter         submit (if the input contains "## title" it becomes the scenario name, otherwise the first-line summary is used)
  Shift+Enter   newline (for writing multi-scenario cases)
  Esc           abort current scenario: recorded as "cancelled", not counted in exit code, not written to replay script
  Ctrl+C        finish: abort current + cancel all pending, then output the summary report
  /status       view the run queue; /cancel <n> cancel a not-yet-started pending item
  /model        choose the model used by this session (Enter for this session, Ctrl+S as startup default)
  /login        sign in a provider (API key or subscription); credentials go to ~/.pageqa/auth.json
  /logout       remove locally stored credentials for a provider
  /help /exit

Model switching & login:
  - /model lists models whose provider has complete auth: the custom endpoint
    (baseUrl/apiKey/model in config.json) is always available; built-in providers
    (anthropic / openai / deepseek / github-copilot …) appear only after /login, or
    when the matching env var (e.g. ANTHROPIC_API_KEY) is set.
  - a /model choice applies to this session only; press Ctrl+S to persist it to
    modelProvider/model in config.json as the startup default.
  - switching never interrupts a running scenario: the current one keeps the model
    it started with, the next one uses the new one.

  - submitted scenarios are **immediately appended back to the source case file** (original text preserved verbatim, including runtime placeholders),
    so "pageqa --tui examples/smoke.md" modifies that file.
  - scenarios run serially: each creates and closes its own bsk session and browser window;
    a queued scenario only creates its session when its turn comes.
  - cannot be combined with --json / --replay / --session (the first two need exclusive stdout or no waiting,
    the third conflicts with "each scenario has its own session").
  - --emit-script still works in interactive mode: on exit, the run scenarios are written to one script at once,
    cancelled scenarios excluded.

Replay script (rerun the same case with zero models):
  pageqa --replay <file.replay.json> [--session <id>] [--json] [--semantic] [--fail-fast]
                   drives the browser step by step per the script, **calling no LLM**, assertions default to string contains
                   --semantic switches to Jev semantic judgment (Jev must be enabled in config)
                   element location re-parses the recorded semantic locator in the current snapshot,
                   so the script still hits after small page changes; source-case drift is warned on stderr
                   --fail-fast stops the scenario on any failure; by default it runs remaining steps,
                   to get a complete health report of the whole case in one go (failure still yields a non-zero exit code)

Progress log:
  - run progress is output to stderr in real time with timestamps (bsk daemon start, session, every tool call,
    retries and final conclusion), while stdout only carries the final report; long runs can tell which step they're on.
  - add --debug for finer bsk command and timing details.

Script placeholders:
\${VAR_HELP}

Config:
  - on first run a config file is auto-created in the user directory: ~/.pageqa/config.json
    (Windows: %USERPROFILE%\\.pageqa\\config.json)
  - edit it to set baseUrl / apiKey / model / modelProvider
  - env overrides also work (higher precedence than the config file):
      PAGEQA_LLM_BASE_URL / PAGEQA_LLM_API_KEY / PAGEQA_LLM_MODEL / PAGEQA_LLM_PROVIDER
  - credentials obtained via /login are stored in ~/.pageqa/auth.json; a /model choice
    can be persisted with Ctrl+S into config.json (or by editing the fields above)
  - Jev semantic judgment (optional, for higher assertion precision; only called when literal match misses):
      PAGEQA_JEV_ENABLED=true    enable Jev-assisted assertion
      PAGEQA_JEV_API_KEY=<key>  TypeSafe API key
      PAGEQA_JEV_MODEL=<model>  Jev model (default jev-latest)
      PAGEQA_JEV_THRESHOLD=<n>  judgment threshold 0-1 (default 0.5)
  - run pageqa --init-config to explicitly create/reset the config file

Prerequisites:
  - bsk daemon installed and started, with a browser connected (bsk session start)
  - an available OpenAI-compatible LLM endpoint (default http://127.0.0.1:3000/v1, model hunyuan-2.0-instruct,
     overridable via ~/.pageqa/config.json or PAGEQA_LLM_* env vars)

Examples:
  pageqa --session ulao "open https://example.com and assert the title contains Example"
  pageqa examples/smoke.md --json
  pageqa examples/smoke.md --debug
  pageqa --tui examples/smoke.md        # interactive mode: append scenarios while running
  pageqa --tui examples/smoke.md --emit-script   # also freeze a replay script
`,
  },
};

let current: Locale = detectLocale();

/** 解析 locale 字符串（容错：未知值回退中文）。 */
export function parseLocale(value: string | undefined): Locale {
  return value === "en" ? "en" : "zh";
}

/**
 * 决定初始语种：只看显式来源——CLI `--locale=` 与 `PAGEQA_LOCALE`；
 * 都没有就默认中文。
 *
 * 刻意**不**跟随 `LANG` / `LC_ALL`：默认行为必须确定（CI/脚本环境下 `LANG` 常见为
 * `en_US.UTF-8`，若据此自动切英文，同一份用例在本地与 CI 会得到不同语言的报告与断言）。
 * 想换语种请显式给 `--locale en` 或 `PAGEQA_LOCALE=en`。
 */
export function detectLocale(): Locale {
  const explicit =
    process.env.PAGEQA_LOCALE ??
    process.argv.find((a) => a.startsWith("--locale="))?.split("=")[1];
  return explicit ? parseLocale(explicit) : "zh";
}

/** 当前语种。 */
export function getLocale(): Locale {
  return current;
}

/** 切换语种（CLI 解析到 `--locale` 后调用）。 */
export function setLocale(locale: Locale): void {
  current = locale;
}

/**
 * 取文案并按变量插值。
 * - 当前语种缺译 → 回退英文目录；
 * - 英文也缺 → 返回 key 本身（绝不抛错）。
 */
export function t(key: string, vars?: Vars): string {
  const template = catalogs[current][key] ?? catalogs.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}
