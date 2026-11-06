import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ReadingManagerAiError,
  sanitizePromptText,
  extractJsonObject,
  formatAnnotationJumpPath,
  synthesizeBookAnnotationsWithAi,
  buildLocalAnnotationMarkdown,
  buildLocalCatchupSnapshot,
  generateReadingCatchupWithAi,
  generateCrossBookMatrixWithAi,
  buildCrossBookMatrixMarkdown,
  rankBooksForReadingPath,
  generateReadingPathWithAi,
} from '../src/services/readingManagerAi.ts'

function createMockAiDeps(jsonPayload, configured = true) {
  const capturedMessages = []
  return {
    capturedMessages,
    deps: {
      isConfigured: () => configured,
      streamChat: async function* (messages, signal) {
        signal?.throwIfAborted()
        capturedMessages.push(messages)
        const text = typeof jsonPayload === 'string' ? jsonPayload : JSON.stringify(jsonPayload)
        // Simulate chunked streaming
        const mid = Math.floor(text.length / 2)
        yield text.slice(0, mid)
        signal?.throwIfAborted()
        yield text.slice(mid)
      },
    },
  }
}

test('sanitizePromptText & extractJsonObject: strips null bytes and parses markdown JSON safely', () => {
  assert.equal(sanitizePromptText('Hello\0World  ', 20), 'HelloWorld')
  assert.equal(sanitizePromptText('1234567890', 5), '12345')

  const parsed = extractJsonObject('```json\n{"summary": "清晰综述"}\n```')
  assert.deepEqual(parsed, { summary: '清晰综述' })

  assert.throws(
    () => extractJsonObject('   '),
    err => err instanceof ReadingManagerAiError && err.code === 'empty_output',
  )
  assert.throws(
    () => extractJsonObject('Not a json object [1, 2, 3]'),
    err => err instanceof ReadingManagerAiError && err.code === 'invalid_json',
  )
})

test('P0: synthesizeBookAnnotationsWithAi clusters notes and strictly filters hallucinated annotationIds', async () => {
  const book = {
    id: 'book-cyber',
    title: '控制论与社会',
    author: '诺伯特·维纳',
    publisher: '商务印书馆',
    description: '探讨负反馈与信息熵',
    format: 'epub',
    kind: 'book',
  }

  const annotations = [
    {
      id: 'ann-1',
      bookId: 'book-cyber',
      kind: 'highlight',
      cfi: 'epubcfi(/6/4!/4/2)',
      text: '信息是我们在适应外部世界时与外部世界交换的内容的名称。',
      note: '信息不等于物质或能量。',
      color: 'yellow',
      createdAt: 1700000001000,
    },
    {
      id: 'ann-2',
      bookId: 'book-cyber',
      kind: 'highlight',
      cfi: 'epubcfi(/6/8!/4/6)',
      text: '局部反熵过程依赖于反馈回路的持续校准。',
      note: '组织治理同样需要负反馈信号。',
      color: 'yellow',
      createdAt: 1700000002000,
    },
  ]

  // Rejects when empty annotations
  await assert.rejects(
    () => synthesizeBookAnnotationsWithAi({ book, annotations: [] }),
    err => err instanceof ReadingManagerAiError && err.code === 'empty_annotations',
  )

  // Rejects when AI unconfigured
  const unconf = createMockAiDeps({}, false)
  await assert.rejects(
    () => synthesizeBookAnnotationsWithAi({ book, annotations, deps: unconf.deps }),
    err => err instanceof ReadingManagerAiError && err.code === 'unconfigured',
  )

  // Filters out hallucinated annotation ID ('ann-hallucinated-999')
  const mockAi = createMockAiDeps({
    summary: '本书通过负反馈与信息交换视角重构了个体与社会系统的稳态机制。',
    themes: [
      {
        title: '信息与负反馈闭环',
        insight: '系统通过反馈回路对抗熵增，维持局部秩序。',
        annotationIds: ['ann-1', 'ann-hallucinated-999', 'ann-2'],
      },
    ],
    keyTakeaways: ['建立可观测的负反馈指标', '区分信号与噪声'],
  })

  const synthesis = await synthesizeBookAnnotationsWithAi({
    book,
    annotations,
    deps: mockAi.deps,
  })

  assert.equal(synthesis.summary, '本书通过负反馈与信息交换视角重构了个体与社会系统的稳态机制。')
  assert.equal(synthesis.themes.length, 1)
  assert.deepEqual(synthesis.themes[0].annotationIds, ['ann-1', 'ann-2'])
  assert.deepEqual(synthesis.keyTakeaways, ['建立可观测的负反馈指标', '区分信号与噪声'])

  // P0 Markdown export includes both synthesis and CFI jump links
  const md = buildLocalAnnotationMarkdown(book, annotations, synthesis)
  assert.ok(md.includes('# 《控制论与社会》读书笔记与批注综述'))
  assert.ok(md.includes('## 一、 核心脉络综述 (AI 蒸馏)'))
  assert.ok(md.includes('信息与负反馈闭环'))
  assert.ok(md.includes('/read/book-cyber?loc=epubcfi(%2F6%2F4!%2F4%2F2)'))
  assert.ok(md.includes('组织治理同样需要负反馈信号。'))
})

