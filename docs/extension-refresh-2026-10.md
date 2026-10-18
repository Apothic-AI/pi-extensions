# 插件职责、上游增量与实验功能复核

研究快照：**2026-10-18 06:25 UTC**。本地审查起点为
[`f94820f`](https://github.com/signalridge/pi-extensions/tree/f94820fd711d2156ac9a224cd6b45f3e51fa151e)。
外部源码调查、静态审查、受控复现、实现和发布是不同阶段；下文不表示安装、启用或 npm 发布。

## 结论

- 当前有 **34 个包：31 个扩展、3 个无资源库**，其中扩展为 24 个 stable、7 个 experimental。
  “有独立职责”不等于“值得全部常开”。优先按工作流选插件，而非追求包数。
- 保留 Subagents 执行／Workflows 编排分层；Goal 和 Ralph 通常选一个控制同一会话的续跑。
- **不新增包**。候选先记录具体增量、隐私与验收成本，不为一项功能叠装整个集合。
- Todo 的正常成功无需重复存储保证说明；省略正常成功噪声，不削弱写入验证或隐瞒易失状态。
- 状态栏布局、信息 profile、换行策略均不改；不以此次调查为理由清除其他插件的 status。
- Recall、Analytics、Codex Compact 的实验标签和风险警告保留。尤其 opaque checkpoint 的可移植性
  不是 UI 问题，不能靠隐藏警告解决。

## 上游核验

本次以最近的专项评估为基线，而非只用较早的兼容性文档。直接 fork、替代实现与设计参考分开处理。

| 上游 | 核实的当前引用 | 相对最近有效基线 | 处置 |
| --- | --- | --- | --- |
| [Narumi extensions](https://github.com/narumiruna/pi-extensions/commit/6eedf914c8e7a5780c9b7cc8e64571cc7c970302) | `6eedf914` | 比 `63dc5ec6` 多 290 commits | 按行为筛选；不是本地缺 290 项修复 |
| [直接 fork：tintinweb Subagents](https://github.com/tintinweb/pi-subagents/commit/ca93a5247e72e7053fcd10bea7125d6c4205f949) | `ca93a524`；GitHub release `v0.22.0` | 比 UI 专项基线 `e819a82` 多 8 commits | 采用恢复限额及关闭清理的窄边界 |
| [Input History](https://github.com/ouzhenkun/pi-input-history/commit/b183aacb231734c02bb34009c5972178ee79b844) | `b183aacb`／`v1.1.3` | 无变化 | 不制造同步改动 |
| [tmustier extensions](https://github.com/tmustier/pi-extensions/commit/4a63a2ebd3683d86597e226c7ff778ea4837dd73) | `4a63a2eb` | 无变化 | 保留本地 recap、usage、Ralph 等独立契约 |
| [tomsej pi-ext](https://github.com/tomsej/pi-ext/commit/e132c44b3b06f88f7fcfb67b80c91698d8c1814f) | `e132c44b` | 无变化 | Worktime 设计参考，不换实现 |
| [替代实现：nicobailon Subagents](https://github.com/nicobailon/pi-subagents/commit/95683a4427e1e4af8de03f1a9ca03ec4c2799b73) | `95683a44`；GitHub release `v0.79.1` | 比早期基线多 124 commits | 参考信任、预算事实表达与按需工具设计，不导入其引擎 |
| [Dynamic Workflows 发布物](https://registry.npmjs.org/@quintinshaw%2fpi-dynamic-workflows) | npm `3.14.0`，`gitHead=3a52f19a` | 发布基线未变；GitHub/API 返回 404 | 当前 HEAD 未解决，不能声称无新增源码或已同步最新 |

Narumi 比较同时检查完整树，避免 GitHub compare 的文件截断。Analytics、Statusline、Worktree、Stamp
两端的 `src` tree SHA 相同；开发依赖变化不能包装为运行行为更新。发布标签与 HEAD 也不混为一谈。

### 实际采用与不采用

- **采用 Subagents 恢复预算与清理模式**：
  [`d7c9ec0b`](https://github.com/tintinweb/pi-subagents/commit/d7c9ec0b027b91c7ab9da0fa5f4ae203474a5bdf)、
  [`ca93a524`](https://github.com/tintinweb/pi-subagents/commit/ca93a5247e72e7053fcd10bea7125d6c4205f949)、
  [`83be963a`](https://github.com/tintinweb/pi-subagents/commit/83be963a969eb359af29cbbb4d4af2d01748bfb5)。
  前两项在观察时尚未进入 `v0.22.0` tag；逐项回归，不整包替换。保留 managed protocol v4、
  branch/attempt ownership、独立 Workflows journal 和现有预算策略。
- **无需重复同步 LSP 的 session cwd 修复**：
  [Narumi `df7c88e`](https://github.com/narumiruna/pi-extensions/commit/df7c88e3b66312d608be06bcabd553d0cca974d7)
  对应不变量本地已具备：diagnostics/fix 先调用 `resolveRoot(params.root, ctx.cwd)`，再路由和执行。
- **不机械复制 Goal/Plan 的 custom-run early return**：
  [Narumi `fed7bfb`](https://github.com/narumiruna/pi-extensions/commit/fed7bfba581674acd2fb162e99124895aa4ca839)
  对应的新宿主事件确实可能没有 `prompt`，但本地 Goal 的输入归属检查拒绝非字符串，Plan 的修订授权
  来自已接受的用户输入，而非每次 hook 都作废 ready。整段提前返回还会漏掉有意保留的 Plan 指导。
  静态反证不等于已完成整个 Pi 1.3 兼容性验收；本次不升级开发宿主。
- **不引入自动多跑一轮或损失性回退**：Codex 的新增自动轮次会消耗额度并可能执行工具；
  opaque 失败后放行原生压缩不能还原旧上下文。本地改为保护当前 opaque 边界。
- **继续暂缓 package agent/workflow 自动发现、raw parent-history inheritance、第二套配置与编排引擎**。
  资源信任、成本和恢复语义不能作为 UI 更新的附带变化。

## 经复现的本地修复

下列缺陷都先经过独立反证检查，再落实回归。并非全部声称来自上游移植。

| 范围 | 经确认的失败场景 | 修复边界 |
| --- | --- | --- |
| Todo | 每次成功结果、上下文与进度状态重复冗长的存储说明 | 正常文件存储保持安静；内存、不曾持久化和不可用状态仍显式报告；持久化逻辑不变 |
| Subagents | 恢复执行没有 fresh-run 的回合限制；关闭后 group join timer 仍可投递 | 恢复运行使用既有预算策略，UI 与执行使用同一有效限额；截断结果向模型显式标明未完成；已确认 shutdown 才退休计时与投递 |
| Ralph | 活动迭代在后续异步 tool hook 等待时 resume，旧信号未取消但所有权已被领取 | 活动操作不能被 resume 静默替换；暂停／未绑定的合法恢复仍保留 |
| Ralph | 小数、负数或不安全整数通过工具 schema，任务文件先被覆盖，状态发布才失败 | 工具和命令全量验证计数后才产生文件或所有权副作用；保留合法零值和默认值 |
| LSP | 等 code actions 时外部编辑已保存，`write:true` 却基于旧快照覆盖 | 提交前复核内容、身份与路径；发现冲突拒绝，不把原生 mutation queue 宣称为外部写锁 |
| Codex Compact | 首次远端压缩成功，下一次远端失败后原生摘要取代 opaque 边界 | 当前边界为 opaque 时取消；首次远端失败及已被原生合法取代的旧 opaque 记录仍允许授权回退 |

Codex 缺陷是**有效模型上下文丢失，不是删除原始 session 文件**。受控复现检查了实际 Pi 1.0.4
preparation：原生摘要仅看到 fallback 文本与近期消息，无法解密旧 checkpoint。修复不扫描并复活
已被新边界取代的历史 checkpoint，不改变凭据安全边界。

## 31 个扩展的职责与取舍

这是能力及组合建议，不是任何特定环境的启用清单，也不是每个插件都必须常开的建议。

| 扩展 | 独有职责 | 建议 |
| --- | --- | --- |
| pi-subagents | 子会话、执行策略、并发、隔离和停止 | 多代理执行核心 |
| pi-workflows | DAG、阶段、journal、恢复和综合 | 配 Subagents 用于有限编排，不替它决定模型成本 |
| pi-goal | 目标续跑与最终验收责任 | 普通自主实施优先 |
| pi-ralph-wiggum | 文件化、可重跑的迭代节奏和反思 | 明确需要迭代文件时用；通常不与 Goal 同时控制续跑 |
| pi-plan-mode | 实施前的只读协作和批准计划交接 | 阶段性策略，不是执行器 |
| pi-todo | 当前分支的显式检查表 | 需人工／模型维护清单时用；勾选不是执行证据 |
| pi-approvals | 针对具体操作的人类批准 | 独立可选；不是工具准入、项目信任或 OS 沙箱 |
| pi-ask-user-question | 结构化决策与取消 | 与操作审批不同，保留一个决策入口即可 |
| pi-agent-guidance | 额外 provider/model 专属指导文件 | 统一使用原生上下文文件时可省 |
| pi-background | 本地进程组、日志、监视和通知 | 有并行构建／服务监视需求时用，不是持久服务 |
| pi-worktree | 人工 Git worktree 管理和工作区切换 | 项目允许且确需人工管理时用，不等于 session fork |
| pi-lsp | 按需诊断与 source fixes | 项目原生检查很快时价值有限，不替代 CI |
| pi-github-pr | 被动 PR／checks／review 状态 | GitHub 开发场景可选 |
| pi-files-widget | 文件／diff 浏览与选行评论 | 已满足审查需求时不再叠装类似外部 UI |
| pi-code-actions | 回答中代码块的复制、插入和确认执行 | 只需复制最后回复时原生 `/copy` 足够 |
| pi-btw | 不污染主线程的人工侧问题 | 有侧问需求再用；不是子代理或问用户工具 |
| pi-gpt-fast | 特定模型/API 的 priority 请求层开关 | 按需；不是更小模型，也不承诺固定计价 |
| pi-recall | 人工精选并跨会话引用单条消息 | 不保存摘录时可省，非自动长期记忆 |
| pi-session-recap | 离开后返回当前会话的模型摘要 | 经常切换且确需摘要时用；有额外模型成本 |
| pi-sessions | 人工导航及经审核的可编辑摘要交接 | 仅恢复历史先用原生 `/resume`；需 handoff 再用 |
| pi-input-history | 搜索、复用原始提示 | 与装饰编辑器不重叠 |
| pi-input-prefix | 编辑器外观装饰 | 纯偏好，可省 |
| pi-statusline | footer 渲染 | 只消费状态，不拥有其他包的业务状态；此次布局不变 |
| pi-tab-status | 终端标题指示 | 多标签场景可选，不必并入 footer |
| pi-welcome | 启动资源与仓库概览 | 偏信息展示，可省 |
| pi-herdr-state | 对外部 pane 管理器报告状态 | 无对应集成时可省 |
| pi-usage-extension | 持久会话用量汇总和导出 | 关注 tokens／费用时优先，区别于运行事件统计 |
| pi-analytics | 跨会话工具／skill／可靠性派生统计 | 只有确需这些指标时开启，不能当账单或审计日志 |
| pi-stamp | transcript 时间与工具耗时注记 | 需要追溯单条记录时用，否则可省 |
| pi-worktime | 每次提示的活跃时长 | 与历史费用、精确网络耗时不同；不关注工时可省 |
| pi-codex-compact | provider-specific 远端 opaque 压缩与重放 | 强可移植性需求优先原生压缩；已有 checkpoint 要先安全迁移 |

`pi-ui`、`pi-subagents-protocol`、`pi-approval-core` 是库，不是应单独启用的三个插件。

### 重要组合限制

- **Goal 与 Ralph 没有显式互斥**。两者都能续跑；Goal 的自动响应上限不是整个组合的总预算。
  同一会话一般只选择一个续跑控制器；Goal＋有限 Workflows 则可由 Goal 负责最终验收。
- Usage、Analytics、Stamp、Worktime 分别回答历史用量、派生统计、逐消息记录、活跃时长。
  不是同一账本，不能把数字简单相加，也不必全部开启。
- Recall／Recap／Sessions 分别是摘录、摘要、导航交接。先明确需求再选，不叠加成自动记忆系统。
- Files Widget 的 Agent 修改归因目前主要跟踪原生 write/edit。Git diff 仍显示其他改动，但不能
  把归因标记当作全部工具写入的审计证据；不通过猜测任意工具名称来扩大权限或归因。

## 新候选：只调查，不默认引入

| 候选及固定来源 | 真正增量 | 暂不引入的理由与验收门槛 |
| --- | --- | --- |
| [Narumi pi-inspect](https://github.com/narumiruna/pi-extensions/tree/6eedf914c8e7a5780c9b7cc8e64571cc7c970302/packages/pi-inspect) | 按需查看请求、缓存和工具链 | 浏览器可见提示／代码／结果；关标签不等于停采集，先验证授权、服务监听、停止与脱敏边界 |
| [Narumi pi-notify](https://github.com/narumiruna/pi-extensions/tree/6eedf914c8e7a5780c9b7cc8e64571cc7c970302/packages/pi-notify) | 离席后报告 settled | 可能外发主机／会话／路径等元数据；渠道、凭据、内容须先选择；settled 不等于成功 |
| [pi-docparser 4.0.0](https://github.com/maxedapps/pi-docparser/tree/931a0995067062c91bd81798ef226d120c31bd84) | 文档页码／坐标搜索和页面截图 | MIT，本地原生 LiteParse 依赖；OCR 可能下载数据或配置远程服务；已有提取工具时先比增量 |
| [pi-data-masking 0.10.0](https://github.com/Sevten/pi-data-masking/tree/acfa09312b6556f330f8e0e0f34bbb0c45e1b673) | 模型视图遮罩和工具前恢复 | MIT；本地会话仍含明文；provider 包装、恢复和审批组合面较大，不能当万能防泄漏 |
| [pi-otel 0.2.3](https://github.com/damngamerz/pi-otel/tree/1310697d160db7ec95951571dff9146fa4999523) | 关联 traces／metrics，不是又一个费用条 | 发布 peers `>=0.80.10 <0.81.0` 不含当前测试基线；先解决声明及导出隐私，再做真实链路验收 |
| [pi-macos-computer-use 0.3.2](https://github.com/Sur-Cai/macos-computer-use-kit/tree/8ea7684138abd9c8275fa26b815202bbaa819cd9) | 原生桌面观察、动作、读回验证 | MIT；平台与 AX／屏幕权限、Python 依赖扩大能力边界；只有真实 GUI 需求才值得采用 |

这些候选都没有在本次安装或运行验收。集合包只选单项资源，不能为一种能力默认加载全部插件。

## 三条实验警告如何处理

### Recall：格式与交互还没有稳定迁移契约

默认不自动保存／注入；手动保存形成长期本地明文副本，权限位不等于加密。保留 v1 存储，
停用时不删除数据即可；删除记录不擦除备份或已经引用到 session 的副本。只用历史查阅与复制时，
优先原生 `/resume`、`/tree`、`/copy`。有稳定迁移、备份恢复和发布契约后再讨论转 stable。

### Analytics：派生指标，不是完整网络日志或计费账单

加载即自动采集，关 dashboard 不停采集。持久化只保存允许的元数据，无已知上传路径；
但时间、模型、工具和 skill 名称仍可敏感。reload/cache-warming 的 hook 归属存在观测缺口，
请求错误可能漏计。历史 SQLite 不自动迁移到当前 JSONL。只看用量可用 Usage 或原生 `/session`；
需要工具／skill 可靠性分析才保留 Analytics，不为安静而把它标 stable。

### Codex Compact：三者里最需要认真保留的警告

完整重放依赖扩展、`openai-codex-responses` 和创建 checkpoint 的**同一 model ID**；
opaque 内容不可检查或选择性脱敏。`allowCanonicalHistory` 只授权新压缩，不是对已有 checkpoint
重放的开关；重放也可能重新引入普通请求过滤器隐藏的内容。

新会话若优先可移植性，可不加载此扩展，使用原生压缩。**已有 opaque 会话不要直接卸载、
关闭或切模型后 `/compact` 并把结果当无损迁移**。先私密备份完整 JSONL，在压缩前分支／副本
重建并核对可读摘要，再迁移。本次取消损失性失败回退，只保护启用且支持的 Remote V2 路径，
不是对关闭扩展或其他 provider 的通用压缩防护。

## 验收与发布边界

开发依赖仍固定 Pi **1.0.4**；本次不将阅读新宿主文档等同于新宿主全矩阵通过。

五个修改包的分包 lint／typecheck／tests 已通过：Todo 185、Codex Compact 161、LSP 85、
Ralph 91、Subagents 2,046（另有四个既存的可选 live-provider skips，不视为线上验收）。
Todo 的实际离线 CLI 也在 regular 和 fullscreen PTY 中通过，编辑与导航不触发模型轮次。
一次完整运行在既有审批计时测试失败：正向断言要求真实子进程在 40ms 墙钟预算内写完。
隔离的 49 项检查通过后，将正向等待排除验证改为显式 lifecycle 事件及可控单调时钟，
不再把操作系统调度速度当作正确性条件；实际后端和真实挂起命令的负向超时检查保留。
该文件随后重复运行 10/10 通过，完整 Subagents 检查也通过，生产超时参数和逻辑没有因此放宽。
独立纯内存复现核对了 720 个恢复策略组合（其中 144 个排队场景），策略／UI 不一致为零；
这不是 live-provider 测试，也不取代完整仓库检查。

可重跑的仓库内验收入口：

```sh
bun run --cwd packages/pi-todo check
bun run --cwd packages/pi-codex-compact check
bun run --cwd packages/pi-lsp check
bun run --cwd packages/pi-ralph-wiggum check
bun run --cwd packages/pi-subagents check
evidence=$(mktemp -d)
python3 packages/pi-todo/test/prefill-cli.py "$evidence"
bun run check
git diff --check
```

**最终完整 `bun run check` 已通过（exit 0）**，覆盖配置／边界／版本／Changesets／能力检查、
所有包 lint／typecheck／tests、集成与发布／配置测试、31 个独立扩展 tarball loader、
Subagents＋Workflows 组合、24 个 stable 扩展同时加载、34 包打包验证和凭据扫描。
最后运行前后所有 Git 跟踪及未忽略的 `packages/` 文件指纹一致：
`122114b1de8b8ca94010e20fbe53c79f0c7f753cea5924c7fef2e50178e0936a`（SHA-256）。
职责清单覆盖 31 个扩展及三个库；该轮选择性修复只修改五个包，均有 Changeset，Statusline 在该轮无差异。后续明确批准的 UI 改动及其独立验收见下节。

这些证据不构成真实 provider／OAuth、外部 LSP、通知服务、物理终端或其他宿主／平台的全面验收。
运行中的已安装发布物不会因为源码改动自动替换；必须经过独立 Changesets 发版、更新安装和
重新加载。没有全局配置改写、安装、发布或私有历史迁移。

## 后续明确批准的任务 UI 改进

用户随后选择先完成 UI，再与五包修复一起提交、发版；最终涉及八个包。范围是后台 **shell**
任务的列表／详情／日志导航、状态栏选择后打开拥有者详情，以及 Fleet 的间距和类型标识。
“Workflow UI 变了”的反馈最终定位为 Workflow 与 Agent 图标相同，不重做现有 Workflow
布局或详情交互。Workflow 分组改用 `▸`，Fleet 删除重复尾部空行，只保留一行分隔。

Statusline 新增 `/statusline inspect` 与 Ctrl+Alt+S，通过独立、可选的版本 1 UI 事件协议
进入 Background／Workflows 拥有的现有视图；不以命令字符串猜测拥有者，不发送模型消息，
也不修改显示筛选或用户设置。Background 的静默进程退出仍刷新状态，Workflows 的计数来自
运行本身，不能把子任务完成数当作 Workflow 已完成。协议及限制见
[任务与状态导航](status-navigation.md)。

独立八路复核发现并修复四个边界：冲突拥有者的状态键不能因过滤歧义而错误变成唯一归属；
配置按键优先于固定箭头回退；旧的延迟 Workflow 挂载不能占住或释放替代 surface 的槽位；
详情连续缩放保留原始文本锚点，而不是重复舍入后的行首。相应回归与分包检查通过：
Background 185、Statusline 226（另有 Node 上下文刷新检查）、Workflows 823。

新增私有根集成测试经公共 loader 加载四个扩展，覆盖两种加载顺序及 regular/fullscreen
渲染器，核对菜单与直接命令进入详情、草稿不变、无模型轮次和组合 Fleet/footer 间距。
后台 shell＋Statusline 的实际离线 CLI 在 Pi 1.0.4 和 1.3.0 各通过 112 项检查，包含
原生快捷键、外部对话框、CJK 草稿／光标、真实日志、确认停止与运行时 resize；不是物理
终端 IME 验收或所有宿主／平台兼容声明。合并改动仍须重新通过完整根检查和 CI，版本化及
npm 发布另由 Changesets／GitHub Actions 处理，不因这些局部验收而视为已发布。
