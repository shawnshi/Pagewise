-- 匿名用量计数: 设备/IP 每日配额与全站预算 (计数日为北京时间)
-- kind: 'd' 试用通道设备次数 / 'i' 试用通道 IP 次数
--       'djd' 点睛设备字数 / 'dji' 点睛 IP 字数
--       'cost' 全站估算成本 (id='all', 单位: 万分之一元)
-- count 为整数, 点睛与成本按量累加 (表结构与 v1 相同, 无需迁移)
CREATE TABLE IF NOT EXISTS usage (
  day   TEXT    NOT NULL,
  kind  TEXT    NOT NULL,
  id    TEXT    NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, id)
);
