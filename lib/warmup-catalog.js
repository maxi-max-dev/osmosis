'use strict';

const path = require('node:path');

// The catalog is deliberately data-only.  It is safe to consult from the
// Ambient fast path because matching never asks a model, reads a rollout
// payload for display, or starts a subprocess.
const CATALOG_VERSION = 1;
const MAX_ARGV_TOKENS = 32;
const MAX_ARGV_TOKEN_LENGTH = 512;
const MAX_COMMAND_LENGTH = 4_096;
const USER_COPY_FIELDS = ['title', 'lesson', 'question', 'explanation'];

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}

function entry({ concept_id, aliases = [], triggers, title, lesson, question, options, correct_index, explanation }) {
  return {
    concept_id,
    aliases,
    triggers,
    title,
    lesson,
    question,
    options,
    correct_index,
    explanation,
  };
}

// Only a short, fixed Chinese teaching library is allowed on the warmup path.
// Code identifiers are intentionally formatted with backticks; no rollout
// command, file name, project name, server name, or tool name is ever copied
// into the learner-facing strings below.
const WARMUP_CATALOG = freeze({
  catalog_version: CATALOG_VERSION,
  concepts: [
    entry({
      concept_id: 'search-with-rg',
      aliases: ['rg', 'ripgrep', 'code-search'],
      triggers: [{ type: 'exec', argv: ['rg'] }],
      title: '用 `rg` 快速定位代码',
      lesson: '`rg` 会在项目文件中寻找符合条件的文字。它像一位熟悉档案柜位置的助手：先告诉你相关内容在哪，再决定要不要打开那一页。这样排查问题时不必靠记忆翻遍整个项目。',
      question: '运行 `rg` 最直接帮助了什么？',
      options: ['快速找出可能相关的位置，再决定查看哪里。', '自动修改所有找到的内容。', '把所有文件打包成一个新项目。'],
      correct_index: 0,
      explanation: '对。`rg` 的职责是搜索和定位；是否修改、如何修改，仍要由后续步骤决定。',
    }),
    entry({
      concept_id: 'node-test-runner',
      aliases: ['node-test', 'node:test', 'test-runner'],
      triggers: [{ type: 'exec', argv: ['node', '--test'] }],
      title: '让 `node --test` 检查行为',
      lesson: '`node --test` 会按事先写好的小问题检查程序行为。它像出门前逐项核对清单：不是证明一切完美，而是尽早发现某个已知承诺被改坏了。',
      question: '`node --test` 最像下面哪件事？',
      options: ['按清单检查重要行为是否仍然成立。', '把项目自动发布给所有人。', '把所有测试内容翻译成另一种语言。'],
      correct_index: 0,
      explanation: '对。测试把重要预期写成可重复的检查，修改后能迅速确认它们是否还成立。',
    }),
    entry({
      concept_id: 'package-install',
      aliases: ['npm-install', 'dependency-install', 'dependencies'],
      triggers: [
        { type: 'exec', argv: ['npm', 'install'] },
        { type: 'exec', argv: ['npm', 'ci'] },
      ],
      title: '用 `npm` 准备项目依赖',
      lesson: '项目会把需要借用的工具列成清单。`npm` 根据这份清单把合适版本准备到本地，像开工前按配方备齐原料；它不会替你决定菜要怎么做。',
      question: '安装依赖主要是在做什么？',
      options: ['按项目清单准备运行和开发所需的工具。', '把项目中的所有问题自动修好。', '把当前代码永久锁定不能再改。'],
      correct_index: 0,
      explanation: '对。依赖安装是在准备工具和版本，而不是替代设计、调试或提交代码。',
    }),
    entry({
      concept_id: 'package-script',
      aliases: ['npm-run', 'project-script'],
      triggers: [{ type: 'exec', argv: ['npm', 'run'] }],
      title: '通过 `npm run` 复用项目流程',
      lesson: '`npm run` 把常用操作起了统一名字。它像厨房里的预设按钮：按下同一个按钮，每个人都会执行同一套步骤，减少口头约定和手工输入造成的偏差。',
      question: '项目脚本的主要价值是什么？',
      options: ['让重复操作以统一方式被执行。', '让任何命令都不需要配置。', '让程序不再需要测试。'],
      correct_index: 0,
      explanation: '对。脚本把重复流程固定下来，团队成员和自动化工具都能使用相同入口。',
    }),
    entry({
      concept_id: 'git-status',
      aliases: ['version-status', 'working-tree-status'],
      triggers: [{ type: 'exec', argv: ['git', 'status'] }],
      title: '用 `git status` 看清改动状态',
      lesson: '`git status` 像收拾行李前的清点单：哪些东西刚放进去、哪些还没装、哪些已经准备好交出去，一眼就能分清。它不改变内容，只说明现在处于什么状态。',
      question: '`git status` 最适合回答什么问题？',
      options: ['当前有哪些改动，以及它们准备到了哪一步。', '哪个改动一定没有错误。', '下一次发布会在什么时候发生。'],
      correct_index: 0,
      explanation: '对。它提供工作区状态，不会替人判断代码质量或安排发布。',
    }),
    entry({
      concept_id: 'git-diff',
      aliases: ['version-diff', 'change-comparison'],
      triggers: [{ type: 'exec', argv: ['git', 'diff'] }],
      title: '用 `git diff` 对照改了什么',
      lesson: '`git diff` 把修改前后并排比较，像校对稿上的增删标记。它让人把注意力放在变化本身，而不是重新阅读全部内容。',
      question: '为什么在提交前查看差异很有用？',
      options: ['能集中检查这次实际改变的部分。', '能让改动自动通过测试。', '能把所有旧版本立即删除。'],
      correct_index: 0,
      explanation: '对。差异视图缩小了检查范围，但仍需要人或测试判断改动是否正确。',
    }),
    entry({
      concept_id: 'git-commit',
      aliases: ['version-commit', 'savepoint'],
      triggers: [{ type: 'exec', argv: ['git', 'commit'] }],
      title: '用 `git commit` 留下可追溯存档',
      lesson: '`git commit` 会把一组已经选定的改动记录成一个有说明的存档点。它像给完成的一小段工作贴上日期和标签，日后能知道当时为什么这样改。',
      question: '一次提交最重要的作用是什么？',
      options: ['把一组相关改动保存为可追溯的记录。', '让程序自动部署到线上。', '让其他改动从此无法发生。'],
      correct_index: 0,
      explanation: '对。提交提供历史和边界；发布、协作和后续修改仍是独立步骤。',
    }),
    entry({
      concept_id: 'git-branch-switch',
      aliases: ['branch-switch', 'version-branch'],
      triggers: [
        { type: 'exec', argv: ['git', 'switch'] },
        { type: 'exec', argv: ['git', 'checkout'] },
      ],
      title: '切换分支来隔离工作线',
      lesson: '分支像同一份地图上的不同透明图层。切换分支可以先查看或继续另一条工作线，而不会把两条尚未整理好的路线混在一起。',
      question: '分支切换主要帮助避免什么？',
      options: ['把不同工作线的未整理改动混在一起。', '任何人再也看不到历史记录。', '项目需要使用版本控制。'],
      correct_index: 0,
      explanation: '对。分支帮助隔离不同方向的工作，同时仍保留共同的历史基础。',
    }),
    entry({
      concept_id: 'file-watching',
      aliases: ['watch-mode', 'fs.watch', 'live-reload'],
      triggers: [{ type: 'exec', argv: ['node', '--watch'] }],
      title: '用 `node --watch` 跟随文件变化',
      lesson: '`node --watch` 会留意指定文件是否变化，并在变化后重新开始相关工作。它像值班员听见门铃就重新检查，而不是让人每次修改后手动提醒。',
      question: '监听模式减少了哪一种重复？',
      options: ['每次修改后手动重新启动同一项检查。', '每次修改前先写测试。', '每次提交前查看历史。'],
      correct_index: 0,
      explanation: '对。监听模式自动响应变化；它不会代替对结果的判断。',
    }),
    entry({
      concept_id: 'code-linting',
      aliases: ['lint', 'eslint', 'static-check'],
      triggers: [
        { type: 'exec', argv: ['npx', 'eslint'] },
        { type: 'exec', argv: ['npm', 'run', 'lint'] },
      ],
      title: '让静态检查提前发现常见问题',
      lesson: '静态检查会在程序真正运行前查看结构和常见约定。它像交稿前的格式检查员，能抓住不少低成本的问题，却不能替代对实际功能的验证。',
      question: '静态检查最擅长发现哪类问题？',
      options: ['结构和约定中能提前识别的常见问题。', '所有用户在未来会提出的需求。', '线上环境一定发生过的故障。'],
      correct_index: 0,
      explanation: '对。静态检查覆盖的是可从代码形状判断的一部分问题，功能验证仍然重要。',
    }),
    entry({
      concept_id: 'code-formatting',
      aliases: ['format', 'prettier', 'style-format'],
      triggers: [
        { type: 'exec', argv: ['npx', 'prettier'] },
        { type: 'exec', argv: ['npm', 'run', 'format'] },
      ],
      title: '用格式化工具统一代码外观',
      lesson: '格式化工具把缩进、换行和空格整理成一致样子。它像把同一份表格按统一规则排版，让阅读者把注意力放在内容，而不是每个人不同的排版习惯。',
      question: '格式化工具主要改变什么？',
      options: ['代码的排版和外观一致性。', '程序要实现的业务目标。', '依赖包的授权方式。'],
      correct_index: 0,
      explanation: '对。格式化通常不改变程序意图，重点是让协作时的阅读成本更低。',
    }),
    entry({
      concept_id: 'browser-navigation',
      aliases: ['browser-open', 'browser-preview'],
      triggers: [{ type: 'mcp', server: 'browser', tool: 'open' }],
      title: '在浏览器中打开真实页面',
      lesson: '打开页面是把程序结果放到真实使用环境里看一眼。它像把舞台布景真正点亮，而不只是在图纸上判断；有些问题只有运行后才会出现。',
      question: '为什么需要在浏览器中查看页面？',
      options: ['有些视觉和交互问题只有运行后才看得见。', '浏览器会自动替项目写完功能。', '打开页面会让测试不再需要。'],
      correct_index: 0,
      explanation: '对。运行中的页面提供真实反馈，但仍需要结合测试和检查来判断结果。',
    }),
    entry({
      concept_id: 'browser-screenshot',
      aliases: ['visual-evidence', 'visual-check'],
      triggers: [{ type: 'mcp', server: 'browser', tool: 'screenshot' }],
      title: '用截图留下视觉检查证据',
      lesson: '截图把某一刻的页面状态固定下来，像给现场拍一张可回看的照片。它方便比较修改前后，也能让不在现场的人理解当时实际看到了什么。',
      question: '截图最适合作为哪一种材料？',
      options: ['某一时刻页面外观的可回看证据。', '保证所有设备显示完全相同的承诺。', '替代所有交互操作的记录。'],
      correct_index: 0,
      explanation: '对。截图记录一个视觉瞬间；不同设备和后续交互仍可能呈现不同结果。',
    }),
    entry({
      concept_id: 'browser-interaction',
      aliases: ['browser-click', 'browser-action'],
      triggers: [{ type: 'mcp', server: 'browser', tool: 'click' }],
      title: '通过点击验证交互路径',
      lesson: '点击是在模拟用户沿着某条路径使用界面。它像亲手按下门铃确认铃会响：静态画面看起来正确，不等于操作后真的有预期反应。',
      question: '点击检查补上了静态页面缺少的什么信息？',
      options: ['用户操作后界面是否做出预期反应。', '页面文件的全部历史。', '服务器硬件的购买时间。'],
      correct_index: 0,
      explanation: '对。交互检查关注动作和反馈之间的连接，而不仅是页面的初始外观。',
    }),
    entry({
      concept_id: 'filesystem-reading',
      aliases: ['read-file', 'filesystem-read', 'file-inspection'],
      triggers: [{ type: 'mcp', server: 'filesystem', tool: 'read_file' }],
      title: '先读取文件再判断改动',
      lesson: '读取文件是在动手前确认现状。它像修理前先打开说明书和查看零件位置，避免凭猜测改到不该动的地方。',
      question: '先读取相关文件的价值是什么？',
      options: ['根据真实现状做判断，而不是凭猜测修改。', '让文件从此不能再被修改。', '自动把所有文件合并成一个。'],
      correct_index: 0,
      explanation: '对。理解当前内容能减少误改风险，但不等于已经完成修复。',
    }),
    entry({
      concept_id: 'pull-request-review',
      aliases: ['github-review', 'change-review', 'pull-request'],
      triggers: [{ type: 'mcp', server: 'github', tool: 'get_pull_request' }],
      title: '通过评审理解改动边界',
      lesson: '评审把改动放到另一个人的视角下检查。它像请同伴沿着你刚走过的路线再走一遍，常能发现自己因为太熟悉而忽略的岔路。',
      question: '评审最有价值的地方是什么？',
      options: ['引入不同视角来检查改动的边界和影响。', '保证任何改动都不再需要测试。', '让所有人必须采用同一种写法。'],
      correct_index: 0,
      explanation: '对。评审增加独立检查，不是自动保证正确性的魔法步骤。',
    }),
    entry({
      concept_id: 'javascript-change',
      aliases: ['javascript', 'js', 'ecmascript'],
      triggers: [
        { type: 'patch', extension: '.js' },
        { type: 'patch', extension: '.mjs' },
        { type: 'patch', extension: '.cjs' },
        { type: 'patch', extension: '.jsx' },
      ],
      title: '理解脚本逻辑的改动',
      lesson: '脚本文件常用来描述程序在收到输入后应如何行动。修改它像调整一份流程说明：同一个按钮被按下时，后面会走向不同的步骤。',
      question: '脚本逻辑改动最可能影响什么？',
      options: ['程序收到输入后采取的步骤。', '显示器的物理亮度。', '项目文件夹的创建日期。'],
      correct_index: 0,
      explanation: '对。脚本通常描述行为流程，因此改动需要结合输入和结果一起检查。',
    }),
    entry({
      concept_id: 'typescript-change',
      aliases: ['typescript', 'ts', 'typed-javascript'],
      triggers: [
        { type: 'patch', extension: '.ts' },
        { type: 'patch', extension: '.tsx' },
      ],
      title: '用类型约束表达数据形状',
      lesson: '类型像给数据贴上的形状标签：这里应放数字、那里应放姓名或一组项目。它让工具在运行前就能发现一些“盒子里装错东西”的问题。',
      question: '类型约束最直接帮助防止什么？',
      options: ['把不符合预期形状的数据放进错误位置。', '所有界面都自动变得更漂亮。', '所有网络请求都自动成功。'],
      correct_index: 0,
      explanation: '对。类型能提前发现一类数据不匹配问题，但不能覆盖所有运行时情况。',
    }),
    entry({
      concept_id: 'style-change',
      aliases: ['css', 'styles', 'visual-style'],
      triggers: [{ type: 'patch', extension: '.css' }],
      title: '用样式规则安排页面外观',
      lesson: '样式规则决定文字、间距、颜色和布局如何呈现。它像给房间制定摆放规则：家具没有变，但位置、层次和舒适感会明显不同。',
      question: '样式改动主要影响什么？',
      options: ['页面内容呈现出来的外观和布局。', '数据在数据库中的历史。', '版本控制的提交顺序。'],
      correct_index: 0,
      explanation: '对。样式主要负责呈现，页面行为和数据处理通常由其他部分承担。',
    }),
    entry({
      concept_id: 'markup-change',
      aliases: ['html', 'markup', 'page-structure'],
      triggers: [{ type: 'patch', extension: '.html' }],
      title: '用页面结构表达内容层级',
      lesson: '页面结构描述哪些内容是标题、段落、按钮或区域。它像搭建房屋骨架：先分清房间和通道，之后再安排装饰和互动。',
      question: '页面结构最先解决什么问题？',
      options: ['内容之间的层级和组成关系。', '每个用户的网络速度。', '项目的发布日程。'],
      correct_index: 0,
      explanation: '对。结构给内容一个清晰骨架，再由样式和行为让它完整呈现。',
    }),
    entry({
      concept_id: 'data-file-change',
      aliases: ['json', 'data-file', 'structured-data'],
      triggers: [{ type: 'patch', extension: '.json' }],
      title: '用结构化数据保存明确关系',
      lesson: '结构化数据把信息按固定字段组织起来，像一张填写格式统一的表单。程序因此能稳定地找到每一项，而不用从一大段描述里猜意思。',
      question: '结构化数据的关键好处是什么？',
      options: ['让程序能按明确字段稳定读取信息。', '让数据永远不需要更新。', '让所有信息都必须公开。'],
      correct_index: 0,
      explanation: '对。固定结构降低理解歧义，但数据仍需要正确维护和验证。',
    }),
    entry({
      concept_id: 'documentation-change',
      aliases: ['markdown', 'md', 'documentation'],
      triggers: [{ type: 'patch', extension: '.md' }],
      title: '把决策写进项目说明',
      lesson: '说明文件把目标、用法和取舍留给未来的读者。它像给接手的人留下一张清楚的便签：不仅知道现在有什么，也知道为什么这样安排。',
      question: '项目说明最能帮助谁？',
      options: ['未来需要理解项目的人，包括之后的自己。', '只帮助已经记得全部细节的人。', '自动替项目完成运行。'],
      correct_index: 0,
      explanation: '对。说明把上下文保存下来，尤其能减少未来重新猜测决策原因的成本。',
    }),
    entry({
      concept_id: 'python-change',
      aliases: ['python', 'py'],
      triggers: [{ type: 'patch', extension: '.py' }],
      title: '通过脚本组织自动步骤',
      lesson: '脚本可以把一连串重复动作写成可重复执行的流程。它像把每天的手工步骤写成食谱：材料和顺序清楚后，别人也能按同样方式完成。',
      question: '自动脚本最适合减少什么？',
      options: ['重复而容易漏步骤的手工操作。', '所有需要人做判断的决定。', '所有项目中的数据量。'],
      correct_index: 0,
      explanation: '对。脚本擅长稳定执行已定义步骤，判断目标是否合理仍需要人参与。',
    }),
    entry({
      concept_id: 'database-query-change',
      aliases: ['sql', 'database-query', 'data-query'],
      triggers: [{ type: 'patch', extension: '.sql' }],
      title: '用查询描述想取得的数据',
      lesson: '查询是在向数据仓库说明你想要哪些记录、按什么条件筛选。它像在图书馆提出一张明确借书单：条件越清楚，取回的结果越接近所需。',
      question: '查询条件最直接决定什么？',
      options: ['会被选出来的记录范围。', '页面字体的大小。', '版本提交的作者。'],
      correct_index: 0,
      explanation: '对。条件决定筛选边界，因此修改查询时要特别留意是否扩大或缩小了结果。',
    }),
    entry({
      concept_id: 'go-change',
      aliases: ['go', 'golang'],
      triggers: [{ type: 'patch', extension: '.go' }],
      title: '把并发工作分成可协调任务',
      lesson: '并发让多项等待中的工作可以交错推进，像厨房里煮水时同时切菜。关键不是同时做得越多越好，而是让每项任务在合适时机交换结果。',
      question: '并发最适合处理哪种情形？',
      options: ['多项会等待彼此不同资源的工作。', '把一个错误隐藏起来不再显示。', '让所有任务必然同时结束。'],
      correct_index: 0,
      explanation: '对。并发能改善等待安排，但仍需要清楚协调顺序和共享资源。',
    }),
    entry({
      concept_id: 'rust-change',
      aliases: ['rust', 'memory-safety'],
      triggers: [{ type: 'patch', extension: '.rs' }],
      title: '在编译前检查资源使用边界',
      lesson: '资源使用边界像借用物品时的登记规则：谁在使用、何时归还、能否同时交给别人，需要尽量在动手前说清。这样能减少运行时才暴露的混乱。',
      question: '提前检查资源边界想减少什么？',
      options: ['多人或多步骤使用同一资源时的混乱。', '所有程序的启动时间。', '所有界面的视觉差异。'],
      correct_index: 0,
      explanation: '对。提前约束资源使用能防住一类问题，但仍要验证整体行为是否符合需要。',
    }),
    entry({
      concept_id: 'shell-automation',
      aliases: ['shell', 'script', 'command-automation'],
      triggers: [{ type: 'patch', extension: '.sh' }],
      title: '把命令步骤写成可重复流程',
      lesson: '命令流程写下来后，每次执行都会遵循相同顺序。它像把活动准备清单贴在墙上，既能减少遗漏，也让别人知道这套流程包含哪些环节。',
      question: '命令自动化最明显减少什么风险？',
      options: ['重复执行时漏掉某个固定步骤。', '任何外部服务都不可用。', '所有项目都需要同一套工具。'],
      correct_index: 0,
      explanation: '对。自动化让固定步骤更一致，但外部条件和业务判断仍要单独处理。',
    }),
  ],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/u.test(value);
}

function onlyCodeMayContainLatin(value) {
  const outsideCode = value.replace(/`[^`\r\n]+`/g, '');
  return !/[A-Za-z]/.test(outsideCode);
}

function validConceptId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{1,95}$/.test(value);
}

function validAlias(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9:._/-]{0,95}$/.test(value);
}

function validArgv(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_ARGV_TOKENS
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_ARGV_TOKEN_LENGTH);
}

function validTrigger(trigger) {
  if (!isPlainObject(trigger) || typeof trigger.type !== 'string') {
    return false;
  }
  if (trigger.type === 'exec') {
    return Object.keys(trigger).length === 2 && validArgv(trigger.argv);
  }
  if (trigger.type === 'patch') {
    return Object.keys(trigger).length === 2 && typeof trigger.extension === 'string' && /^\.[a-z0-9]{1,12}$/.test(trigger.extension);
  }
  if (trigger.type === 'mcp') {
    return Object.keys(trigger).length === 3
      && typeof trigger.server === 'string'
      && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(trigger.server)
      && typeof trigger.tool === 'string'
      && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(trigger.tool);
  }
  return false;
}

function validateChineseCopy(value, location, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${location} 缺少中文文案`);
    return;
  }
  if (!hasChinese(value)) {
    errors.push(`${location} 必须包含自然中文`);
  }
  if (!onlyCodeMayContainLatin(value)) {
    errors.push(`${location} 的非中文内容必须使用反引号标记代码标识符`);
  }
}

