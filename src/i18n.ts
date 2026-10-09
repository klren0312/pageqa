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
    // 思考模式（混元/DeepSeek/Qwen 这类混合推理模型默认开着思考；src/llm.ts 按配置显式关掉）
    "log.thinkingAuto":
      "模型思考：默认已关闭（按模型 {model} 识别为 {format} 族，每次请求发送 {field}；端点若不接受会在探活时自动退回）",
    "log.thinkingOff": "模型思考：已关闭（thinkingFormat={format}，每次请求发送 {field}）",
    "log.thinkingOffNoop":
      "模型思考：thinkingFormat={format} 发不出关闭开关（它只在请求了思考档位时才带字段），端点仍用自己的默认",
    "log.thinkingOffExplicit":
      "模型思考：按配置**不**关闭（thinkingFormat=none）——请求里不带任何思考开关，端点用它自己的默认",
    "log.thinkingBad":
      "模型思考：thinkingFormat「{value}」不认识，已按默认（自动识别）处理（可选值：{list}）",
    "log.thinkingDowngraded":
      "模型思考：这个端点不接受关闭思考的字段（{field}），已自动去掉，本进程后续不再发送；要永久如此请设 thinkingFormat=none",
    "log.replayStartup": "[pageqa] ===== 回放启动 =====",
    "log.warn": "[pageqa] 警告：{msg}",
    "log.readScriptFile": "[pageqa] 已读取脚本文件 {path}（{chars} 字符）",
    "log.readInline": "[pageqa] 已读取内联用例（{chars} 字符）",
    "log.runModeSingle": "[pageqa] 运行模式：单场景",
    "log.runModeSuite": "[pageqa] 运行模式：多场景套件",
    "log.sessionNote": "，session={id}",
    "log.debugNote": "，debug=on（stderr 含调试明细）",
    "log.scriptWillEmit": "[pageqa] 运行结束将生成回放脚本：{path}",
    "log.wroteBackScenarios": "[pageqa] 已写回 {n} 个追加场景到 {path}",
    "log.lostScenarios":
      "[pageqa] 本次有 {n} 个追加场景没有落点、未写入任何文件（关掉就没了）",
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
    "log.modelOutputStart": "[pageqa] 模型输出中（第 {n} 轮）…",
    "log.modelOutputEnd": "[pageqa] 第 {n} 轮模型输出结束",
    "log.toolEnd":
      "[pageqa] {mark} #{n} {tool}{reason}{retry} {cost}ms",
    "log.cancelledBeforeStart":
      "[pageqa] 该场景在开始执行前已被取消，跳过",
    "log.caseSubmitted": "[pageqa] 已提交用例，等待模型与浏览器执行…",
    "log.continuation":
      "[pageqa] 执行完整性不足（步骤或断言未跑满），发起第 {n} 次续跑（进度 {progress}，断言 {a}/{b}）",
    "log.caseEnd":
      "[pageqa] 用例结束：{status}，断言 {n} 条，耗时 {dur}s",
    // ── session 存档与查询服务（src/session-archive.ts / src/session-server.ts）──
    "log.sessionArchived":
      "[pageqa] session 存档已写入 {id}（pageqa sessions 可回看这次运行交给了模型什么）",
    "log.sessionArchiveFailed":
      "[pageqa] session 存档写入失败（不影响测试结论）：{msg}",
    "log.sessionServing": "[pageqa] session 查询服务已启动：{url}",
    "log.sessionArchiveDir": "[pageqa] 存档容器：{dir}",
    "log.sessionArchiveEmpty":
      "[pageqa] 存档目录里还没有运行记录——先跑一次用例再回来",
    "sessions.pageTitle": "pageqa 运行存档",
    "sessions.heading": "pageqa 运行存档",
    "sessions.subtitle": "每次 agent 运行交给模型的参数、每轮上下文与每次工具调用",
    "sessions.empty": "还没有运行记录。跑一次测试后，它留下的现场会出现在这里。",
    "sessions.colTime": "时间",
    "sessions.colCase": "用例",
    "sessions.colScenario": "场景",
    "sessions.colModel": "模型",
    "sessions.colStatus": "状态",
    "sessions.colSteps": "步骤",
    "sessions.colTools": "工具调用",
    "sessions.colTurns": "轮次",
    "sessions.detailSubtitle": "运行 {id}",
    "sessions.detailParams": "传给 agent 的参数",
    "sessions.detailSystemPrompt": "系统提示词",
    "sessions.detailCase": "用例原文",
    "sessions.detailPrompt": "首次下发的 prompt（已按步骤编号）",
    "sessions.detailTools": "工具声明（{n} 个）",
    "sessions.detailVars": "占位符取值",
    "sessions.detailTurns": "LLM 轮次",
    "sessions.detailContextCount": "上下文 {n} 条",
    "sessions.detailToolCalls": "工具调用",
    "sessions.detailArgs": "入参",
    "sessions.detailResult": "结果",
    "sessions.detailUsage": "用量",
    "sessions.detailTime": "时间",
    "sessions.detailModel": "模型",
    "sessions.detailBskSession": "bsk session",
    "sessions.detailScenario": "场景",
    "sessions.detailNote": "归因",
    "sessions.detailTruncated": "（已截断，原始 {chars} 字符）",
    "sessions.detailNotFound": "找不到这条运行记录（存档可能已被清理）",
    "sessions.turn": "第 {n} 轮",
    "sessions.raw": "JSON",
    "err.sessionsListenFailed": "[pageqa] session 查询服务无法监听端口：{msg}",
    "err.portRequired": "--port 需要一个端口号",
    "err.portInvalid": "--port 只收 1-65535 的整数",
    "err.dirRequired": "--dir 需要一个目录路径",
    "log.suiteStart": "[pageqa] 套件共 {n} 个场景：{names}",
    "log.suiteScenario": "[pageqa] ═══ 场景 {i}/{n}：{name} ═══",
    "log.suiteScenarioEnd": "[pageqa] ═══ 场景 {i}/{n} 结束：{status} ═══",
    // ── 套件的子进程编排（src/suite.ts，见 ADR-0013）──
    "log.suiteChildProbe":
      "[pageqa] 场景 {i}/{n} 没有产出报告，回查模型与浏览器环境…",
    "log.suiteChildTimeout":
      "[pageqa] 场景 {i}/{n} 超过 {sec}s 的场景级上限，已终止子进程并记为失败，继续后续场景",
    "log.suiteChildCrash":
      "[pageqa] 场景 {i}/{n} 的子进程异常结束（{how}），记为失败，继续后续场景",
    "log.suiteInfraGone":
      "[pageqa] 环境不可用（{msg}）：已完成 {done} 个场景，不再开始新的场景",
    "log.suiteModelGone":
      "[pageqa] 模型不可达：已完成 {done} 个场景，不再开始新的场景",
    "log.suiteParallel":
      "[pageqa] 并发上限 {n}：同时最多跑 {n} 个场景，每个一个子进程与一个浏览器窗口",
    "log.onlySelected":
      "[pageqa] --only {selector} → 只跑第 {i}/{n} 个场景「{name}」",
    "log.sideOutputsOff":
      "[pageqa] 旁路产物已关闭：不生成 HTML 报告，也不默认生成回放脚本",
    "log.undeclared": "未声明",

    // ── CLI 错误（src/index.ts）──
    "err.sessionRequired": "--session 需要一个 session id 参数",
    "err.modelNotFound":
      "找不到模型 {provider}/{model}：该 provider 未注册或模型 id 不存在。\n  交互模式下可用 /model 重新选择（或 /login 登录 provider）；批处理模式请检查 ~/.pageqa/config.json 的 modelProvider 与 model 字段。",
    "err.localeRequired": "{arg} 需要一个语种参数（zh 或 en）",
    "err.modelUnreachable": "模型不可达：{provider}/{model}：{msg}",
    "err.modelUnreachableHint":
      "本次没有执行任何用例。修好端点后重试：交互模式用 /model 换一个模型（或 /login 登录 provider）；批处理模式检查 ~/.pageqa/config.json 的 baseUrl 与 apiKey（本地反代没起也会这样）。",
    "err.modelUnreachableHintMid":
      "套件已经跑完 {done} 个场景，剩余的记为「已取消」；上面的报告是已完成的那部分（退出码 1）。修好端点后可对被取消的场景逐个重跑（--only）。",
    "err.childEntryMissing":
      "内部错误：找不到子进程入口脚本（{path}），无法把场景放到独立进程里执行。若是从源码运行，请先构建（npm run build）；见 ADR-0013",
    "err.envUnavailable":
      "环境不可用（{msg}）：浏览器环境跑不起来，后续场景不再执行",
    "err.modelProbeTimeout": "探活请求 {ms} 毫秒内没有响应",
    "err.modelProbeNoReason": "端点未给出失败原因",
    "err.outRequired": "--out 需要一个文件路径参数",
    "err.onlyRequired": "--only 需要一个场景标识：序号，或场景标题原文",
    "err.onlyNotFound":
      "找不到场景「{selector}」：这份用例有 {n} 个场景（序号 1-{n}），标题依次是 {names}",
    "err.onlyNeedsScenarios":
      "参数错误：--only 需要一份用「## 场景名」分隔的用例。整份用例只有一个场景时，直接跑它就是它本身",
    "err.onlyWithSuite":
      "参数错误：--only 与 --suite 不能同时使用（--only 本身就是「只跑其中一个场景」）",
    "err.onlyWithTui":
      "--only 不能与 --tui 同时使用（--only 是批处理选项，交互模式下一次跑整份用例）",
    "err.onlyWithReplay":
      "参数错误：--only 不能与 --replay 同时使用（回放按脚本里的场景顺序整体执行）",
    "err.concurrencyRequired": "--concurrency 需要一个正整数参数（同时跑几个场景）",
    "err.concurrencyInvalid": "--concurrency 只收正整数，收到「{value}」",
    "err.locateTimeoutRequired":
      "--locate-timeout 需要一个毫秒数（0 = 不等页面就绪，立刻判「元素未找到」）",
    "err.locateTimeoutInvalid":
      "--locate-timeout 只收非负整数（毫秒），收到「{value}」",
    "err.concurrencyMax":
      "参数错误：--concurrency 最大 {max}，收到 {n}。并发的代价是同时开着同样多的浏览器窗口（一个场景一个 session 一个窗口），所以不做静默截断",

    "err.concurrencyWithReplay":
      "参数错误：--concurrency 不能与 --replay 同时使用（回放零模型、按脚本顺序执行，不走场景调度器）",
    "err.concurrencyWithSession":
      "参数错误：--concurrency={n} 不能与 --session 同时使用。并发的代价与前提是「每个场景一个 session 一个窗口」，而 --session 让所有场景共用同一个 session：它们会互相翻页——重启页面、跑到别人那一步上（报告照样给结论，只是结论来自另一个页面），还会被 bsk 以 session_busy 拒成一片假失败。请去掉 --session，或把并发设为 1",
    "err.replayRequired": "--replay 需要一个回放脚本路径",
    "err.unknownOption":
      "未知选项：{a}（用 --help 查看全部选项；若用例文本以 - 开头，请放在 -- 之后）",
    "err.extraPositional":
      "多余的位置参数：{a}（只接受一个用例输入；路径含空格请用引号包裹，输出路径请放在 --emit-script 之后）",
    // 统一前缀：`args.error` 与 `detectInteractive().error` 两条路径都由它套一层。
    // 因此**走这两条路径的文案自己不要再写「参数错误：」**，否则会打成
    // 「参数错误：参数错误：…」（曾经真实发生过：err.concurrencyInvalid / err.onlyWithTui）。
    // 直接写 stderr 的那些（如 err.concurrencyMax、err.onlyWithReplay）才自带前缀。
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
    "config.proxyCreated":
      "代理配置已创建（可改：代理地址 / 总开关 / 域名规则）：{path}",
    "config.proxyExists": "代理配置已存在（未改动）：{path}",
    "log.proxyOn":
      "[proxy] 代理路由已装配：{proxy} · 模式 {mode} · {rules} 条规则（配置 {path}）",
    "log.proxyOff": "[proxy] 代理路由未生效（{reason}），所有请求直连；配置 {path}",

    // ── 回放脚本（src/replay.ts）──
    "replay.err.notFound": "找不到回放脚本：{path}",
    "replay.err.invalidJson": "回放脚本不是合法 JSON：{path}（{msg}）",
    "replay.err.badFormat": "不是 pageqa 回放脚本（format={format}）：{path}",
    "replay.err.badVersion":
      "回放脚本版本不支持（脚本 v{version}，当前支持到 v{supported}）：{path}",
    "replay.err.noScenarios": "回放脚本没有可执行的场景：{path}",
    "replay.err.empty":
      "回放脚本不含任何可执行步骤（录制时模型未成功执行浏览器操作）：{path}\n请先跑一次自然语言用例使其通过，再用 --emit-script 重新生成。",
    "replay.err.badStepKind":
      "回放脚本含不支持的步骤类型（{kind}）：{path}\n  - 若是 pageqa 升级后生成的新脚本，请把 pageqa 一起升级到同一版本",
    "replay.err.badWaitFor":
      "回放脚本里的 wait_for 步骤必须**恰好**带一个条件（text / selector / gone 三选一）：{path}",
    "replay.err.pressNoKey": "回放脚本里的 press 步骤缺少键名（key）：{path}",
    "replay.err.focusNoTarget":
      "回放脚本里的 focus / blur 步骤缺少目标（target）：没有目标就不知道要动谁的焦点：{path}",
    "replay.err.networkNoUrl":
      "回放脚本里的 assert_network 步骤缺少 url：空 url 会匹配上任何请求，这条断言将永远通过：{path}",
    "replay.normalized":
      "[pageqa] 已把脚本里写死的录制取值还原为占位符（回放时重新展开）：{items}",
    "replay.drift.missing": "源用例已不存在：{path}",
    "replay.drift.changed":
      "源用例内容已变更（{path}）：脚本基于录制时的版本，建议重新用 LLM 跑一次并重新生成",
    "replay.drift.unreadable": "源用例读取失败（{path}）：{msg}",
    "replay.locate.similar": "；当前页面中名字相近的 {role} 元素：{items}",
    // 后两条只说事实、不给猜测：旧文案在这里断言「多半是点到了另一个同名菜单/按钮」与
    // 「说明该菜单/弹窗此刻并未打开」，而真实事故恰恰是「页面还没渲染出那个筛选表单」，
    // 结论写在证据里（见下面的 region* 两条与 replay.locate.missWaiting）。
    "replay.locate.roleOnly":
      "；当前页面有 {count} 个 role={role} 元素（{items}），但没有名字含「{prefix}」的",
    "replay.locate.noRole": "；当前页面中没有 role={role} 的可见元素",
    "replay.locate.regionPresent":
      "；录制时它所在区域 {region} 在页面上存在（页面已渲染），问题多半出在这个元素本身：改名、被移除，或这次本就不该点它",
    "replay.locate.regionOverlay":
      "；录制时它位于浮层 {region} 之下，而该区域此刻不存在——很可能是那个面板/弹窗没有打开",
    "replay.locate.miss":
      "无法在当前页面重新定位元素：{desc}（录制时为 {target}）{detail}",
    "replay.locate.missWaiting":
      "无法在当前页面重新定位元素：{desc}（录制时为 {target}）；已等页面就绪 {waited}ms（{polls} 次快照，行数 {lines}），{region} 始终没有出现——页面可能一直在加载或被重定向；若只是启动慢，可调大 --locate-timeout（当前 {limit}ms）",
    "replay.locate.missRef":
      "无法在当前页面重新定位元素：{target}（引用已失效，且录制时未拿到语义定位符）",
    "replay.step.label": "回放第 {index} 步（{kind}）",
    "replay.step.caseRef": "对应用例第 {step} 步：{text}",
    "replay.assert.unparsed": "无法解析断言结果：{out}",
    "replay.assert.semanticHint":
      "该断言在录制时靠 Jev 语义判断成立（字面不含期望文本），字符串匹配必然不成立——可加 --semantic 重试",
    "replay.assert.stepOk": "{context} 成功",
    "replay.retry.trace":
      "[replay-retry] #{index} {kind}（第 {attempt}/{attempts} 次失败）：{reason}",
    "replay.retry.debug": "[replay] 第 {index} 步失败，准备重试：{reason}",
    // 定位等待：这一步为什么慢，日志与轨迹里都要能看见（不能让人猜）
    "replay.wait.trace":
      "[replay-wait] {label} 等页面就绪 {waited}ms（{polls} 次快照，行数 {lines}）后解析到 {ref}",
    "replay.log.step": "[pageqa] ▶ {label} …",
    "replay.log.waitReady":
      "[pageqa] ⏳ {label} 所在区域还没出现（{region} 不在快照里），等页面就绪，上限 {limit}ms …",
    "replay.log.ok": "[pageqa] ✓ {label} {cost}ms{assert}",
    "replay.log.okAssertPass": "（断言成立）",
    "replay.log.okAssertFail": "（断言不成立）",
    "replay.log.skip":
      "[pageqa] ⚠ {label} {cost}ms 元素未找到，已跳过并继续：{reason}",
    "replay.log.fail": "[pageqa] ✗ {label} {cost}ms：{reason}",
    "replay.evidence.attempts": "{reason}；已尝试 {attempts} 次仍失败",
    "replay.evidence.aborted": "，回放在此停止",
    "replay.evidence.remaining": "；未执行到的步骤：回放第 {from}~{to} 步",
    "replay.download.triggerMissing":
      "找不到下载的触发元素，无法捕获下载（这一步是断言，不按「元素未找到」跳过）：{reason}",
    "replay.evidence.continued": "，已跳过该步并继续执行剩余步骤",
    "replay.log.session": "[pageqa] 回放 session={session}（场景：{name}）",
    "replay.log.semanticOff":
      "[pageqa] --semantic 已指定，但 Jev 未启用（缺 enabled/apiKey），断言退回字符串匹配",
    "replay.summary.executed": "回放 {total} 步，执行 {executed} 步",
    "replay.summary.skipped": "跳过 {count} 步（元素未找到）",
    "replay.summary.failed": "失败 {count} 步",
    "replay.log.scenarioEnd":
      "[pageqa] 场景回放结束：{status}（执行 {executed}/{total} 步{extra}）",
    "replay.log.scenarioEnd.skip": "，跳过 {count} 步",
    "replay.log.scenarioEnd.fail": "，失败 {count} 步",
    "replay.log.scriptStart":
      "[pageqa] 回放脚本：{path}，共 {count} 个场景，零模型执行{semantic}",
    "replay.log.scriptStart.semantic": "（断言使用 Jev 语义判断）",
    "replay.log.semanticWarn":
      "[pageqa] 注意：脚本中有 {count} 条断言在录制时靠 Jev 语义判断成立（字面不含期望文本），回放默认用字符串包含匹配必然不成立；需要语义判断请加 --semantic",
    "replay.log.settleWaits":
      "[pageqa] --settle-waits：{count} 个 wait 步骤改为「等页面稳定，上限为脚本记下的毫秒数」。若某次等待是为页面之外的事情留的（服务端正在生成文件、后台排队等），页面可能早已稳定而被提前放行——此时紧随其后的断言/下载会失败，轨迹里的 wait 行会如实写出实际等待时长",
    "replay.log.suiteScenario": "[pageqa] ═══ 场景 {index}/{total}：{name} ═══",
    "replay.log.suiteSummary": "[pageqa] 回放汇总：{summary}",

    // ── bsk 进程级错误（src/bsk/tools.ts）──
    "bsk.err.notFound": "未找到 bsk 命令：请先安装 browserskill 并确认 bsk 在 PATH 中",
    "bsk.err.timeout":
      "bsk 命令执行超时（{seconds}s）：可能 bsk daemon 未启动或未连接浏览器。请先运行 `bsk session start` 并确认浏览器已连接，再重试。命令：{cmd}",
    "bsk.err.abortedBefore": "操作已被中止，未执行：bsk {cmd}",
    "bsk.err.aborted": "操作已被中止：bsk {cmd}",
    "bsk.daemon.starting":
      "[pageqa] bsk daemon 未运行，正在后台启动（首次可能需数秒）…",
    "bsk.err.daemonExit": "bsk daemon 启动失败，退出码 {code}",
    "bsk.daemon.ready": "[pageqa] bsk daemon 已就绪（{seconds}s）",
    "bsk.err.daemonTimeout":
      "bsk daemon 启动超时（30s），请检查 bsk 安装或手动运行 `bsk daemon start`",
    "bsk.err.noBrowser":
      "bsk 未连接任何浏览器：pageqa 无法自动连接物理浏览器。\n请在浏览器中安装 bsk 扩展并完成连接（或运行 `bsk session start` 按其提示连接），再重试。",
    "bsk.connected": "[pageqa] bsk 已连接浏览器 {count} 个",
    "bsk.err.sessionFailed": "无法创建 bsk session，请确认 bsk daemon 已连接浏览器。",
    "bsk.err.uploadMissing": "待上传文件不存在：{file}",
    // 引用闸门（src/bsk/tools.ts 的 checkRef / src/locator.ts 的 inspectRefTarget）
    // 这条报错后面**一定**会跟上「当前页面的可交互元素」清单（src/bsk/tools.ts 的 exec），
    // 因此这里只交代「为什么失效」，「怎么办」由清单的标题来说——两处都写会互相打架
    // （清单说的是「不必再单独 snapshot」，正文说的却是「请先调用 snapshot」）。
    "bsk.err.refStale":
      "`{target}` 这个 @eN 引用已失效：最近一次快照之后页面被改动过（navigate/click/fill/select_option/pick_date/hover/scroll/wait 任一动作都会让引用重新编号），它现在可能指向另一个元素——沿用会静默点到同编号的那个。",
    "bsk.err.refUnknown":
      "最近一次快照里没有 {target} 这个引用：{action} 用的 @eN 必须来自最近一次 snapshot。请先 snapshot 取当前编号，不要沿用更早快照的编号或凭记忆写编号。",
    "bsk.ref.landed": "（落点：{who}）",
    // 动作后附的「可交互元素清单」（src/bsk/tools.ts 的 refsAfterAction）：
    // forRetry 用在「引用失效」的报错里——那一次动作没成功，说「动作后」会让人以为它成功了。
    "bsk.refs.afterAction": "动作后的可交互元素",
    "bsk.refs.forRetry":
      "当前页面的可交互元素（用这里的新编号重试本次 {action}，不必再单独调用 snapshot）",
    "bsk.refs.failed": "（取快照失败：{msg}）",
    // 原生对话框透传（src/bsk/ipc-commands.ts 的 renderDialogs / extractDialogs）
    "bsk.dialog.notice":
      "注意：这次操作期间页面弹出了原生对话框，bsk 已按默认策略处理（确认框点确定、提示框点关闭），页面不会卡住：",
    // console / network 断言（src/bsk/tools.ts 的 assert_no_console_error / assert_network）
    "bsk.console.unreadable":
      "读不到 console 记录：bsk 返回的内容无法解析。请确认当前 bsk 版本支持 console 命令（`bsk console --help`）。",
    "bsk.console.truncated":
      "（bsk 的 console 缓冲只保留最近 200 条，更早的记录已被丢弃：这里看到的不是全部）",
    "bsk.console.scopeErrors": "报错",
    "bsk.console.scopeWarnings": "错误或警告",
    "bsk.console.expectation": "页面没有 JavaScript {scope}",
    "bsk.console.clean": "最近 {count} 条 console 记录里没有{scope}条目{note}",
    "bsk.console.dirty": "发现 {count} 条{scope}：{sample}{note}",
    "bsk.network.unreadable":
      "读不到网络记录：bsk 返回的内容无法解析。请确认当前 bsk 版本支持 network 命令（`bsk network --help`）。",
    "bsk.network.urlRequired":
      "assert_network 需要给出 url（要断言的那个请求的地址片段，按子串匹配）。",
    "bsk.network.badStatus":
      "无法理解状态码期望「{spec}」。支持的写法：200（精确）、2xx / 4xx / 5xx（区间）。",
    "bsk.network.truncated":
      "（bsk 的网络缓冲只保留最近 200 条，更早的记录已被丢弃：这里看到的不是全部）",
    // 方法也是匹配条件：methodSuffix 进**期望**（报告里那句断言原文），methodNote 进证据。
    // 少了它，一条「地址没错、只是方法写错」的断言会报成「没有匹配「url」的请求」，
    // 把人引去改那个本来没错的地址（实测被这么误导过一轮）。
    "bsk.network.methodSuffix": "，方法 {method}",
    "bsk.network.methodNote": "（方法 {method}）",
    "bsk.network.expectationStatus": "请求 {url} 返回 {status}{method}",
    "bsk.network.expectationAny": "请求 {url} 成功完成{method}",
    "bsk.network.expectedResponse": "收到成功响应（不是请求失败）",
    "bsk.network.noTraffic":
      "（这一页还没有产生任何网络记录：要么它真的没有发请求，要么 bsk 的网络采集没能为它开启）",
    "bsk.network.noMatch":
      "最近 {count} 条网络记录里没有匹配「{url}」{method}的请求{note}。最近的请求：{recent}",
    "bsk.network.methodMismatch":
      "「{url}」匹配到 {count} 条请求，但方法都不是 {expected}（实际出现过：{actual}）{note}。请把 method 写成实际的方法，或去掉 method 只按 URL 匹配。",
    "bsk.network.hit": "匹配「{url}」{method}的请求 {count} 条，最近一条：{latest}{note}",
    "bsk.network.miss":
      "匹配「{url}」{method}的请求 {count} 条，实际：{actual}（期望 {expected}）{note}",
    // 截图（src/bsk/tools.ts 的 screenshot 工具 + src/report-html.ts 的嵌图）
    "bsk.screenshot.bothModes":
      "截图不能同时要「整页」和「某个元素」：二选一（整页用 fullPage=true，元素用 target）。",
    "bsk.screenshot.refOnly":
      "元素截图只支持 @eN 引用（bsk 的 screenshot 没有 CSS 选择器入口），收到的是「{target}」。请先 snapshot 取编号再截。",
    "bsk.screenshot.onFailure": "（已自动截图：{path}）",
    // wheel / get-html（src/bsk/tools.ts 的 wheel 与 get_html 工具）
    "bsk.wheel.needDelta":
      "wheel 需要至少一个非 0 的增量：deltaY（向下为正）或 deltaX（向右为正）。两个都是 0 的滚轮事件没有意义。",
    "bsk.getHtml.refOnly":
      "get_html 的 target 只支持 @eN 引用（bsk 的 get-html 没有选择器入口），收到的是「{target}」。要按选择器取 DOM 请改用 evaluate。",
    "bsk.getHtml.unreadable":
      "读不到 HTML：bsk 返回的内容无法解析。请确认当前 bsk 版本支持 get-html 命令（`bsk get-html --help`）。",
    "bsk.getHtml.truncated":
      "（已按 maxBytes 截断：完整 HTML 有 {bytes} 字节，你看到的不是全部——要全文就传 out 落盘）",
    "bsk.getHtml.badBudget":
      "maxBytes 只接受 1–{max}（默认 16384）。更大范围的 HTML 请传 out 落盘，不要塞进上下文。",
    "bsk.screenshot.unavailable":
      "这次截图没成（bsk 报的原因：{reason}）。页面可能处于隐藏状态，或目标本身读不到——不要把它当成「已经留了证据」。",
    "log.sideOutputScreenshot": "截图: {path}",
    "reportHtml.screenshots": "截图",
    "reportHtml.screenshotMissing":
      "截图没有内联进报告（文件已不在，或体积超过 4MiB）：{path}",
    // 选择类控件（src/bsk/picker.ts + src/bsk/tools.ts 的 select_option / pick_date）
    "bsk.picker.noOverlay":
      "点开 {target} 之后没有等到可见的下拉浮层（它可能不是「点开出现浮层」型的下拉）。若它其实是普通输入框，请改用 fill；否则用 snapshot 看清页面后手动点选。",
    "bsk.picker.optionMissing": "浮层里没有可见文本为「{option}」的选项。",
    "bsk.picker.optionCandidates": "当前可选项：{list}",
    "bsk.picker.badDate":
      "无法理解日期「{spec}」。支持的写法：2026-09-29、2026/9/29、2026年9月29日，或 today / 今天 / +3 / -7。",
    "bsk.picker.noPanel":
      "点开 {target} 之后没有等到日期面板（它可能不是「点选日历」型的日期选择器）。若它允许直接输入，请用 fill 按页面要求的格式填入。",
    "bsk.picker.dayMissing":
      "日期面板里没能点到 {date}：它可能不在面板当前显示的月份里，或这一天被禁用。请先 snapshot 看清面板显示的月份。",
    "bsk.picker.confirmed": "（已点「确定」确认）",
    "bsk.picker.rangeNeedsEnd":
      "{target} 打开的是**日期范围**控件（面板里有左右两张日历表），只给一个日期会在页面上留下一个半截的范围。请把结束日期也传进 endDate，例如 date=\"2026-09-27\"、endDate=\"2026-09-29\"。",
    "bsk.picker.notRange":
      "{target} 打开的是**单日期**面板（只有一张日历表），不需要 endDate。如果页面上确实是「开始~结束」两个输入框，请把 target 指向范围控件的输入框，而不是其中某一个。",
    "bsk.picker.rangeOrder":
      "结束日期早于开始日期（{start} ~ {end}）：请检查用例里的顺序，这不是页面问题。",
    // 下载断言（src/bsk/tools.ts 的 download 工具 + src/downloads.ts）
    "bsk.download.expectation": "导出的文件已下载到本地",
    "bsk.download.expectationNamed": "下载的文件名匹配 {pattern}",
    "bsk.download.captured":
      "浏览器已捕获一次下载并落盘：{path}（{bytes} 字节{extra}）",
    "bsk.download.evidenceMime": "MIME {mime}",
    "bsk.download.evidenceDanger": "内容分级 {level}",
    "bsk.download.triggerError":
      "点不到下载的触发元素，这一步没能执行：{detail}（先重新 snapshot 拿到当前的 @eN 或修正选择器，再调用 download；它必须由本工具自己点击触发元素）",
    "bsk.download.notCaptured":
      "{seconds} 秒内没有捕获到任何下载事件：触发元素点了，但没有产生下载（导出请求没返回、被浏览器拦截，或点的元素本身不触发下载）。bsk 原始输出：{detail}",
    "bsk.download.captureNotReady":
      "。bsk 侧报的是「下载捕获未就绪」（daemon 刚重启/升级后常见，本工具已自动重试过一次）：重连一下 bsk 浏览器扩展、或稍等片刻再跑，通常即可恢复",
    "bsk.download.notWritten":
      "捕获到下载但文件没有落盘：{path}（bsk 报告下载成功，却读不到该文件——可能被移动/删除，或目录权限不足）",
    "bsk.download.empty":
      "捕获到的文件是 0 字节：{path}（导出内容可能为空，或下载中途被中断）",
    "bsk.download.nameMismatch":
      "下载的文件名不符合期望 {pattern}：实际是 {name}（文件已落盘：{path}）",
    "bsk.download.retrying":
      "[pageqa] download 首次没有捕获到下载，重试一次（最多再等 {seconds} 秒）：{detail}",
    "bsk.download.retried": "；首次点击未被捕获，重试一次后成功",
    "bsk.download.cleanupScheduled":
      "；按规则会在本次运行收尾时清理该文件（要留档就在用例里显式指定 out，或把配置项 downloadCleanup 设为 false）",
    "bsk.session.closed": "[pageqa] 已关闭 bsk session={session}（浏览器窗口已关闭）",
    "bsk.session.closeFailed":
      "[pageqa] 关闭 bsk session={session} 失败（不影响测试结论）：{msg}",

    // ── 交互模式（src/tui/app.ts）──
    "tui.title": "pageqa 交互模式",
    "tui.hint":
      "Enter 提交 · Shift+Enter 换行 · Esc 中止当前场景 · ↑↓/PgUp/PgDn 滚日志 · Ctrl+P 历史 · Ctrl+C 收工 · /help",
    "tui.help":
      "命令：\n  /status        查看运行队列\n  /run <文件>    加载一个已有用例文件（路径或文件名关键字）并加入运行队列\n  /new           开一个新会话（清空视口与运行队列；已跑过的场景仍会进退出报告与回放脚本）\n  /cancel <n>    取消一个尚未开始的待办（n 为队列编号）\n  /model         选择模型（Enter 即切换并设为启动默认）\n  /login         登录一个 provider（API Key 或订阅登录），凭据写入 ~/.pageqa/auth.json\n  /logout        移除某个 provider 的本地凭据\n  /proxy         查看/开关模型请求的代理路由（配置 ~/.pageqa/proxy.json）\n  /help          显示本帮助\n  /exit          收工（等同于 Ctrl+C）\n  /setting       修改设置（测试报告 / 回放脚本 / 语言），写入 ~/.pageqa/config.json\n键位：\n  Enter          提交输入（写了 `## 标题` 就是场景名，否则取首行摘要）\n  Shift+Enter    换行（写多场景用例时用）\n  Esc            中止当前场景，队列继续跑下一个\n  Ctrl+P/Ctrl+N  历史输入：上一条 / 下一条提交过的文本（↑/↓ 让给了日志滚动）\n  Ctrl+C         收工：中止当前 + 取消全部待办 → 还原终端 → 输出汇总报告（正常退出，不是硬杀）\n  Ctrl+C ×2      收尾期间再按一次：不再等队列停下，立刻收尾（报告照打）\n日志视口：\n  PageUp/PageDown   上下翻一页日志\n  ↑ / ↓             滚动日志（输入框为空时；有内容时它们是光标/历史）\n  Ctrl+↑ / Ctrl+↓   逐行滚动（任何时候都生效）\n  Home / End        跳到日志开头 / 回到末尾继续跟随\n  鼠标滚轮           滚动日志（一格 {wheel} 行）。有些终端会把滚轮当作 ↑/↓ 送来，走上面那条\n状态栏：运行进度（第几条/共几条、已耗时）· 待办数 · 当前模型 · 已写回数 · 落点\n输入框下方：本次会话的 token 消耗（⬇ 输入 / ⬆ 输出 / 读 缓存读 / 写 缓存写 / 总 合计 / 调用次数；末尾 `命中 n%` 是缓存命中率），每轮 LLM 调用后刷新",
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
    "tui.sceneStart": '场景 #{i}「{name}」{appended}',
    "tui.sceneEnd":
      '场景 #{i}「{name}」结束：{tag}（断言 {n} 条，耗时 {duration}）',
    "tui.sceneError": '场景 #{i}「{name}」执行出错：{msg}',
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
      "未知命令：/{cmd}（可用：/help /status /run <文件> /new /cancel <n> /model /login /logout /setting /proxy /exit）",
    "tui.languageSwitched": "界面语种已切换为 {locale}（已保存到配置）",
    "tui.languageSwitchFailed":
      "界面语种已切换为 {locale}（写入配置失败：{msg}）",
    "tui.run.usage":
      "用法：/run <用例文件路径或关键字>（如 /run examples/smoke.md、/run github-star）",
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
    "tui.cmd.setting": "修改设置（测试报告 / 回放脚本 / 语言）",
    "tui.cmd.proxy": "查看/开关模型请求的代理路由",
    "tui.cmd.exit": "收工（等同于 Ctrl+C）",

    // ── /proxy 面板 ──
    "tui.proxy.title": "模型请求代理 v{version} · {state}",
    "tui.proxy.state": "当前：{state} · 代理 {proxy} · 模式 {mode}",
    "tui.proxy.on": "生效中",
    "tui.proxy.off": "未生效",
    "tui.proxy.hint":
      "代理 {proxy} · 模式 {mode} · ↑↓ 选择 · Enter 执行 · Esc 关闭 · 配置 {path}",
    "tui.proxy.enable": "启用代理路由（写回配置）",
    "tui.proxy.disable": "关闭代理路由（写回配置）",
    "tui.proxy.bypass": "本次会话先全部直连（不写配置）",
    "tui.proxy.unbypass": "恢复按配置走（取消本次会话的直连）",
    "tui.proxy.reload": "重新加载配置文件",
    "tui.proxy.stats": "查看统计与规则",
    "tui.proxy.statsDesc": "打印到日志后关闭面板",
    "tui.proxy.saved": "代理路由已{state}，已写回 {path}",
    "tui.proxy.reloadOk": "已重新加载 {path}：{state} · 代理 {proxy} · 模式 {mode}",
    "tui.proxy.failed": "操作失败：{msg}",
    "tui.proxy.bypassed": "本次会话所有请求改为直连（配置未动）",
    "tui.proxy.unbypassed": "已恢复按配置路由（{state} · 代理 {proxy}）",
    "tui.proxy.statsLine":
      "直连 {direct} · 走代理 {proxy} · 兜底 {fallback}（其中改走代理 {fallbackHit}）",
    "tui.proxy.rulesTitle": "规则（自上而下，第一条命中者胜）：",
    "tui.proxy.envOverride": "环境变量优先级高于本文件（PAGEQA_PROXY_URL / _ENABLED / _MODE）",

    // ── /setting 面板 ──
    "tui.setting.title": "设置 v{version}",
    "tui.setting.report": "测试报告（HTML）",
    "tui.setting.replayScript": "回放脚本",
    "tui.setting.locale": "语言",
    "tui.setting.on": "开",
    "tui.setting.off": "关",
    "tui.setting.hint": "↑↓ 选择 · Enter 切换 · Esc 关闭 · 配置: {path}",
    "tui.setting.saved": "已更新：{name} = {value}",
    "tui.setting.failed": "写入配置失败：{msg}",
    "tui.setting.concurrency": "并发量",
    "tui.setting.concurrencyTitle": "同时跑几个场景（↑↓ 选择 · Enter 确认 · Esc 取消）",
    "tui.setting.concurrencyOne": "1 个（逐个跑，默认）",
    "tui.setting.concurrencyMany": "{n} 个（同时最多 {n} 个，也就是 {n} 个浏览器窗口）",
    "tui.setting.concurrencyCurrent": "· 当前",
    "tui.setting.concurrencySaved":
      "并发量已设为 {n}：之后派发的场景立刻生效，并已写回 {path}",

    // ── 模型切换与登录 ──
    "tui.model.status": "模型 {model}",
    "tui.model.title": "选择模型（当前 {current}）",
    "tui.model.loading": "正在准备模型列表…",
    "tui.model.hint": "↑↓ 选择 · Enter 使用并设为启动默认 · Esc 取消",
    "tui.model.badgeCurrent": "当前",
    "tui.model.badgeDefault": "默认",
    "tui.model.badgeFree": "免费",
    "tui.select.hint": "↑↓ 选择 · Enter 确认 · Esc 取消",
    "tui.select.searchHint": "输入关键字可实时过滤",
    "tui.select.searchPlaceholder": "输入关键字过滤…",
    "tui.select.noMatch": "没有匹配的项",
    "tui.model.fallback":
      "启动默认模型 {provider}/{model} 当前不可用（provider 未登录或模型已下线），已退回并改用 {next}；{healed} 可用 /model 重新选择",
    "tui.model.fallbackHealed": "config.json 已同步更新，下次启动不再警告。",
    "tui.model.fallbackKept":
      "config.json 没能写入，下次启动仍会警告一次。",
    "tui.model.applied":
      "已切换为 {provider}/{model} 并设为启动默认（写入 {path}，下次启动生效；后续场景生效，正在跑的场景不受影响）",
    "tui.model.envOverride":
      "注意：本次仍由环境变量 PAGEQA_LLM_MODEL / PAGEQA_LLM_PROVIDER 决定——它们的优先级高于 config.json，去掉后上面这个默认才生效。",
    "tui.model.saveDefaultFailed":
      "本次会话已切到 {provider}/{model}，但没能写入启动默认（{msg}）：下次启动仍用旧的。",
    "tui.model.switchFailed": "切换模型失败：{provider}/{model} 未在模型目录中",
    "tui.model.empty":
      "没有可用模型：自定义端点未配置，且没有任何已登录的 provider。请先用 /login 登录。",
    "tui.model.loadFailed": "加载模型列表失败：{msg}",
    "tui.model.expectation": "模型可连通（不通则不执行用例）",
    "tui.model.stopRun":
      "已停止执行剩余 {n} 个场景：模型不通时继续跑，只会把一次配置错误摊成一堆「用例失败」，每个还要白开一次浏览器。",
    "tui.model.stopNote": "模型不可达，已停止执行",
    "tui.env.expectation": "浏览器环境可用（不可用则不执行用例）",
    "tui.env.stopNote": "浏览器环境不可用，已停止执行",
    "tui.env.stopRun":
      "已停止执行剩余 {n} 个场景：浏览器环境跑不起来时继续跑，只会得到一堆同样的失败。",
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
    "tui.login.stepPrepare": "正在准备浏览器登录…",
    "tui.login.stepExchange": "已收到回调，正在换取访问令牌…",
    "tui.login.stepDone": "授权成功，正在写入凭据…",
    "tui.login.errCallbackTimeout":
      "5 分钟内没有收到浏览器回调。若浏览器不在这台机器上（容器 / 虚拟机），请改用 API Key 登录",
    "tui.login.errDeviceTimeout": "设备码已过期，请重新登录",
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
    "tui.abortingCurrent": "正在中止 {n} 个在跑的场景…",
    "tui.cancelledWaiting": "已取消 {n} 个未开始的待办",
    "tui.abortTimeout":
      "中止超时，强制收尾（该场景的报告可能缺失）",
    "tui.abortScene":
      "已请求中止 {n} 个在跑的场景（{names}），剩余步骤不再执行",
    "tui.enterHint":
      "输入一段自然语言用例并回车即可追加场景（有落点时写回该文件）；/run <用例文件> 加载已有用例；/help 查看命令。",
    "tui.interactiveStart": "交互模式：{n} 个初始场景已入队",
    "tui.sourceFile": "源用例文件：{path}（追加场景会写回这里）",
    "tui.running": "运行中 {i}/{n}（{duration}）",
    "tui.runningMany": "运行中 {n} 个 · 最早「{name}」已跑 {duration}",
    "tui.usage.cacheHit": "命中 {pct}%",
    // 当前上下文长度：正在跑的场景**最近一轮**喂给模型的 token 数（input + 缓存读 + 缓存写），
    // 对照当前模型的上下文窗口显示占比——快满时用户能提前看出「为什么模型开始忘事」。
    "tui.usage.context": "上下文 {used}/{total}（{pct}%）",
    "tui.usage.contextNoWindow": "上下文 {used}",
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
    "report.usage.replay": "Token: 未调用大模型（回放模式）",
    "report.usage.unavailable": "Token: 不可用（未采集到用量）",
    // 用量行压到最短：`⬇` = 输入（喂进模型的）、`⬆` = 输出，`读`/`写` = 缓存读/缓存写。
    // 位置是固定的（输入 · 输出 · 读 · 写 · 总），所以省掉「输入/输出」四个字也不会串味；
    // 顺序本身就是图例，别为了「更清楚」把它改回长标签——那正是这行要甩掉的重量。
    "report.usage.line":
      "Token: ⬇ {in} / ⬆ {out} / 读 {cr} / 写 {cw} / 总 {total}（LLM 调用 {calls} 次）",
    "report.usage.noUsage": "（端点未返回 usage）",
    "report.assertIncomplete":
      "用例中的断言全部执行（实际 {got}/{expected}）",
    "report.assertIncompleteEvidence1":
      "解析到的断言少于用例声明的数量：可能某条「断言」仅被 snapshot 肉眼确认、未真正调用 assert_text/download 工具，导致该断言未被工具记录（步骤本身可能已跑完）",
    "report.assertIncompleteEvidence2": "最后进展：{note}",
    "report.assertNotRun":
      "断言由工具执行（用例声明 {expected} 条，工具记录 0 条）",
    "report.assertNotRunEvidence1":
      "这次运行没有任何 assert_text/download 的结构化结果：正文里写的「成立」不算执行过（模型可能把工具调用写成了文本伪代码，浏览器其实一步没动）",
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

    // ── 耗时构成（src/timing.ts）：一次运行的墙钟花在哪了。写进日志，不进 stdout 报告 ──
    "timing.title": "耗时构成（墙钟 {wall}）",
    "timing.llm": "  LLM 调用 {calls} 次，{total}（{pct}%），平均 {avg}",
    "timing.commands":
      "  工具调用 {calls} 次，{total}（{pct}%），平均 {avg}{errors}",
    "timing.commands.errors": "，其中失败 {errors} 次",
    "timing.commandLine": "    {name} {calls} 次  {total}  平均 {avg}{errors}",
    "timing.commandLine.errors": "  失败 {errors} 次",
    "timing.commandRest": "    （另有 {n} 种更快的工具未列出）",
    "timing.other": "  其它（编排/等待/收尾）{total}（{pct}%）",
    "timing.tokens":
      "  token：输入 {input}，输出 {output}，缓存读取 {cache}（以上 {calls} 次调用合计）",
    "report.suiteSummaryBase": "共 {n} 个场景，通过 {passed} 个",
    "report.suiteSummaryCancelled": "，已取消 {cancelled} 个",
    // 异常终止的归因（`ScenarioDetail.reason`）在人读报告里的说法（见 ADR-0013 决策七）。
    "report.reason.crash": "子进程异常结束（{how}），本场景没有跑完",
    "report.reason.timeout":
      "超过 {sec} 秒的场景级上限，已终止子进程",
    "report.reason.infrastructure": "环境不可用（{msg}），本场景没有执行",
    "report.cancelEnvGone": "环境不可用，本场景没有执行",

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
    "reportHtml.pageTitle": "页面测试报告",
    "reportHtml.pageTitleSuite": "页面测试套件报告",
    "reportHtml.detail": "用例明细",
    // ── 本次产物清单（src/side-outputs.ts；三条出口收尾各打一次，只走 stderr）──
    "log.sideOutputsTitle": "[pageqa] 本次产物：",
    "log.sideOutputReport": "[pageqa]   测试报告: {path}",
    "log.sideOutputReportOff":
      "[pageqa]   测试报告: 未生成（/setting 中已关闭）",
    "log.sideOutputReportOffFlag":
      "[pageqa]   测试报告: 未生成（--no-side-outputs 已禁用）",
    "log.sideOutputReportSkipped":
      "[pageqa]   测试报告: 未生成（本次没有执行任何用例）",
    "log.sideOutputReportFailed": "[pageqa]   测试报告: 写入失败（{msg}）",
    "log.sideOutputScript": "[pageqa]   回放脚本: {path}",
    "log.sideOutputScriptOff":
      "[pageqa]   回放脚本: 未生成（/setting 中已关闭）",
    "log.sideOutputScriptOffFlag":
      "[pageqa]   回放脚本: 未生成（--no-side-outputs 已禁用）",
    "log.sideOutputScriptNone":
      "[pageqa]   回放脚本: 未生成（本次没有可回放的动作）",
    "log.sideOutputScriptNoTarget":
      "[pageqa]   回放脚本: 未生成（{n} 个场景没有落点文件）",
    "log.sideOutputScriptFailed": "[pageqa]   回放脚本: 写入失败（{msg}）",
    "log.sideOutputReplay": "[pageqa]   回放方式: pageqa --replay {path}",
    "log.sideOutputReplayMany":
      "[pageqa]   回放方式: pageqa --replay <上面任一份脚本路径>",
    "log.sideOutputDownload": "[pageqa]   下载产物: {path}",
    "log.sideOutputDownloadCleaned":
      "[pageqa]   下载产物: {path}（断言成立后已清理）",

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
  pageqa sessions [--port <n>] [--dir <path>]
                   起本地存档查询服务，浏览器打开即可回看每次运行交给了模型什么

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
  --concurrency <n>
                   同时跑几个场景（**上限**，默认 1 = 逐个跑；也可用 PAGEQA_CONCURRENCY）
                   并行等于声明「这些场景互不依赖」，所以默认不开：串行是
                   「创建 → 编辑 → 删除」这类隐含顺序依赖的保护
                   代价是同时开着 n 个浏览器窗口（一个场景一个 session 一个窗口）
                   最大 8，超过直接报错（不静默截断）
                   交互模式也认它：这个值只是本次会话的起点，进去之后用
                   /setting 里的「并发量」随时改（改完立刻生效并写回配置）
                   --replay 不走场景调度器，并发对回放没有意义
  --only <序号|标题>
                   只跑其中一个场景（被「## 场景名」分隔出来的那一个）
                  序号从 1 起；不是纯数字时按场景标题**精确**匹配（大小写不敏感）
                  匹配不到会报错并列出全部场景标题；刻意不做模糊匹配
                  输出仍是一份套件形态的报告（只有一个场景），便于 CI 统一解析
                  不能与 --suite / --tui / --replay 同时使用
  --tui            强制进入交互模式（默认在交互式终端下自动进入，见下方「交互模式」）
  --no-tui         不要交互模式（只想看滚动日志、或排障时用）
                  也可用环境变量关闭：PAGEQA_NO_TUI=1
  --emit-script [path]
                   把本次成功的操作序列固化成回放脚本（Replay Script）
                  这一项**默认就会生成**（可在交互模式 /setting 里关掉；显式给出本选项永远优先）
                  不给 path 时贴着源用例写：examples/smoke.md → examples/smoke.replay.json
                  没有源文件（内联文本、无落点的追加场景）则不生成，收尾的产物清单会说明原因
                  path 建议写成路径形式（如 ./replay、reports/run1.json），
                  含空白请用引号包裹；紧跟其后的若是 .md/.txt 或含空白的文本，
                  会被当作用例输入而不是输出路径
                  无论 PASS/FAIL 都会生成，便于排查与续写
  --replay <file>  零模型回放已有的回放脚本（详见下方「回放脚本」）
  --semantic       回放时断言改用 Jev 语义判断（默认字符串包含）
  --init-config    在用户目录创建/重置配置文件
  --out <file>     将报告写入文件
  --no-side-outputs
                   不写旁路产物：既不生成 HTML 测试报告，也不默认生成回放脚本
                   stdout 上的报告与退出码不受影响（CI 只取 stdout 时用）
                   显式给出的 --emit-script <path> 仍然生效（显式请求优先）
  --usage-stream   把 LLM 用量的结构化记录逐次打到 stderr（一行一次，前缀 [pageqa:usage]）
                   场景在独立子进程里执行时，父进程靠它把「已经烧了多少」实时带回来
  --no-lint        跳过「跑用例前的格式预检」（默认开；预检只在 stderr 提示、不拦执行）
                   想把它设成门槛：pageqa lint <用例文件>
  --debug          显示调试日志（bsk 命令、快照体积、上下文裁剪、Jev 请求详情）
  -v, --version    显示版本号
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
  /model        选择模型（Enter 即切换并写回 config.json，作为下次启动的默认）
  /login        登录一个 provider（API Key 或订阅登录），凭据存到 ~/.pageqa/auth.json
  /logout       移除某个 provider 的本地凭据
  /setting      修改设置（测试报告 / 回放脚本 / 语言），写回 ~/.pageqa/config.json
  /proxy        查看/开关模型请求的代理路由（配置在 ~/.pageqa/proxy.json）
  /help /exit