test('P1: buildLocalCatchupSnapshot & generateReadingCatchupWithAi build contextual catch-up brief', async () => {
  const now = 1710000000000
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000
  const book = {
    id: 'book-hist',
    title: '万历十五年',
    author: '黄仁宇',
    description: '从大历史观剖析明代文官集团与财政制度困境',
    progress: 0.42,
    location: 'epubcfi(/6/12!/4/2)',
    lastReadAt: now - fiveDaysMs,
    readingStatus: 'paused',
  }
  const annotations = [
    {
      id: 'a-10',
      bookId: 'book-hist',
      kind: 'highlight',
      cfi: 'epubcfi(/6/10!/4/2)',
      text: '道德代替法制成为文官集团维系表面平衡的唯一工具。',
      note: '制度缺乏数目字管理能力。',
      color: 'yellow',
      createdAt: now - fiveDaysMs,
    },
  ]

  const snap = buildLocalCatchupSnapshot(book, annotations, now)
  assert.equal(snap.progressPercent, 42)
  assert.equal(snap.daysSinceLastRead, 5)
  assert.equal(snap.needsCatchup, true)
  assert.equal(snap.recentAnnotations.length, 1)

  const mockAi = createMockAiDeps({
    whereYouLeftOff: '上次读到全书 42% 处，核心讨论文官集团以道德替代技术官僚法制的困境。',
    keyThreads: ['数目字管理缺失的制度根源', '张居正改革为何人亡政息'],
    nextStepSuggestion: '接下来进入海瑞与戚继光章节，建议对比道德楷模与实务将领的不同处境。',
  })

  const catchup = await generateReadingCatchupWithAi({
    book,
    annotations,
    tocTitles: ['第一章 万历皇帝', '第二章 首辅申时行', '第三章 世间已无张居正'],
    deps: mockAi.deps,
  })

  assert.ok(catchup.whereYouLeftOff.includes('42%'))
  assert.equal(catchup.keyThreads.length, 2)
  assert.ok(catchup.nextStepSuggestion.includes('海瑞'))
})

test('P2-A: generateCrossBookMatrixWithAi enforces 2-4 book count and bookId whitelist', async () => {
  const entry1 = {
    book: { id: 'b-1', title: '思考，快与慢', author: '卡尼曼', description: '双系统决策偏差' },
    annotations: [{ id: 'n1', bookId: 'b-1', cfi: '1', text: '系统1依赖直觉启发式', color: 'y', createdAt: 1 }],
  }
  const entry2 = {
    book: { id: 'b-2', title: '简捷启发式', author: '吉仁泽', description: '生态理性与快省启发式' },
    annotations: [{ id: 'n2', bookId: 'b-2', cfi: '2', text: '在不确定的真实环境中少即是多', color: 'y', createdAt: 2 }],
  }

  // Fails with only 1 book
  await assert.rejects(
    () => generateCrossBookMatrixWithAi({ entries: [entry1] }),
    err => err instanceof ReadingManagerAiError && err.code === 'insufficient_books',
  )

  const mockAi = createMockAiDeps({
    topic: '人类直觉启发式的理性边界',
    consensus: ['人类在现实决策中广泛依赖启发式而非完备贝叶斯计算'],
    divergences: ['卡尼曼强调启发式导致的系统性认知偏差，吉仁泽强调启发式在不确定环境下的生态适应性'],
    perspectives: [
      {
        bookId: 'b-1',
        coreStance: '直觉常偏离统计最优，需系统2纠偏',
        keyEvidence: '锚定效应与可得性偏差实验',
        boundary: '静态封闭概率问题',
      },
      {
        bookId: 'b-hallucinated',
        coreStance: '不应保留的幻觉书目',
        keyEvidence: '无',
        boundary: '无',
      },
      {
        bookId: 'b-2',
        coreStance: '快省启发式匹配环境结构时优于复杂模型',
        keyEvidence: '少即是多效应与样本外稳健性',
        boundary: '高度不确定且信息受限的开放环境',
      },
    ],
  })

  const matrix = await generateCrossBookMatrixWithAi({
    topic: '直觉与理性',
    entries: [entry1, entry2],
    deps: mockAi.deps,
  })

  assert.equal(matrix.perspectives.length, 2)
  assert.deepEqual(
    matrix.perspectives.map(p => p.bookId),
    ['b-1', 'b-2'],
  )
  assert.equal(matrix.perspectives[0].bookTitle, '思考，快与慢')
  assert.equal(matrix.perspectives[1].bookTitle, '简捷启发式')

  const md = buildCrossBookMatrixMarkdown(matrix)
  assert.ok(md.includes('# 跨书观点对比矩阵：人类直觉启发式的理性边界'))
  assert.ok(md.includes('《思考，快与慢》'))
  assert.ok(md.includes('《简捷启发式》'))
})