/**
 * Validate an arbitrary catalog before it is allowed to serve a learner.
 * Validation returns data instead of throwing so the owner can ledger a
 * `catalog-invalid` suppression and keep the agent's work uninterrupted.
 */
function validateWarmupCatalog(catalog = WARMUP_CATALOG) {
  const errors = [];
  if (!isPlainObject(catalog) || Object.keys(catalog).length !== 2) {
    return { valid: false, errors: ['卡库外层结构无效'] };
  }
  if (!Number.isInteger(catalog.catalog_version) || catalog.catalog_version < 1) {
    errors.push('卡库版本无效');
  }
  if (!Array.isArray(catalog.concepts) || catalog.concepts.length < 20) {
    errors.push('卡库至少需要二十个概念');
  }

  const conceptIds = new Set();
  const aliases = new Set();
  for (const [index, concept] of (Array.isArray(catalog.concepts) ? catalog.concepts : []).entries()) {
    const location = `概念 ${index + 1}`;
    if (!isPlainObject(concept) || Object.keys(concept).length !== 9) {
      errors.push(`${location} 结构无效`);
      continue;
    }
    if (!validConceptId(concept.concept_id)) {
      errors.push(`${location} 的概念标识无效`);
    } else if (conceptIds.has(concept.concept_id) || aliases.has(concept.concept_id)) {
      errors.push(`${location} 的概念标识重复`);
    } else {
      conceptIds.add(concept.concept_id);
    }
    if (!Array.isArray(concept.aliases) || concept.aliases.some((alias) => !validAlias(alias))) {
      errors.push(`${location} 的别名无效`);
    } else {
      for (const alias of concept.aliases) {
        if (aliases.has(alias) || conceptIds.has(alias)) {
          errors.push(`${location} 的别名重复`);
        }
        aliases.add(alias);
      }
    }
    if (!Array.isArray(concept.triggers) || concept.triggers.length === 0 || concept.triggers.some((trigger) => !validTrigger(trigger))) {
      errors.push(`${location} 的触发器无效`);
    }
    for (const field of USER_COPY_FIELDS) {
      validateChineseCopy(concept[field], `${location} 的${field}`, errors);
    }
    if (!Array.isArray(concept.options) || concept.options.length !== 3 || concept.options.some((option) => typeof option !== 'string' || !option.trim())) {
      errors.push(`${location} 的选项必须恰好有三个`);
    } else {
      for (const [optionIndex, option] of concept.options.entries()) {
        validateChineseCopy(option, `${location} 的选项 ${optionIndex + 1}`, errors);
      }
      if (new Set(concept.options).size !== 3) {
        errors.push(`${location} 的选项不能重复`);
      }
    }
    if (!Number.isInteger(concept.correct_index) || concept.correct_index < 0 || concept.correct_index > 2) {
      errors.push(`${location} 的正确答案无效`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function assertValidWarmupCatalog(catalog = WARMUP_CATALOG) {
  const result = validateWarmupCatalog(catalog);
  if (!result.valid) {
    throw new Error(`Warmup catalog is invalid: ${result.errors.join('; ')}`);
  }
  return catalog;
}

function localConceptId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const colon = value.indexOf(':');
  return colon > 0 && colon < value.length - 1 ? value.slice(colon + 1) : value;
}

function catalogEntryForConceptId(value, catalog = WARMUP_CATALOG) {
  const localId = localConceptId(value);
  if (!isPlainObject(catalog) || !Array.isArray(catalog.concepts) || !localId) {
    return null;
  }
  return catalog.concepts.find((concept) => concept?.concept_id === localId || concept?.aliases?.includes(localId)) || null;
}

// Provider cards and warmup cards can point at the same canonical concept
// without comparing their human-facing titles.  Namespaced provider ids are
// deliberately reduced to their local id for this lookup only.
function canonicalWarmupConceptId(value, catalog = WARMUP_CATALOG) {
  return catalogEntryForConceptId(value, catalog)?.concept_id || '';
}

function decodeInput(value) {
  if (isPlainObject(value) || Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.length > MAX_COMMAND_LENGTH) {
    return null;
  }
  let current = value.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = JSON.parse(current);
      if (isPlainObject(parsed) || Array.isArray(parsed)) {
        return parsed;
      }
      if (typeof parsed !== 'string') {
        return null;
      }
      current = parsed;
    } catch {
      return { cmd: current };
    }
  }
  return { cmd: current };
}

// This is a deliberately small shell-word reader, not a shell interpreter.
// It accepts plain argv-like commands and rejects composition, expansion, and
// redirection.  An unparseable command is a suppression, never a guess.
function parseSimpleArgv(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH) {
    return null;
  }
  if (/[\r\n;|&<>`$\\]/.test(command)) {
    return null;
  }
  const argv = [];
  let token = '';
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        argv.push(token);
        token = '';
      }
      continue;
    }
    token += char;
  }
  if (quote) {
    return null;
  }
  if (token) {
    argv.push(token);
  }
  if (!validArgv(argv)) {
    return null;
  }
  // Do not try to skip environment assignments or interpret `sh -c`: doing
  // so would turn a compound shell expression into a false positive.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    return null;
  }
  return argv;
}

function structuredArgvFromInput(input) {
  const decoded = decodeInput(input);
  if (Array.isArray(decoded)) {
    return validArgv(decoded) ? [...decoded] : null;
  }
  if (!isPlainObject(decoded)) {
    return null;
  }
  if (validArgv(decoded.argv)) {
    return [...decoded.argv];
  }
  const command = typeof decoded.cmd === 'string'
    ? decoded.cmd
    : typeof decoded.command === 'string'
      ? decoded.command
      : '';
  return parseSimpleArgv(command);
}

function payloadForEvent(event) {
  return isPlainObject(event?.payload) ? event.payload : isPlainObject(event) ? event : null;
}

function execObservation(event) {
  const payload = payloadForEvent(event);
  if (!payload || payload.type !== 'custom_tool_call' || payload.name !== 'exec') {
    return null;
  }
  const argv = structuredArgvFromInput(payload.input);
  if (!argv) {
    return null;
  }
  const first = path.basename(argv[0]);
  if (!first || first === '.' || first === path.sep) {
    return null;
  }
  return { type: 'exec', argv: [first, ...argv.slice(1)] };
}

function patchObservation(event) {
  const payload = payloadForEvent(event);
  if (!payload || payload.type !== 'patch_apply_end' || payload.success !== true || !isPlainObject(payload.changes)) {
    return null;
  }
  const extensions = [...new Set(Object.keys(payload.changes)
    .filter((filePath) => typeof filePath === 'string')
    .map((filePath) => path.extname(filePath).toLowerCase())
    .filter(Boolean))].sort();
  return extensions.length > 0 ? { type: 'patch', extensions } : null;
}

function mcpObservation(event) {
  const payload = payloadForEvent(event);
  const invocation = payload?.invocation;
  if (!payload || payload.type !== 'mcp_tool_call_end' || !isPlainObject(invocation)) {
    return null;
  }
  if (typeof invocation.server !== 'string' || typeof invocation.tool !== 'string') {
    return null;
  }
  return { type: 'mcp', server: invocation.server, tool: invocation.tool };
}

function observationsFromEvent(event) {
  return [execObservation(event), patchObservation(event), mcpObservation(event)].filter(Boolean);
}

function triggerMatchesObservation(trigger, observation) {
  if (trigger.type !== observation.type) {
    return false;
  }
  if (trigger.type === 'exec') {
    return trigger.argv.every((value, index) => observation.argv[index] === value);
  }
  if (trigger.type === 'patch') {
    return observation.extensions.includes(trigger.extension);
  }
  return observation.server === trigger.server && observation.tool === trigger.tool;
}

function publicTrigger(trigger) {
  if (trigger.type === 'exec') {
    return { type: 'exec', argv: [...trigger.argv] };
  }
  if (trigger.type === 'patch') {
    return { type: 'patch', extension: trigger.extension };
  }
  return { type: 'mcp', server: trigger.server, tool: trigger.tool };
}

function matchesForWarmupEvent(event, catalog = WARMUP_CATALOG) {
  const validation = validateWarmupCatalog(catalog);
  if (!validation.valid) {
    return [];
  }
  const observations = observationsFromEvent(event);
  const matches = [];
  for (const observation of observations) {
    for (const concept of catalog.concepts) {
      for (const trigger of concept.triggers) {
        if (triggerMatchesObservation(trigger, observation)) {
          matches.push({
            concept,
            observation: freeze({ ...observation, ...(observation.argv ? { argv: [...observation.argv] } : {}), ...(observation.extensions ? { extensions: [...observation.extensions] } : {}) }),
            trigger: publicTrigger(trigger),
          });
        }
      }
    }
  }
  return matches;
}

function toCanonicalSet(values, catalog) {
  const result = new Set();
  for (const value of values || []) {
    const canonical = canonicalWarmupConceptId(value, catalog);
    if (canonical) {
      result.add(canonical);
    }
  }
  return result;
}

function makeWarmupCandidate(match, {
  catalog = WARMUP_CATALOG,
  observation_id = null,
  activity_epoch_id = observation_id,
  warmup_id = null,
} = {}) {
  const concept = match?.concept;
  if (!concept) {
    return null;
  }
  return {
    kind: 'warmup',
    catalog_version: catalog.catalog_version,
    warmup_id,
    concept_id: concept.concept_id,
    concept_name: concept.title,
    observation_id,
    activity_epoch_id,
    title: concept.title,
    lesson: concept.lesson,
    question: concept.question,
    options: [...concept.options],
    correct_index: concept.correct_index,
    explanation: concept.explanation,
    trigger: match.trigger,
    state: {
      answered: false,
      chosen_index: null,
      correct: null,
    },
  };
}

/**
 * Catalog-only qualification.  The owner supplies durable project/studio
 * facts; this helper returns a stable, ledger-friendly reason rather than
 * making any write or starting any generation.
 */
function qualifyWarmupEvent({
  event,
  catalog = WARMUP_CATALOG,
  observation_id = null,
  activity_epoch_id = observation_id,
  warmup_id = null,
  masteredConceptIds = [],
  servedConceptIds = [],
  paused = false,
  registered = true,
  carried = true,
  nowKind = null,
  nextReady = false,
  rateLimited = false,
} = {}) {
  const validation = validateWarmupCatalog(catalog);
  if (!validation.valid) {
    return { qualified: false, reason: 'catalog-invalid', errors: validation.errors, matches: [] };
  }
  if (paused) {
    return { qualified: false, reason: 'learning-paused', matches: [] };
  }
  if (!registered) {
    return { qualified: false, reason: 'project-unregistered', matches: [] };
  }
  if (!carried) {
    return { qualified: false, reason: 'project-uncarried', matches: [] };
  }
  const matches = matchesForWarmupEvent(event, catalog);
  if (matches.length === 0) {
    return { qualified: false, reason: 'trigger-not-allowlisted', matches };
  }
  const match = matches[0];
  const mastered = toCanonicalSet(masteredConceptIds, catalog);
  if (mastered.has(match.concept.concept_id)) {
    return { qualified: false, reason: 'mastered', concept_id: match.concept.concept_id, matches };
  }
  const served = toCanonicalSet(servedConceptIds, catalog);
  if (served.has(match.concept.concept_id)) {
    return { qualified: false, reason: 'epoch-duplicate', concept_id: match.concept.concept_id, matches };
  }
  if (nowKind === 'real') {
    return { qualified: false, reason: 'current-real', concept_id: match.concept.concept_id, matches };
  }
  if (nowKind === 'warmup') {
    return { qualified: false, reason: 'current-warmup', concept_id: match.concept.concept_id, matches };
  }
  if (nowKind !== null && nowKind !== undefined) {
    return { qualified: false, reason: 'current-occupied', concept_id: match.concept.concept_id, matches };
  }
  if (nextReady) {
    return { qualified: false, reason: 'next-ready', concept_id: match.concept.concept_id, matches };
  }
  if (rateLimited) {
    return { qualified: false, reason: 'rate-limited', concept_id: match.concept.concept_id, matches };
  }
  return {
    qualified: true,
    reason: null,
    concept_id: match.concept.concept_id,
    matches,
    candidate: makeWarmupCandidate(match, { catalog, observation_id, activity_epoch_id, warmup_id }),
  };
}

module.exports = {
  CATALOG_VERSION,
  WARMUP_CATALOG,
  assertValidWarmupCatalog,
  canonicalWarmupConceptId,
  catalogEntryForConceptId,
  makeWarmupCandidate,
  matchesForWarmupEvent,
  observationsFromEvent,
  qualifyWarmupEvent,
  structuredArgvFromInput,
  validateWarmupCatalog,
};