模型请求的代理:
  - 模型端点直连不通时，按 ~/.pageqa/proxy.json 的规则决定走哪条路：direct（直连）、
    proxy（走代理）、fallback（先直连、网络层失败再走代理，默认）。
  - 默认规则是「本机与内网直连 + 其余先直连后代理」，因此本机端点（127.0.0.1 上的
    兼容端点、bsk daemon）不受影响，墙外的模型端点自动改走代理。
  - 改地址与开关：编辑 ~/.pageqa/proxy.json（pageqa --init-config 可生成一份），
    或用环境变量 PAGEQA_PROXY_URL / PAGEQA_PROXY_ENABLED / PAGEQA_PROXY_MODE 临时覆盖
    （环境变量优先）；交互模式里 /proxy 面板可随时开关并查看统计与规则。
  - --debug 会在启动时打一行当前代理状态。

模型切换与登录:
  - /model 列出「已配好鉴权」的模型：自定义端点（config.json 的 baseUrl/apiKey/model）
    总是可用；内置 provider（anthropic / openai / deepseek / github-copilot …）只有
    在 /login 过、或设置了对应环境变量（如 ANTHROPIC_API_KEY）之后才会出现。
  - /model 按 Enter 选中即写回 config.json 的 modelProvider/model：既切换本次会话，
    也成为下次启动的默认。两者是同一个动作，不再分开（ADR-0015）。
  - 切换模型不会打断正在执行的场景：当前场景沿用开跑时的模型，下一个场景才用新模型。

  - 提交的场景会**立即追加写回源用例文件**（原文原样保留，含运行时占位符），
    因此「pageqa --tui examples/smoke.md」会改动该文件。
  - 场景串行执行，且**每个场景跑在自己的子进程里**（见 docs/adr/0013）：
    某个场景把浏览器或 bsk daemon 搞崩时只影响它自己，后面的场景照跑。
    父进程持有 session 与浏览器窗口的生命周期，轮到某个场景时才为它创建。
  - 不能与 --json / --replay / --session 同时使用（前两个要独占 stdout 或无需等待，
    第三个与「场景各有独立 session」冲突）。
  - 回放脚本默认生成：退出时把跑过的场景按来源写成脚本，已取消的场景不含在内；
    可在 /setting 里关掉，或用显式 --emit-script（可带路径）强制生成。
  - 测试报告与回放脚本都是「旁路产物」：只落盘、不进 stdout，路径在收尾的产物清单里。

