# 任务清单：导出接口空输入校验

## 阶段 1：准备

- [ ] T1 在 `src/export/handler.js` 入口读取 body 并归一化
- [ ] T2 在 `src/util/text.js` 增加 `normalize()`（若不存在）

## 阶段 2：核心实现

- [ ] T3 在 `src/export/handler.js` 中加空输入分支，返回 400

## 复用复查（在 T3 之前执行）

- [ ] 检查是否已有空白归一工具；有则直接复用，不新增

## 阶段 3：验证

- [ ] T4 运行 `node --test test/handler.test.js`
