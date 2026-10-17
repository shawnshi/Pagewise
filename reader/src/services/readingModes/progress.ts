/** 阅读模式 (打字机) 的进度展示数据, 由阅读器按页码模型与设定速度算好后传给面板和迷你条 */
export interface ReadingModeProgress {
  /** 当前章名 */
  chapter: string
  /** 本章进度 0–1 (章节位置未知时为全书进度) */
  chapterProgress: number
  /** 「本章还剩约 8 分钟」; 无法估算时为空 */
  chapterLeft: string
  /** 「约 8 分钟」, 迷你条上的短文案 */
  chapterLeftShort: string
  /** 「预计 22:15 读完」 */
  finish: string
  /** 「全书 12.3% · 还剩约 3 小时」 */
  book: string
  /** 「12.3%」 */
  percent: string
}