回放脚本（零模型重跑同一用例）:
  pageqa --replay <file.replay.json> [--session <id>] [--json] [--semantic] [--fail-fast] [--settle-waits] [--locate-timeout <ms>]
                  按脚本逐步驱动浏览器，**不调用任何大模型**，断言默认走字符串包含
                  --semantic 可改用 Jev 语义判断（需已在配置里启用 Jev）
                  元素定位用录制时的语义定位符在当次快照里重新解析，
                  因此页面小幅调整后脚本仍可命中；源用例变更会在 stderr 提示
                  --fail-fast 任一失败即停止该场景；默认会跑完剩余步骤，
                  以便一次拿到整条用例的完整健康报告（失败仍会让退出码非零）
                  --locate-timeout <ms> 定位符**所在区域整体缺失**（页面还没渲染到那一步）时，
                  等页面就绪的上限，默认 8000ms，0 = 不等。只在区域一起缺失时等：区域在、
                  或区域是没打开的浮层时立刻判定，所以「元素真的不存在」不会被拖慢
                   --settle-waits 把 wait 步骤执行成「等页面稳定，上限为脚本记下的毫秒数」：
                   录制时的固定等待（如 wait 2000）只是模型当时的猜测，回放里却每次都照付；
                   打开后页面一稳定就继续，通常在跳转/弹窗类等待上明显更快。默认关闭，
                   因为「为页面之外的事情留的等待」（服务端正在生成导出文件等）会被提前放行，
                   紧随其后的断言/下载可能因此失败——轨迹里的 wait 行会写出实际等待时长

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
    /model 的选择会自动写回 config.json 作为启动默认（也可直接编辑上述字段）
  - 关闭端点思考：混元/DeepSeek/Qwen 这类混合推理模型默认开着思考，模型会先吐一大段
    思考内容（慢、烧 token、还搅乱步骤编号）。**默认就关**：按模型 id 自动判断该端点认哪个
    关闭字段，每次请求都带上；不要这个行为就设 thinkingFormat=none。
      PAGEQA_LLM_THINKING_FORMAT=deepseek   发送 thinking: {"type": "disabled"}
      PAGEQA_LLM_THINKING_FORMAT=qwen       发送 enable_thinking: false
      PAGEQA_LLM_THINKING_FORMAT=zai|together|openrouter|string-thinking|qwen-chat-template
                                            同样可用，取值见 README
      PAGEQA_LLM_THINKING_FORMAT=none       不发任何思考开关（端点用它自己的默认）
      （openai / ant-ling / baseten 发不出关闭开关，配了等于没配；端点若不认某个字段，
        探活会自动去掉它并降级，不会把本来能用的端点弄坏）
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
  pageqa sessions                       # 回看历史运行的参数与工具调用（Ctrl+C 退出）
  pageqa lint examples/smoke-test.md    # 静态校验用例格式（不开浏览器、不调模型）