test('P2-B: rankBooksForReadingPath & generateReadingPathWithAi build validated staged syllabus', async () => {
  const libraryBooks = [
    {
      id: 'sys-1',
      title: '系统之美',
      author: '德内拉·梅多斯',
      format: 'epub',
      fileName: 's1.epub',
      description: '系统动力学入门：存量、流量与反馈回路',
      tags: ['系统论', '控制论'],
      addedAt: 100,
      hasCover: false,
    },
    {
      id: 'sys-2',
      title: '第五项修炼',
      author: '彼得·圣吉',
      format: 'epub',
      fileName: 's2.epub',
      description: '学习型组织中的系统思考基模',
      tags: ['系统思考', '管理'],
      addedAt: 200,
      hasCover: false,
    },
    {
      id: 'irrelevant-3',
      title: '法式烘焙食谱',
      author: 'Chef',
      format: 'pdf',
      fileName: 'cook.pdf',
      description: '甜点制作指南',
      tags: ['美食'],
      addedAt: 300,
      hasCover: false,
    },
  ]

  const ranked = rankBooksForReadingPath('系统论与反馈回路', libraryBooks, 2)
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].id, 'sys-1')

  const mockAi = createMockAiDeps({
    goal: '系统动力学与组织反馈机制',
    overview: '先建立存量-流量与反馈回路的公理化直觉，再切入组织管理中的系统基模。',
    stages: [
      {
        stageName: '第一阶段：基础概念建模',
        bookId: 'sys-1',
        rationale: '掌握存量、流量、调节回路与增强回路的核心定义',
        focusArea: '第1-3章系统结构与杠杆点章节',
      },
      {
        stageName: '幻觉阶段',
        bookId: 'non-existent-id',
        rationale: '测试白名单拦截',
        focusArea: '无',
      },
      {
        stageName: '第二阶段：组织场景迁移',
        bookId: 'sys-2',
        rationale: '将反馈回路应用于组织决策迟延与增长极限诊断',
        focusArea: '系统基模与成长上限章节',
      },
    ],
  })

  const pathRes = await generateReadingPathWithAi({
    goal: '系统动力学与反馈',
    books: libraryBooks,
    deps: mockAi.deps,
  })

  assert.equal(pathRes.stages.length, 2)
  assert.deepEqual(
    pathRes.stages.map(s => ({ order: s.order, bookId: s.bookId, title: s.bookTitle })),
    [
      { order: 1, bookId: 'sys-1', title: '系统之美' },
      { order: 2, bookId: 'sys-2', title: '第五项修炼' },
    ],
  )
})

test('formatAnnotationJumpPath: generates accurate reader routes for epub and paper/pdf', () => {
  assert.equal(
    formatAnnotationJumpPath({ id: 'b1', kind: 'book', format: 'epub' }, 'epubcfi(/6/2)'),
    '/read/b1?loc=epubcfi(%2F6%2F2)',
  )
  assert.equal(
    formatAnnotationJumpPath({ id: 'p1', kind: 'paper', format: 'pdf' }, 'page=12'),
    '/read-paper/p1?loc=page%3D12',
  )
})
