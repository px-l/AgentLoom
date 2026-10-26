# 参与开发

本项目首版保持本地单用户边界。提交前先阅读 README 和 docs/architecture.md。

1. 安装锁文件对应依赖，执行 `scripts/dev.sh`。
2. 修改业务图规则时，同步更新 Python graph.py、共享 TypeScript 协议及有行为价值的测试。
3. 修改执行语义时，明确崩溃窗口、审批/取消状态、事件重放和工具幂等边界。
4. 数据库变更新增 Alembic revision，不修改已发布迁移；检查点表由官方 saver.setup 管理。
5. 运行 `scripts/test.sh`；界面变更运行浏览器测试。测试数据库名称必须以 `_test` 结尾，不能清空开发数据。
6. 性能结论附环境与原始测量，效果结论附语料规模、标注和定义。

Python 可用 `services/api/.venv/bin/ruff format services/api` 格式化；前端用 `pnpm --filter @agentloom/web exec prettier --write src`。不要提交密钥、`.env`、本地数据库文件或用户私有资料。

可重复、无付费凭据的测试优先。真实供应商集成测试必须明确外部条件，不能在无凭据时悄悄用替身冒充真实结果。