`,
    "help.sessions": `pageqa sessions - 本地存档查询服务

用法:
  pageqa sessions [选项]

起一个只监听 127.0.0.1 的本地服务，浏览器打开即可回看每次 agent 运行：
  - 交给模型的参数：系统提示词、模型、工具声明（含 schema）、编号后的用例
  - 每轮实际发出的上下文：模型这一轮到底看到了什么、有没有被裁剪
  - 每次工具调用的入参、结果、耗时与成败

选项:
  --port <n>   监听端口（默认 7331；被占用时自动向上顺延）
  --dir <path> 存档目录（默认 ~/.pageqa/sessions）
  --no-open    不自动打开浏览器
  -h, --help   显示本帮助

存档由每次运行自动写入（~/.pageqa/sessions/sessions.sqlite，SQLite 单容器，走 pi 的
session 后端），不需要额外开关；它落在用户目录而不是工作目录，也不会被
--no-side-outputs 关掉——它是排查工具，不是测试产物。默认只保留最近 200 次运行。

注：早期版本按「一次运行两个 JSON 文件」写在 ~/.pageqa/sessions/*.json 的存档不再读取
（换存储格式时不做迁移），需要的话手动删掉即可。
`,

    // ── 用例格式校验（src/lint.ts；`pageqa lint` 与跑用例前的预检共用）──
    "help.lint": `pageqa lint - 用例格式静态校验

用法:
  pageqa lint <用例文件…> [选项]

只读用例文本，**不开浏览器、不调模型**，秒级指出「第几行、哪条规则、为什么」。
它检查的是运行时真正在意的那几条格式约定（场景分隔、一个非空行 = 一步、
一条断言 = 一次断言工具调用），用的是与运行时同一份口径，因此不会出现
「lint 说没事、一跑报断言不足」。

选项:
  --json        以 JSON 输出（stdout 只有结果，便于接 CI）
  --strict      告警（warn）也算失败，退出码非零
  --locale <l>  显示语种 zh|en
  -h, --help    显示本帮助

级别:
  error  会让用例跑错或跑不动（「## 」之前的正文被丢弃、空场景、重名场景、
         @e 快照编号、URL 缺协议、未知占位符、上传非绝对路径）
  warn   只是写法不统一（固定等待、下拉框写成填写、下载又单写一行断言、
         说明性文字被当成步骤、场景没有断言）

退出码:
  0  没有 error（--strict 时连 warn 也没有）
  1  有 error（或 --strict 下有 warn）、参数/文件有问题

每次跑用例之前也会自动做一次同样的预检（只提示、不拦），加 --no-lint 可跳过。
`,
    "err.lintNeedsFile": "lint 需要一个用例文件路径",
    "err.lintNotFound": "找不到文件：{path}",
    "err.lintDir": "lint 只接受用例文件，不接受目录：{path}",
    "err.noLintWithReplay": "--replay 与 --no-lint 不能同时使用",
    "lint.header": "用例格式校验：{path}",
    "lint.headerInline": "用例格式校验：（内联文本）",
    "lint.counts":
      "场景 {scenarios} 个 · 步骤 {steps} 步 · 断言 {assertions} 条 · 下载 {downloads} 处",
    "lint.clean": "未发现格式问题",
    "lint.line": "  第 {line} 行 [{rule}] {message}",
    "lint.lineScenario": "  第 {line} 行 [{rule}]（场景：{scenario}）{message}",
    "lint.text": "      {text}",
    "lint.more": "  …另有 {n} 条问题未展开（去掉截断即可看全）",
    "lint.total": "共 {errors} 个错误 / {warnings} 个告警",
    "lint.preflightClean":
      "用例格式预检通过（{scenarios} 个场景 · {steps} 步 · {assertions} 条断言）",
    "lint.hint":
      "预检只提示、不拦执行；查看全部并把格式设成门槛：pageqa lint <用例文件>",
    "lint.rule.preambleText":
      "`## ` 之前的正文会被整体丢弃（开场说明、前置条件都算），请改写成 `>` 注释行",
    "lint.rule.emptyScenario":
      "该场景没有任何有效步骤（只有空行或注释），运行时会被静默丢弃",
    "lint.rule.duplicateScenario":
      "场景标题重复：`--only <标题>` 无法区分，报告里也分不清是哪一个",
    "lint.rule.snapshotRef":
      "出现快照编号 @eN：它只在产生它的那一次快照里有效，下一个动作就失效，回放更无从谈起；请用可见文本或 CSS 选择器定位",
    "lint.rule.urlScheme": "`打开` 后面的地址必须完整含 http/https",
    "lint.rule.unknownPlaceholder":
      "未知占位符：会被原样保留、静默失效（可用 ${timestamp} / ${date} / ${time} / ${datetime}，也可带自定义格式）",
    "lint.rule.uploadPath":
      "上传要给出本地文件的「绝对」路径（如 D:\\\\data\\\\a.xlsx）：相对路径在 bsk 侧会解析失败",
    "lint.rule.hardWait":
      "等页面内的变化请写条件等待（`等到页面出现「…」`）；`等待 N 秒` 只留给页面之外的等待",
    "lint.rule.selectAsFill":
      "下拉框不是文本框：请写「在下拉框中选择 X」（或直接点名 select_option），不要写「填写/填入」",
    "lint.rule.downloadExtraAssert":
      "下载本身就算一条断言，不要再单写一行「断言文件名…」——那会让期望断言数多一条，收尾报「断言数不足」的假失败",
    "lint.rule.vagueAssertion":
      "这条断言没有可字面匹配的文本：断言工具只做字面包含，模型只能先去快照里读一个当前值再拿它当期望（这条断言于是永远成立），而且这个值会被录进回放脚本、数据一变就假失败。请写页面上真实印着、且不随数据变化的文本（表头、字段 label、按钮文案）",
    "lint.rule.proseStep":
      "这行看起来是说明性文字而不是操作步骤：说明请写成 `>` 引用行，否则模型会把它当成一步去执行",
    "lint.rule.noAssertion":
      "该场景没有任何断言行（也没有下载捕获）：跑完没有判定依据，结论只能靠文本关键字猜",
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
    // thinking mode (hybrid reasoning models such as Hunyuan / DeepSeek / Qwen default to thinking on)
    "log.thinkingAuto":
      "model thinking: disabled by default (model {model} looks like the {format} family; every request sends {field}; if the endpoint rejects it, the probe falls back automatically)",
    "log.thinkingOff":
      "model thinking: disabled (thinkingFormat={format}; every request sends {field})",
    "log.thinkingOffNoop":
      "model thinking: thinkingFormat={format} cannot send an off-switch (it only adds a field when a thinking level is requested), so the endpoint keeps its own default",
    "log.thinkingBad":
      'model thinking: unknown thinkingFormat "{value}"; falling back to the default (auto-detect) (accepted: {list})',
    "log.thinkingOffExplicit":
      "model thinking: NOT disabled by config (thinkingFormat=none); requests carry no thinking switch, the endpoint keeps its own default",
    "log.thinkingDowngraded":
      "model thinking: this endpoint rejects the thinking-off field ({field}); it was removed and will not be sent again in this process. Set thinkingFormat=none to make that permanent",
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
    "log.wroteBackScenarios":
      "[pageqa] wrote back {n} appended scenario(s) to {path}",
    "log.lostScenarios":
      "[pageqa] {n} appended scenario(s) had no write-back target and were not written to any file (they are gone once you exit)",
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
    "log.modelOutputStart": "[pageqa] model is outputting (turn {n})…",
    "log.modelOutputEnd": "[pageqa] turn {n} model output finished",
    "log.toolEnd":
      "[pageqa] {mark} #{n} {tool}{reason}{retry} {cost}ms",
    "log.cancelledBeforeStart":
      "[pageqa] this scenario was cancelled before it started, skipping",
    "log.caseSubmitted":
      "[pageqa] case submitted, waiting for model and browser to execute…",
    "log.continuation":
      "[pageqa] incomplete execution (steps or assertions not finished), initiating retry #{n} (progress {progress}, assertions {a}/{b})",
    "log.caseEnd":
      "[pageqa] case ended: {status}, {n} assertions, elapsed {dur}s",
    // ── session archive & query server (src/session-archive.ts / src/session-server.ts) ──
    "log.sessionArchived":
      "[pageqa] session archive written: {id} (run `pageqa sessions` to review what was handed to the model)",
    "log.sessionArchiveFailed":
      "[pageqa] failed to write the session archive (does not affect the test verdict): {msg}",
    "log.sessionServing": "[pageqa] session query server started: {url}",
    "log.sessionArchiveDir": "[pageqa] archive container: {dir}",
    "log.sessionArchiveEmpty":
      "[pageqa] no runs archived yet — run a case first, then come back",
    "sessions.pageTitle": "pageqa run archive",
    "sessions.heading": "pageqa run archive",
    "sessions.subtitle":
      "the parameters handed to the agent, per-turn context and every tool call",
    "sessions.empty":
      "No runs archived yet. Run a test and the scene it left behind shows up here.",
    "sessions.colTime": "time",
    "sessions.colCase": "case",
    "sessions.colScenario": "scenario",
    "sessions.colModel": "model",
    "sessions.colStatus": "status",
    "sessions.colSteps": "steps",
    "sessions.colTools": "tool calls",
    "sessions.colTurns": "turns",
    "sessions.detailSubtitle": "run {id}",
    "sessions.detailParams": "parameters handed to the agent",
    "sessions.detailSystemPrompt": "system prompt",
    "sessions.detailCase": "case text",
    "sessions.detailPrompt": "first prompt sent (steps numbered)",
    "sessions.detailTools": "tool declarations ({n})",
    "sessions.detailVars": "placeholder values",
    "sessions.detailTurns": "LLM turns",
    "sessions.detailContextCount": "context: {n} message(s)",
    "sessions.detailToolCalls": "tool calls",
    "sessions.detailArgs": "arguments",
    "sessions.detailResult": "result",
    "sessions.detailUsage": "usage",
    "sessions.detailTime": "time",
    "sessions.detailModel": "model",
    "sessions.detailBskSession": "bsk session",
    "sessions.detailScenario": "scenario",
    "sessions.detailNote": "cause",
    "sessions.detailTruncated": "(truncated; {chars} chars originally)",
    "sessions.detailNotFound": "run not found (the archive may have been pruned)",
    "sessions.turn": "turn {n}",
    "sessions.raw": "JSON",
    "err.sessionsListenFailed":
      "[pageqa] the session query server could not listen on a port: {msg}",
    "err.portRequired": "--port needs a port number",
    "err.portInvalid": "--port only accepts an integer between 1 and 65535",
    "err.dirRequired": "--dir needs a directory path",
    "log.suiteStart": "[pageqa] suite has {n} scenario(s): {names}",
    "log.suiteScenario":
      "[pageqa] ═══ scenario {i}/{n}: {name} ═══",
    "log.suiteScenarioEnd":
      "[pageqa] ═══ scenario {i}/{n} ended: {status} ═══",
    // ── suite child-process orchestration (src/suite.ts, see ADR-0013) ──
    "log.suiteChildProbe":
      "[pageqa] scenario {i}/{n} produced no report; re-checking the model and browser environment…",
    "log.suiteChildTimeout":
      "[pageqa] scenario {i}/{n} exceeded the {sec}s per-scenario limit; the child was killed and recorded as failed, moving on to the next scenario",
    "log.suiteChildCrash":
      "[pageqa] scenario {i}/{n} child process ended abnormally ({how}); recorded as failed, moving on to the next scenario",
    "log.suiteInfraGone":
      "[pageqa] environment unavailable ({msg}): {done} scenario(s) done, no new scenario will start",
    "log.suiteModelGone":
      "[pageqa] model unreachable: {done} scenario(s) done, no new scenario will start",
    "log.suiteParallel":
      "[pageqa] concurrency limit {n}: up to {n} scenarios run at once, each with its own child process and browser window",
    "log.onlySelected":
      "[pageqa] --only {selector} → running only scenario {i}/{n} \"{name}\"",
    "log.sideOutputsOff":
      "[pageqa] side outputs disabled: no HTML report, and no default replay script",
    "log.undeclared": "undeclared",

    // ── CLI errors ──
    "err.sessionRequired": "--session needs a session id argument",
    "err.modelNotFound":
      "model {provider}/{model} not found: the provider is not registered or the model id does not exist.\n  In interactive mode use /model to pick again (or /login to sign in a provider); in batch mode check the modelProvider and model fields in ~/.pageqa/config.json.",
    "err.localeRequired": "{arg} needs a locale argument (zh or en)",
    "err.modelUnreachable": "model unreachable: {provider}/{model}: {msg}",
    "err.modelUnreachableHint":
      "no scenario was executed. Fix the endpoint and retry: in interactive mode use /model to pick another model (or /login to sign in a provider); in batch mode check baseUrl and apiKey in ~/.pageqa/config.json (a stopped local proxy looks exactly like this).",
    "err.modelUnreachableHintMid":
      "the suite had already run {done} scenario(s); the rest are recorded as \"cancelled\". The report above covers what did run (exit code 1) — re-run the cancelled scenarios individually with --only once the endpoint is fixed.",
    "err.childEntryMissing":
      "internal error: the child-process entry script was not found ({path}), so scenarios cannot be run in separate processes. If you are running from source, build first (npm run build); see ADR-0013",
    "err.envUnavailable":
      "environment unavailable ({msg}): the browser environment cannot run, so remaining scenarios are skipped",
    "err.modelProbeTimeout": "the probe got no response within {ms} ms",
    "err.modelProbeNoReason": "the endpoint reported no failure reason",
    "err.outRequired": "--out needs a file path argument",
    "err.onlyRequired":
      "--only needs a scenario identifier: an index, or the exact scenario title",
    "err.onlyNotFound":
      "no scenario matches \"{selector}\": this case has {n} scenario(s) (indexes 1-{n}) titled {names}",
    "err.onlyNeedsScenarios":
      "argument error: --only needs a case split by \"## title\". A case with a single scenario is already just that scenario",
    "err.onlyWithSuite":
      "argument error: --only cannot be used with --suite (--only already means \"run just this one scenario\")",
    "err.onlyWithTui":
      "--only cannot be used with --tui (--only is a batch-mode option; interactive mode runs the whole case file)",
    "err.onlyWithReplay":
      "argument error: --only cannot be used with --replay (replay walks the script's scenarios in order)",
    "err.concurrencyRequired":
      "--concurrency needs a positive integer (how many scenarios to run at once)",
    "err.concurrencyInvalid":
      "--concurrency accepts a positive integer only, got \"{value}\"",
    "err.locateTimeoutRequired":
      "--locate-timeout needs a millisecond value (0 = do not wait for the page, judge \"element not found\" at once)",
    "err.locateTimeoutInvalid":
      "--locate-timeout accepts a non-negative integer (ms) only, got \"{value}\"",
    "err.concurrencyMax":
      "argument error: --concurrency is capped at {max}, got {n}. Concurrency costs the same number of simultaneously open browser windows (one scenario, one session, one window), so this is not silently clamped",

    "err.concurrencyWithReplay":
      "argument error: --concurrency cannot be used with --replay (replay is zero-model and walks the script in order; it never uses the scenario scheduler)",
    "err.concurrencyWithSession":
      "argument error: --concurrency={n} cannot be used with --session. Concurrency assumes one session (and one browser window) per scenario, while --session makes every scenario share a single session: they would navigate away from each other (and still produce PASS/FAIL, just from another page), and bsk would reject the overlap with session_busy and turn it into a pile of false failures. Drop --session, or set concurrency to 1",
    "err.replayRequired": "--replay needs a replay script path",
    "err.unknownOption":
      "unknown option: {a} (see --help for all options; if the case text starts with -, put it after --)",
    "err.extraPositional":
      "extra positional argument: {a} (only one case input is accepted; quote paths with spaces, put the output path after --emit-script)",
    // One prefix for two paths: `args.error` and `detectInteractive().error` both get wrapped here,
    // so those messages must NOT carry "argument error:" themselves (it would print twice — that
    // really happened for err.concurrencyInvalid / err.onlyWithTui). Messages written straight to
    // stderr (err.concurrencyMax, err.onlyWithReplay, err.concurrencyWithSession, …) keep their own.
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
    "config.proxyCreated":
      "proxy config created (editable: proxy URL / master switch / domain rules): {path}",
    "config.proxyExists": "proxy config already exists (left untouched): {path}",
    "log.proxyOn":
      "[proxy] routing installed: {proxy} · mode {mode} · {rules} rule(s) (config {path})",
    "log.proxyOff":
      "[proxy] routing inactive ({reason}); every request goes direct (config {path})",

    // ── replay script (src/replay.ts) ──
    "replay.err.notFound": "replay script not found: {path}",
    "replay.err.invalidJson": "replay script is not valid JSON: {path} ({msg})",
    "replay.err.badFormat": "not a pageqa replay script (format={format}): {path}",
    "replay.err.badVersion":
      "unsupported replay script version (script v{version}, supported up to v{supported}): {path}",
    "replay.err.noScenarios": "replay script has no executable scenarios: {path}",
    "replay.err.empty":
      "replay script contains no executable steps (the model performed no successful browser operations during recording): {path}\nrun the natural-language case to passing first, then regenerate with --emit-script.",
    "replay.err.badStepKind":
      "replay script contains an unsupported step kind ({kind}): {path}\n  - if the script was written by a newer pageqa, upgrade pageqa to the same version",
    "replay.err.badWaitFor":
      "a wait_for step in the replay script must carry exactly one condition (text / selector / gone): {path}",
    "replay.err.pressNoKey":
      "a press step in the replay script is missing its key name (key): {path}",
    "replay.err.focusNoTarget":
      "a focus / blur step in the replay script is missing its target: without one there is no element whose focus to change: {path}",
    "replay.err.networkNoUrl":
      "an assert_network step in the replay script is missing its url: an empty url matches any request, so the assertion would always pass: {path}",
    "replay.normalized":
      "[pageqa] restored recorded literal values in the script back to placeholders (re-expanded at replay time): {items}",
    "replay.drift.missing": "source case file no longer exists: {path}",
    "replay.drift.changed":
      "source case content has changed ({path}): the script was recorded against an earlier version; re-run with the LLM and regenerate",
    "replay.drift.unreadable": "failed to read the source case file ({path}): {msg}",
    "replay.locate.similar": "; similarly named {role} elements on the current page: {items}",
    // The last two state facts only — no guesses. The old wording asserted "you probably ended up
    // on another menu/button with the same name" and "the menu/dialog is not open right now",
    // while the real incident was "the page has not rendered that filter form yet".
    "replay.locate.roleOnly":
      "; the page has {count} role={role} elements ({items}), but none named like \"{prefix}\"",
    "replay.locate.noRole": "; no visible role={role} element on the current page",
    "replay.locate.regionPresent":
      "; the region it lived in ({region}) IS present on this page (the page has rendered), so the problem is the element itself: renamed, removed, or not meant to be clicked this time",
    "replay.locate.regionOverlay":
      "; it lived inside the overlay {region}, which does not exist right now — most likely that panel/dialog is not open",
    "replay.locate.miss":
      "cannot relocate the element on the current page: {desc} (recorded as {target}){detail}",
    "replay.locate.missWaiting":
      "cannot relocate the element on the current page: {desc} (recorded as {target}); waited {waited}ms for the page to become ready ({polls} snapshot(s), line counts {lines}) and {region} never appeared — the page may be stuck loading or redirecting; if it is merely slow, raise --locate-timeout (currently {limit}ms)",
    "replay.locate.missRef":
      "cannot relocate the element on the current page: {target} (the reference is stale and no semantic locator was recorded)",
    "replay.step.label": "replay step {index} ({kind})",
    "replay.step.caseRef": "maps to case step {step}: {text}",
    "replay.assert.unparsed": "could not parse the assertion result: {out}",
    "replay.assert.semanticHint":
      "this assertion passed via Jev semantic matching at recording time (the expected text does not literally appear), so string matching cannot pass — retry with --semantic",
    "replay.assert.stepOk": "{context} succeeded",
    "replay.retry.trace":
      "[replay-retry] #{index} {kind} (attempt {attempt}/{attempts} failed): {reason}",
    "replay.retry.debug": "[replay] step {index} failed, about to retry: {reason}",
    "replay.wait.trace":
      "[replay-wait] {label} waited {waited}ms for the page to become ready ({polls} snapshot(s), line counts {lines}) and then resolved to {ref}",
    "replay.log.step": "[pageqa] ▶ {label} …",
    "replay.log.waitReady":
      "[pageqa] ⏳ {label}: the region it lives in is not there yet ({region} is not in the snapshot); waiting for the page to become ready, up to {limit}ms …",
    "replay.log.ok": "[pageqa] ✓ {label} {cost}ms{assert}",
    "replay.log.okAssertPass": " (assertion passed)",
    "replay.log.okAssertFail": " (assertion failed)",
    "replay.log.skip":
      "[pageqa] ⚠ {label} {cost}ms element not found, skipped and continuing: {reason}",
    "replay.log.fail": "[pageqa] ✗ {label} {cost}ms: {reason}",
    "replay.evidence.attempts": "{reason}; still failing after {attempts} attempt(s)",
    "replay.evidence.aborted": ", replay stopped here",
    "replay.evidence.remaining": "; steps not executed: replay steps {from}~{to}",
    "replay.download.triggerMissing":
      "the download trigger element could not be found, so no download could be captured (this step is an assertion, it is NOT skipped like an element-not-found): {reason}",
    "replay.evidence.continued":
      ", this step was skipped and the remaining steps continued",
    "replay.log.session": "[pageqa] replay session={session} (scenario: {name})",
    "replay.log.semanticOff":
      "[pageqa] --semantic was given, but Jev is not enabled (missing enabled/apiKey); assertions fall back to string matching",
    "replay.summary.executed": "{total} steps replayed, {executed} executed",
    "replay.summary.skipped": "{count} skipped (element not found)",
    "replay.summary.failed": "{count} failed",
    "replay.log.scenarioEnd":
      "[pageqa] scenario replay finished: {status} ({executed}/{total} steps executed{extra})",
    "replay.log.scenarioEnd.skip": ", {count} skipped",
    "replay.log.scenarioEnd.fail": ", {count} failed",
    "replay.log.scriptStart":
      "[pageqa] replay script: {path}, {count} scenario(s), zero-model execution{semantic}",
    "replay.log.scriptStart.semantic": " (assertions use Jev semantic matching)",
    "replay.log.semanticWarn":
      "[pageqa] note: {count} assertion(s) in the script passed via Jev semantic matching at recording time (the expected text does not literally appear); replay defaults to string matching and will fail them — use --semantic for semantic matching",
    "replay.log.settleWaits":
      "[pageqa] --settle-waits: {count} wait step(s) now run as \"wait until the page settles, capped at the recorded milliseconds\". If a recorded wait was there for something outside the page (a server-side export, a background queue), the page may already be settled and the step is released early — an assertion/download right after it can then fail; the wait line in the trace states the actual wait",
    "replay.log.suiteScenario": "[pageqa] ═══ scenario {index}/{total}: {name} ═══",
    "replay.log.suiteSummary": "[pageqa] replay summary: {summary}",

    // ── bsk process-level errors (src/bsk/tools.ts) ──
    "bsk.err.notFound":
      "bsk command not found: install browserskill first and make sure bsk is on PATH",
    "bsk.err.timeout":
      "bsk command timed out ({seconds}s): the bsk daemon may not be running or no browser is connected. Run `bsk session start` and confirm the browser is connected, then retry. Command: {cmd}",
    "bsk.err.abortedBefore": "operation aborted, not executed: bsk {cmd}",
    "bsk.err.aborted": "operation aborted: bsk {cmd}",
    "bsk.daemon.starting":
      "[pageqa] bsk daemon is not running; starting it in the background (may take a few seconds on first run)…",
    "bsk.err.daemonExit": "bsk daemon failed to start, exit code {code}",
    "bsk.daemon.ready": "[pageqa] bsk daemon is ready ({seconds}s)",
    "bsk.err.daemonTimeout":
      "bsk daemon startup timed out (30s); check the bsk installation or run `bsk daemon start` manually",
    "bsk.err.noBrowser":
      "bsk has no connected browser: pageqa cannot attach to a physical browser by itself.\nInstall the bsk extension in your browser and complete the connection (or run `bsk session start` and follow its prompts), then retry.",
    "bsk.connected": "[pageqa] bsk has {count} connected browser(s)",
    "bsk.err.sessionFailed":
      "could not create a bsk session; make sure the bsk daemon has a connected browser.",
    "bsk.err.uploadMissing": "file to upload does not exist: {file}",
    // ref gate (checkRef in src/bsk/tools.ts + inspectRefTarget in src/locator.ts)
    // this error is always followed by the "interactive elements on the current page" list
    // (see exec in src/bsk/tools.ts), so it only explains *why* — the *what to do* lives in the
    // list header. Writing both would contradict itself ("call snapshot" vs "no separate snapshot").
    "bsk.err.refStale":
      "the @eN ref `{target}` is stale: the page changed after the latest snapshot (any navigate/click/fill/select_option/pick_date/hover/scroll/wait renumbers refs), so it may now point at a different element — reusing it silently clicks whatever holds that number now.",
    "bsk.err.refUnknown":
      "the latest snapshot has no ref {target}: {action} must use a ref from the most recent snapshot. Call snapshot for current refs instead of reusing numbers from an earlier snapshot or writing them from memory.",
    "bsk.ref.landed": "(landed on: {who})",
    // the interactive-element list attached after an action (refsAfterAction in src/bsk/tools.ts);
    // forRetry is used in the stale-ref error — that action did NOT succeed, so "after the action" would mislead
    "bsk.refs.afterAction": "interactive elements after the action",
    "bsk.refs.forRetry":
      "interactive elements on the current page (retry this {action} with a new ref from here — no separate snapshot call needed)",
    "bsk.refs.failed": "(snapshot failed: {msg})",
    // native dialog passthrough (renderDialogs / extractDialogs in src/bsk/ipc-commands.ts)
    "bsk.dialog.notice":
      "Note: the page raised a native dialog during this action; bsk handled it with the default policy (accepted confirms, dismissed alerts) so the page is not blocked:",
    // console / network assertions (assert_no_console_error / assert_network in src/bsk/tools.ts)
    "bsk.console.unreadable":
      "could not read console records: bsk returned an unrecognised payload. Check that this bsk version supports the console command (`bsk console --help`).",
    "bsk.console.truncated":
      " (bsk keeps only the last 200 console entries; older ones were dropped, so this is not the full picture)",
    "bsk.console.scopeErrors": "errors",
    "bsk.console.scopeWarnings": "errors or warnings",
    "bsk.console.expectation": "the page has no JavaScript {scope}",
    "bsk.console.clean":
      "no {scope} among the last {count} console records{note}",
    "bsk.console.dirty": "found {count} {scope}: {sample}{note}",
    "bsk.network.unreadable":
      "could not read network records: bsk returned an unrecognised payload. Check that this bsk version supports the network command (`bsk network --help`).",
    "bsk.network.urlRequired":
      "assert_network needs a url (a substring of the request address to assert on).",
    "bsk.network.badStatus":
      'cannot understand the status expectation "{spec}". Supported: 200 (exact), 2xx / 4xx / 5xx (ranges).',
    "bsk.network.truncated":
      " (bsk keeps only the last 200 network entries; older ones were dropped, so this is not the full picture)",
    // the method is a match condition too: methodSuffix goes into the **expectation**
    // (the assertion text in the report), methodNote into the evidence. Without it a
    // "right URL, wrong method" assertion reads as "no request matching {url}".
    "bsk.network.methodSuffix": ", method {method}",
    "bsk.network.methodNote": " (method {method})",
    "bsk.network.expectationStatus": "request {url} returns {status}{method}",
    "bsk.network.expectationAny": "request {url} completes successfully{method}",
    "bsk.network.expectedResponse": "a successful response (not a failure)",
    "bsk.network.noTraffic":
      "(this page has produced no network records: either it really made no requests, or bsk could not enable network capture for it)",
    "bsk.network.noMatch":
      'no request matching "{url}"{method} among the last {count} network records{note}. Recent requests: {recent}',
    "bsk.network.methodMismatch":
      '"{url}" matched {count} request(s), but none uses method {expected} (methods seen: {actual}){note}. Write the real method, or drop method and match on the URL alone.',
    "bsk.network.hit": '{count} request(s) matching "{url}"{method}; latest: {latest}{note}',
    "bsk.network.miss":
      '{count} request(s) matching "{url}"{method}; actual: {actual} (expected {expected}){note}',
    // screenshots (the `screenshot` tool in src/bsk/tools.ts + embedding in src/report-html.ts)
    "bsk.screenshot.bothModes":
      'a screenshot cannot be both "full page" and "a single element": pick one (fullPage=true, or target).',
    "bsk.screenshot.refOnly":
      'element screenshots only accept an @eN ref (bsk\'s screenshot has no CSS selector entry); got "{target}". Call snapshot for a ref first.',
    "bsk.screenshot.onFailure": " (screenshot captured automatically: {path})",
    // wheel / get-html (the `wheel` and `get_html` tools in src/bsk/tools.ts)
    "bsk.wheel.needDelta":
      "wheel needs at least one non-zero delta: deltaY (positive = down) or deltaX (positive = right). A wheel event with both at 0 does nothing.",
    "bsk.getHtml.refOnly":
      'get_html only accepts an @eN ref (bsk\'s get-html has no selector entry); got "{target}". Use evaluate if you need to read DOM by selector.',
    "bsk.getHtml.unreadable":
      "could not read HTML: bsk returned an unrecognised payload. Check that this bsk version supports the get-html command (`bsk get-html --help`).",
    "bsk.getHtml.truncated":
      " (truncated to maxBytes: the full HTML is {bytes} bytes, so this is not all of it — pass out to write it to a file)",
    "bsk.getHtml.badBudget":
      "maxBytes must be within 1–{max} (default 16384). For larger HTML pass out and write it to a file instead of into the context.",
    "bsk.screenshot.unavailable":
      "the screenshot did not happen (bsk reported: {reason}). The page may be hidden, or the target is unreadable — do not treat this as evidence captured.",
    "log.sideOutputScreenshot": "screenshot: {path}",
    "reportHtml.screenshots": "Screenshots",
    "reportHtml.screenshotMissing":
      "screenshot not inlined (file is gone, or it exceeds 4MiB): {path}",
    // picker widgets (src/bsk/picker.ts + select_option / pick_date in src/bsk/tools.ts)
    "bsk.picker.noOverlay":
      "no visible dropdown overlay appeared after opening {target} (it may not be an open-on-click dropdown). If it is really a plain text input, use fill instead; otherwise call snapshot and pick the option by hand.",
    "bsk.picker.optionMissing":
      "the overlay has no option whose visible text is \"{option}\".",
    "bsk.picker.optionCandidates": "currently selectable: {list}",
    "bsk.picker.badDate":
      "cannot understand the date \"{spec}\". Supported: 2026-09-29, 2026/9/29, 2026年9月29日, or today / 今天 / +3 / -7.",
    "bsk.picker.noPanel":
      "no date panel appeared after opening {target} (it may not be a click-to-pick date picker). If it accepts typed input, use fill with the format the page expects.",
    "bsk.picker.dayMissing":
      "could not click {date} in the date panel: it may not be in the month currently shown, or the day is disabled. Call snapshot first to see which month the panel shows.",
    "bsk.picker.confirmed": " (confirmed with OK)",
    "bsk.picker.rangeNeedsEnd":
      "{target} opened a **date range** picker (the panel shows two calendar tables). Picking only one end would leave a half-finished range on the page. Pass the end date as endDate as well, e.g. date=\"2026-09-27\", endDate=\"2026-09-29\".",
    "bsk.picker.notRange":
      "{target} opened a **single-date** panel (only one calendar table), so endDate is not expected. If the page really has a \"start ~ end\" pair of inputs, point target at the range control rather than one of its inputs.",
    "bsk.picker.rangeOrder":
      "the end date is earlier than the start date ({start} ~ {end}): check the order used in the case; this is not a page problem.",
    // download assertion (the `download` tool in src/bsk/tools.ts + src/downloads.ts)
    "bsk.download.expectation": "the exported file has been downloaded locally",
    "bsk.download.expectationNamed":
      "the downloaded file name matches {pattern}",
    "bsk.download.captured":
      "the browser captured one download and wrote it to disk: {path} ({bytes} bytes{extra})",
    "bsk.download.evidenceMime": "MIME {mime}",
    "bsk.download.evidenceDanger": "content rating {level}",
    "bsk.download.triggerError":
      "the download trigger element could not be clicked, so this step never ran: {detail} (take a fresh snapshot to get the current @eN or fix the selector, then call download again; the tool must click the trigger itself)",
    "bsk.download.notCaptured":
      "no download event was captured within {seconds}s: the trigger element was clicked, but no download happened (the export request never returned, the browser blocked it, or the element does not trigger a download). Raw bsk output: {detail}",
    "bsk.download.captureNotReady":
      ". bsk reports its download capture is not ready (common right after a daemon restart/upgrade; the tool already retried once) — reconnect the bsk browser extension or wait a moment and run again",
    "bsk.download.notWritten":
      "a download was captured but the file is not on disk: {path} (bsk reported success yet the file cannot be read — it may have been moved/deleted, or the directory is not writable)",
    "bsk.download.empty":
      "the captured file is 0 bytes: {path} (the export may be empty, or the download was interrupted)",
    "bsk.download.nameMismatch":
      "the downloaded file name does not match the expectation {pattern}: actual name is {name} (the file is on disk: {path})",
    "bsk.download.retrying":
      "[pageqa] the first download attempt captured nothing; retrying once (up to {seconds}s more): {detail}",
    "bsk.download.retried": "; the first click was not captured, the retry succeeded",
    "bsk.download.cleanupScheduled":
      "; the file will be removed when this run finishes (to keep it, give `out` in the case or set `downloadCleanup` to false)",
    "bsk.session.closed":
      "[pageqa] closed bsk session={session} (browser window closed)",
    "bsk.session.closeFailed":
      "[pageqa] failed to close bsk session={session} (does not affect the test outcome): {msg}",

    // ── interactive mode ──
    "tui.title": "pageqa interactive mode",
    "tui.hint":
      "Enter submit · Shift+Enter newline · Esc abort current scenario · ↑↓/PgUp/PgDn scroll log · Ctrl+P history · Ctrl+C finish · /help",
    "tui.help":
      "commands:\n  /status        view the run queue\n  /run <file>    load an existing case file (path or filename keyword) into the run queue\n  /new           start a new session (clears the viewport and run queue; scenarios that already ran still go into the exit report and the replay script)\n  /cancel <n>    cancel a not-yet-started pending item (n is the queue number)\n  /model         choose the model (Enter switches and sets it as the startup default)\n  /login         sign in a provider (API key or subscription); credentials go to ~/.pageqa/auth.json\n  /logout        remove locally stored credentials for a provider\n  /proxy         inspect / toggle proxy routing for model requests (config: ~/.pageqa/proxy.json)\n  /help          show this help\n  /exit          finish (same as Ctrl+C)\n  /setting       change settings (test report / replay script / language), saved to ~/.pageqa/config.json\nkeys:\n  Enter          submit input (with `## title` it becomes the scenario name, otherwise the first-line summary)\n  Shift+Enter    newline (for writing multi-scenario cases)\n  Esc            abort current scenario, queue continues to the next\n  Ctrl+P/Ctrl+N  input history: previous / next submitted text (↑/↓ went to the log)\n  Ctrl+C         finish: abort current + cancel all pending → restore the terminal → print the summary (a normal exit, never a hard kill)\n  Ctrl+C ×2      pressed again while winding down: stop waiting for the queue and finish now (the report is still printed)\nlog viewport:\n  PageUp/PageDown  scroll the log one page up/down\n  ↑ / ↓            scroll the log (when the input box is empty; otherwise they stay the editor's)\n  Ctrl+↑ / Ctrl+↓  scroll one line (always works)\n  Home / End       jump to the start of the log / back to the end\n  mouse wheel      scroll the log ({wheel} lines per notch). Some terminals report the wheel as ↑/↓ — that is the row above\nstatus bar: run progress (n of m, elapsed) · pending count · current model · written-back count · write-back target\nbelow the input box: the session's token usage (⬇ input / ⬆ output / read and write = cache read/write / total / call count, plus the cache hit rate at the end; refreshed after each LLM call)",
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
    "tui.sceneStart": 'scenario #{i} "{name}"{appended}',
    "tui.sceneEnd":
      'scenario #{i} "{name}" ended: {tag} ({n} assertions, elapsed {duration})',
    "tui.sceneError": 'scenario #{i} "{name}" errored: {msg}',
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
      "unknown command: /{cmd} (available: /help /status /run <file> /new /cancel <n> /model /login /logout /setting /proxy /exit)",
    "tui.languageSwitched": "UI language switched to {locale} (saved to config)",
    "tui.languageSwitchFailed":
      "UI language switched to {locale} (failed to write config: {msg})",
    "tui.run.usage":
      "usage: /run <case file path or keyword> (e.g. /run examples/smoke.md, /run github-star)",
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
    "tui.cmd.setting":
      "change settings (test report / replay script / language)",
    "tui.cmd.proxy": "inspect / toggle the proxy routing for model requests",
    "tui.cmd.exit": "finish (same as Ctrl+C)",

    // ── /proxy panel ──
    "tui.proxy.title": "model request proxy v{version} · {state}",
    "tui.proxy.state": "now: {state} · proxy {proxy} · mode {mode}",
    "tui.proxy.on": "active",
    "tui.proxy.off": "inactive",
    "tui.proxy.hint":
      "proxy {proxy} · mode {mode} · ↑↓ choose · Enter run · Esc close · config {path}",
    "tui.proxy.enable": "enable proxy routing (saved to config)",
    "tui.proxy.disable": "disable proxy routing (saved to config)",
    "tui.proxy.bypass": "send everything direct for this session (config untouched)",
    "tui.proxy.unbypass": "go back to the configured routing",
    "tui.proxy.reload": "reload the config file",
    "tui.proxy.stats": "show counters and rules",
    "tui.proxy.statsDesc": "print to the log, then close this panel",
    "tui.proxy.saved": "proxy routing {state}; written to {path}",
    "tui.proxy.reloadOk":
      "reloaded {path}: {state} · proxy {proxy} · mode {mode}",
    "tui.proxy.failed": "action failed: {msg}",
    "tui.proxy.bypassed": "this session sends everything direct (config untouched)",
    "tui.proxy.unbypassed": "back to configured routing ({state} · proxy {proxy})",
    "tui.proxy.statsLine":
      "direct {direct} · via proxy {proxy} · fallback {fallback} (of which retried via proxy {fallbackHit})",
    "tui.proxy.rulesTitle": "rules (top-down, first match wins):",
    "tui.proxy.envOverride":
      "environment variables take precedence over this file (PAGEQA_PROXY_URL / _ENABLED / _MODE)",

    // ── /setting panel ──
    "tui.setting.title": "settings v{version}",
    "tui.setting.report": "test report (HTML)",
    "tui.setting.replayScript": "replay script",
    "tui.setting.locale": "language",
    "tui.setting.on": "on",
    "tui.setting.off": "off",
    "tui.setting.hint": "↑↓ select · Enter toggles · Esc closes · config: {path}",
    "tui.setting.saved": "updated: {name} = {value}",
    "tui.setting.failed": "failed to write config: {msg}",
    "tui.setting.concurrency": "concurrency",
    "tui.setting.concurrencyTitle":
      "how many scenarios run at once (↑↓ select · Enter confirms · Esc cancels)",
    "tui.setting.concurrencyOne": "1 (one at a time, the default)",
    "tui.setting.concurrencyMany":
      "{n} (up to {n} at once, i.e. {n} browser windows)",
    "tui.setting.concurrencyCurrent": "· current",
    "tui.setting.concurrencySaved":
      "concurrency set to {n}: takes effect for scenarios dispatched from now on, and was written back to {path}",

    // ── model switching & login ──
    "tui.model.status": "model {model}",
    "tui.model.title": "Select model (current: {current})",
    "tui.model.loading": "preparing the model list…",
    "tui.model.hint": "↑↓ move · Enter use and set as startup default · Esc cancel",
    "tui.model.badgeCurrent": "current",
    "tui.model.badgeDefault": "default",
    "tui.model.badgeFree": "free",
    "tui.select.hint": "↑↓ move · Enter confirm · Esc cancel",
    "tui.select.searchHint": "type to filter in real time",
    "tui.select.searchPlaceholder": "type to filter…",
    "tui.select.noMatch": "no matching items",
    "tui.model.fallback":
      "the startup default {provider}/{model} is unavailable (provider not signed in, or the model was retired); switched to {next} instead — {healed} use /model to pick again",
    "tui.model.fallbackHealed":
      "config.json was updated, so the next start won't warn again.",
    "tui.model.fallbackKept":
      "config.json could not be written, so the next start will warn once more.",
    "tui.model.applied":
      "switched to {provider}/{model} and set it as the startup default (written to {path}; takes effect for later scenarios and for the next start — the running one is unaffected)",
    "tui.model.envOverride":
      "note: PAGEQA_LLM_MODEL / PAGEQA_LLM_PROVIDER still win over config.json — remove them for the default above to take effect.",
    "tui.model.saveDefaultFailed":
      "this session now uses {provider}/{model}, but the startup default could not be written ({msg}); the next start will still use the old one.",
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
    "tui.env.expectation":
      "the browser environment is usable (no scenario runs when it is not)",
    "tui.env.stopNote": "browser environment unavailable, run stopped",
    "tui.env.stopRun":
      "stopped the remaining {n} scenario(s): running on with an unusable browser environment only produces the same failure over and over.",
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
    "tui.login.stepPrepare": "preparing browser sign-in…",
    "tui.login.stepExchange": "callback received, exchanging the access token…",
    "tui.login.stepDone": "authorized, writing credentials…",
    "tui.login.errCallbackTimeout":
      "no browser callback within 5 minutes. If the browser is not on this machine (container / VM), use API key sign-in instead",
    "tui.login.errDeviceTimeout": "the device code expired, please sign in again",
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
    "tui.abortingCurrent": "aborting {n} running scenario(s)…",
    "tui.cancelledWaiting": "cancelled {n} not-yet-started pending item(s)",
    "tui.abortTimeout":
      "abort timed out, forcing finish (this scenario's report may be missing)",
    "tui.abortScene":
      "requested abort of {n} running scenario(s) ({names}); remaining steps will not run",
    "tui.enterHint":
      "type a natural-language case and press Enter to append a scenario (written back to the write-back target, if any); /run <case file> loads an existing case; /help for commands.",
    "tui.interactiveStart": "interactive mode: {n} initial scenario(s) queued",
    "tui.sourceFile":
      "source case file: {path} (appended scenarios are written back here)",
    "tui.running": "running {i}/{n} ({duration})",
    "tui.runningMany": "{n} running · oldest \"{name}\" for {duration}",
    "tui.usage.cacheHit": "hit {pct}%",
    "tui.usage.context": "context {used}/{total} ({pct}%)",
    "tui.usage.contextNoWindow": "context {used}",
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
    "report.usage.replay": "Token: no LLM called (replay mode)",
    "report.usage.unavailable": "Token: unavailable (not collected)",
    // Compact usage line: `⬇` = input (fed into the model), `⬆` = output, `read`/`write` =
    // cache read/write. The order is the legend (input · output · read · write · total), which
    // is what lets the long labels go; don't "clarify" it by putting the words back.
    "report.usage.line":
      "Token: ⬇ {in} / ⬆ {out} / read {cr} / write {cw} / total {total} (LLM calls {calls})",
    "report.usage.noUsage": " (endpoint returned no usage)",
    "report.assertIncomplete":
      "all assertions in the case executed (actual {got}/{expected})",
    "report.assertIncompleteEvidence1":
      "fewer assertions recorded than declared in the case: some 'assert' step may have only been visually confirmed via snapshot without an actual assert_text/download tool call, so it was not recorded (the steps themselves may have finished)",
    "report.assertIncompleteEvidence2": "last progress: {note}",
    "report.assertNotRun":
      "assertions executed through tools ({expected} declared, 0 recorded)",
    "report.assertNotRunEvidence1":
      "this run produced no assert_text/download structured result: 'holds' written in the answer text is not execution (the model may have emitted tool calls as plain text while the browser never moved)",
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

    // ── Timing breakdown (src/timing.ts) ──
    "timing.title": "time breakdown (wall clock {wall})",
    "timing.llm": "  LLM calls {calls}, {total} ({pct}%), avg {avg}",
    "timing.commands":
      "  tool calls {calls}, {total} ({pct}%), avg {avg}{errors}",
    "timing.commands.errors": ", {errors} failed",
    "timing.commandLine": "    {name} {calls} calls  {total}  avg {avg}{errors}",
    "timing.commandLine.errors": "  {errors} failed",
    "timing.commandRest": "    ({n} faster tools not listed)",
    "timing.other": "  other (orchestration/waiting/teardown) {total} ({pct}%)",
    "timing.tokens":
      "  tokens: in {input}, out {output}, cache read {cache} (over {calls} calls)",
    "report.suiteSummaryBase":
      "{n} scenario(s) in total, {passed} passed",
    "report.suiteSummaryCancelled": ", {cancelled} cancelled",
    // human-readable wording for the abnormal-termination reason (see ADR-0013 decision 7)
    "report.reason.crash":
      "child process ended abnormally ({how}); this scenario did not finish",
    "report.reason.timeout":
      "exceeded the {sec}s per-scenario limit; the child process was killed",
    "report.reason.infrastructure":
      "environment unavailable ({msg}); this scenario was not executed",
    "report.cancelEnvGone":
      "environment unavailable; this scenario was not executed",

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
    "reportHtml.pageTitle": "page test report",
    "reportHtml.pageTitleSuite": "page test suite report",
    "reportHtml.detail": "case details",
    // ── side outputs summary (src/side-outputs.ts) ──
    "log.sideOutputsTitle": "[pageqa] side outputs:",
    "log.sideOutputReport": "[pageqa]   test report: {path}",
    "log.sideOutputReportOff":
      "[pageqa]   test report: not generated (turned off in /setting)",
    "log.sideOutputReportOffFlag":
      "[pageqa]   test report: not generated (disabled by --no-side-outputs)",
    "log.sideOutputReportSkipped":
      "[pageqa]   test report: not generated (no case ran this session)",
    "log.sideOutputReportFailed":
      "[pageqa]   test report: write failed ({msg})",
    "log.sideOutputScript": "[pageqa]   replay script: {path}",
    "log.sideOutputScriptOff":
      "[pageqa]   replay script: not generated (turned off in /setting)",
    "log.sideOutputScriptOffFlag":
      "[pageqa]   replay script: not generated (disabled by --no-side-outputs)",
    "log.sideOutputScriptNone":
      "[pageqa]   replay script: not generated (no replayable action this run)",
    "log.sideOutputScriptNoTarget":
      "[pageqa]   replay script: not generated ({n} scenario(s) had no write-back target)",
    "log.sideOutputScriptFailed":
      "[pageqa]   replay script: write failed ({msg})",
    "log.sideOutputReplay": "[pageqa]   replay with: pageqa --replay {path}",
    "log.sideOutputReplayMany":
      "[pageqa]   replay with: pageqa --replay <any script path above>",
    "log.sideOutputDownload": "[pageqa]   downloaded file: {path}",
    "log.sideOutputDownloadCleaned":
      "[pageqa]   downloaded file: {path} (removed after the assertion passed)",

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
  pageqa sessions [--port <n>] [--dir <path>]
                   start the local archive server; open it in a browser to review
                   what each run handed to the model

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
  --concurrency <n>
                  how many scenarios run at once (**a limit**, default 1 = one at a time;
                  PAGEQA_CONCURRENCY also works)
                  parallelism is a claim that "these scenarios do not depend on each other",
                  so it is off by default: running in order is what protects implicit
                  sequences such as create -> edit -> delete
                  the cost is n simultaneously open browser windows (one scenario, one
                  session, one window)
                  capped at 8, and exceeding it is an error rather than a silent clamp
                  interactive mode honours it too: this value is just the starting point
                  for the session; once inside, /setting > concurrency changes it live
                  (and writes it back to the config)
                  --replay never uses the scenario scheduler, so concurrency is inert there
  --only <index|title>
                   run just one of the scenarios (one of the "## title" units)
                  index starts at 1; a non-numeric value is matched **exactly** against
                  the scenario title (case-insensitive). No fuzzy matching: a miss errors
                  out and lists every scenario title
                  the output is still suite-shaped (one scenario) so CI parses one structure
                  cannot be used with --suite / --tui / --replay
  --tui            force interactive mode (auto-enters in an interactive terminal by default, see "Interactive mode" below)
  --no-tui         don't use interactive mode (when you only want the scrolling log, or for troubleshooting)
                  also disablable via env: PAGEQA_NO_TUI=1
  --emit-script [path]
                  freeze the successful operations into a replay script (Replay Script)
                  this is **generated by default** (turn it off in interactive /setting; an explicit
                  flag always wins)
                  without path, written next to the source case: examples/smoke.md -> examples/smoke.replay.json
                  without a source file (inline text, appended scenarios with no target) nothing is
                  generated, and the exit side-outputs summary says why
                  path is best given as a path form (e.g. ./replay, reports/run1.json),
                  quote if it contains spaces; if what follows is .md/.txt or whitespace text,
                  it is treated as case input rather than an output path
                  generated for both PASS/FAIL, convenient for debugging and continuation
  --replay <file>  replay an existing script with zero models (see "Replay script" below)
  --semantic       at replay, assertions use Jev semantic judgment (default string contains)
  --init-config    create/reset the config file in the user directory
  --out <file>     write the report to a file
  --no-side-outputs
                  write no side outputs: no HTML report, and no default replay script
                  the stdout report and the exit code are unaffected (for CI that only wants stdout)
                  an explicit --emit-script <path> still wins (explicit request first)
  --usage-stream   print one structured LLM-usage record per call to stderr (prefix [pageqa:usage] )
                  when a scenario runs in its own child process, this is how the parent gets
                  "how much has been burned so far" in real time
  --no-lint        skip the case-format pre-check before a run (on by default; it only
                  advises on stderr and never blocks). To gate on it: pageqa lint <case file>
  --debug          show debug logs (bsk commands, snapshot size, context trimming, Jev request details)
  -v, --version    show the version
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
  /model        choose the model (Enter switches and writes it back to config.json as the next startup default)
  /login        sign in a provider (API key or subscription); credentials go to ~/.pageqa/auth.json
  /logout       remove locally stored credentials for a provider
  /setting      change settings (test report / replay script / language), saved to ~/.pageqa/config.json
  /proxy        inspect / toggle proxy routing for model requests (config: ~/.pageqa/proxy.json)
  /help /exit

Proxy for model requests:
  - When a model endpoint is unreachable directly, the rules in ~/.pageqa/proxy.json
    decide per domain: direct, proxy, or fallback (try direct, retry via the proxy on a
    network error — the default).
  - Default rules are "localhost and the intranet go direct, everything else tries direct
    first", so local endpoints (an OpenAI-compatible server on 127.0.0.1, the bsk daemon)
    are untouched while an off-network model endpoint automatically goes through the proxy.
  - Change the address or the switch: edit ~/.pageqa/proxy.json (pageqa --init-config
    writes one), or override per run with PAGEQA_PROXY_URL / PAGEQA_PROXY_ENABLED /
    PAGEQA_PROXY_MODE (env wins). The interactive /proxy panel toggles it and shows
    counters and rules.
  - --debug prints the current proxy state at startup.

Model switching & login:
  - /model lists models whose provider has complete auth: the custom endpoint
    (baseUrl/apiKey/model in config.json) is always available; built-in providers
    (anthropic / openai / deepseek / github-copilot …) appear only after /login, or
    when the matching env var (e.g. ANTHROPIC_API_KEY) is set.
  - picking a model with Enter writes modelProvider/model back to config.json: it
    switches this session and becomes the startup default in one action (ADR-0015).
  - switching never interrupts a running scenario: the current one keeps the model
    it started with, the next one uses the new one.

  - submitted scenarios are **immediately appended back to the source case file** (original text preserved verbatim, including runtime placeholders),
    so "pageqa --tui examples/smoke.md" modifies that file.
  - scenarios run serially, and **each runs in its own child process** (see docs/adr/0013):
    a scenario that takes the browser or the bsk daemon down only affects itself.
    The parent owns session and browser-window lifetimes, creating one when a scenario's turn comes.
  - cannot be combined with --json / --replay / --session (the first two need exclusive stdout or no waiting,
    the third conflicts with "each scenario has its own session").
  - replay scripts are generated by default: on exit the run scenarios are written per source, cancelled
    scenarios excluded; turn it off in /setting, or force it with an explicit --emit-script (path optional).
  - the test report and the replay script are "side outputs": written to disk only, never into stdout, and
    their paths appear in the exit side-outputs summary.

Replay script (rerun the same case with zero models):
  pageqa --replay <file.replay.json> [--session <id>] [--json] [--semantic] [--fail-fast] [--settle-waits] [--locate-timeout <ms>]
                   drives the browser step by step per the script, **calling no LLM**, assertions default to string contains
                   --semantic switches to Jev semantic judgment (Jev must be enabled in config)
                   element location re-parses the recorded semantic locator in the current snapshot,
                   so the script still hits after small page changes; source-case drift is warned on stderr
                   --fail-fast stops the scenario on any failure; by default it runs remaining steps,
                   to get a complete health report of the whole case in one go (failure still yields a non-zero exit code)
                   --settle-waits runs wait steps as "wait until the page settles, capped at the recorded ms":
                   a recorded fixed wait (e.g. wait 2000) was the model's guess and is paid in full on every replay;
                   with this flag a step proceeds as soon as the page is stable, usually much faster after
                   navigation/dialog waits. Off by default, because a wait that was there for something outside
                   the page (a server-side export, a background queue) is then released early and the assertion/
                   download right after it can fail — the wait line in the trace reports the actual wait
                   --locate-timeout <ms> caps how long a step waits for the page to become ready when the
                   locator's whole region is missing (the page has not rendered that far yet): default 8000ms,
                   0 = no wait at all. It waits only in that case — if the region is present, or is an overlay
                   that is simply not open, the miss is judged immediately, so genuinely missing elements are
                   not slowed down

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
    is persisted to config.json automatically (or by editing the fields above)
  - turning the endpoint's thinking off: hybrid reasoning models (Hunyuan / DeepSeek / Qwen) default to
    thinking on, and the model then emits a long reasoning passage first (slow, token-hungry, and it
    muddles step numbering). **Off by default**: pageqa picks the off-switch the endpoint understands
    from the model id and sends it on every request; set thinkingFormat=none to stop doing that.
      PAGEQA_LLM_THINKING_FORMAT=deepseek   sends thinking: {"type": "disabled"}
      PAGEQA_LLM_THINKING_FORMAT=qwen       sends enable_thinking: false
      PAGEQA_LLM_THINKING_FORMAT=zai|together|openrouter|string-thinking|qwen-chat-template
                                            also work; see the README for the table
      PAGEQA_LLM_THINKING_FORMAT=none       send no thinking switch (endpoint keeps its default)
      (openai / ant-ling / baseten cannot send an off-switch. If an endpoint rejects the field, the
        probe drops it and downgrades, so a working endpoint is never broken by the default.)
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
  pageqa sessions                       # review archived parameters and tool calls (Ctrl+C to quit)
  pageqa lint examples/smoke-test.md    # static case-format check (no browser, no model)
`,
    "help.sessions": `pageqa sessions - local archive query server

Usage:
  pageqa sessions [options]

Starts a local server (bound to 127.0.0.1 only); open it in a browser to review each
agent run:
  - the parameters handed to the model: system prompt, model, tool declarations
    (including schema), the step-numbered case
  - the context actually sent on every turn: what the model really saw, and whether
    the context was trimmed
  - every tool call: arguments, result, duration, success or failure

Options:
  --port <n>   listen port (default 7331; bumped upward when taken)
  --dir <path> archive directory (default ~/.pageqa/sessions)
  --no-open    do not open the browser automatically
  -h, --help   show this help

Every run writes its archive automatically (~/.pageqa/sessions/sessions.sqlite, one
SQLite container through pi's session backend) with no extra switch. It lives in the
user directory rather than the working directory, and --no-side-outputs does not turn
it off: it is a debugging tool, not a test artifact. Only the latest 200 runs are kept.

Note: archives that earlier versions wrote as two JSON files per run
(~/.pageqa/sessions/*.json) are no longer read — the storage change ships without a
migration — and can simply be deleted.
`,

    // ── case-format lint (src/lint.ts; shared by `pageqa lint` and the pre-run check) ──
    "help.lint": `pageqa lint - static case-format check

Usage:
  pageqa lint <case file...> [options]

Reads the case text only — **no browser, no model** — and reports "which line, which
rule, why" in a second. It checks the format conventions the runtime actually depends
on (scenario splitting, one non-empty line = one step, one assertion line = one
assertion tool call) using the very same code path, so a clean lint never turns into
an "assertions incomplete" failure at run time.

Options:
  --json        output JSON (stdout carries the result only, CI-friendly)
  --strict      treat warnings as failures too (non-zero exit code)
  --locale <l>  display language: zh|en
  -h, --help    show this help

Severities:
  error  the case will run wrong or not at all (text before "## " is dropped, empty
         scenario, duplicate scenario name, @e snapshot ref, URL without scheme,
         unknown placeholder, non-absolute upload path)
  warn   merely inconsistent style (fixed wait, dropdown written as fill, a separate
         download-filename assertion, prose mistaken for a step, scenario with no
         assertion)

Exit code:
  0  no error (with --strict: no warning either)
  1  has an error (or a warning under --strict), or a parameter/file problem

Every run also performs the same check before executing a case (advisory only, it does
not block); pass --no-lint to skip it.
`,
    "err.lintNeedsFile": "lint needs a case file path",
    "err.lintNotFound": "file not found: {path}",
    "err.lintDir": "lint accepts case files, not directories: {path}",
    "err.noLintWithReplay": "--replay cannot be combined with --no-lint",
    "lint.header": "case format check: {path}",
    "lint.headerInline": "case format check: (inline text)",
    "lint.counts":
      "{scenarios} scenario(s) · {steps} step(s) · {assertions} assertion(s) · {downloads} download(s)",
    "lint.clean": "no format problems found",
    "lint.line": "  line {line} [{rule}] {message}",
    "lint.lineScenario": "  line {line} [{rule}] (scenario: {scenario}) {message}",
    "lint.text": "      {text}",
    "lint.more": "  …{n} more issue(s) not expanded (remove the cap to see all)",
    "lint.total": "{errors} error(s) / {warnings} warning(s)",
    "lint.preflightClean":
      "case format pre-check passed ({scenarios} scenario(s) · {steps} step(s) · {assertions} assertion(s))",
    "lint.hint":
      "the pre-check only advises and never blocks the run; to see all and gate the format: pageqa lint <case file>",
    "lint.rule.preambleText":
      "text before the first \"## \" is dropped entirely (intro notes, preconditions) — write it as a \">\" comment line",
    "lint.rule.emptyScenario":
      "this scenario has no effective step (only blank or comment lines); the runtime drops it silently",
    "lint.rule.duplicateScenario":
      "duplicate scenario title: \"--only <title>\" cannot tell them apart, and the report cannot either",
    "lint.rule.snapshotRef":
      "snapshot reference @eN: it is only valid in the snapshot that produced it and is stale on the very next action, let alone in a replay — locate by visible text or a CSS selector instead",
    "lint.rule.urlScheme": "the address after \"打开/open\" must include http/https",
    "lint.rule.unknownPlaceholder":
      "unknown placeholder: it is kept verbatim and silently does nothing (available: ${timestamp} / ${date} / ${time} / ${datetime}, optionally with a custom pattern)",
    "lint.rule.uploadPath":
      "uploads need an absolute local path (e.g. D:\\\\data\\\\a.xlsx): a relative path fails on the bsk side",
    "lint.rule.hardWait":
      "for changes inside the page use a conditional wait (\"wait until the page shows …\"); keep \"wait N seconds\" for things outside the page",
    "lint.rule.selectAsFill":
      "a dropdown is not a text box: write \"select X in the dropdown\" (or name select_option) instead of \"fill in\"",
    "lint.rule.downloadExtraAssert":
      "a download is already one assertion — do not add a separate \"assert the filename…\" line, which inflates the expected count into a false \"assertions incomplete\" failure",
    "lint.rule.vagueAssertion":
      "this assertion has no literal text to match: the assertion tool only does substring matching, so the model can only snapshot a current value (e.g. a row count) and use that as the expectation — making the assertion always true — and that value is recorded into the replay script, turning it into a false failure once the data changes. Write text that is actually printed on the page and does not change with the data (a header, a field label, a button caption)",
    "lint.rule.proseStep":
      "this line reads as explanatory prose rather than a step: put the explanation on a \">\" line, otherwise the model will try to execute it as a step",
    "lint.rule.noAssertion":
      "this scenario has no assertion line (and no download capture): nothing decides pass/fail, so the verdict falls back to guessing from keywords",
  },
};

let current: Locale = detectLocale();

/** 解析 locale 字符串（容错：未知值回退中文；`en-US` 这类写法按前缀认成英文）。 */
export function parseLocale(value: string | undefined): Locale {
  return value?.toLowerCase().startsWith("en") ? "en" : "zh";
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
