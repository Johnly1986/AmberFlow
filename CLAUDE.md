# CLAUDE.md — Claude Code 入口（薄壳）

@AGENTS.md

本仓库的 Agent 指令唯一内容在 [AGENTS.md](AGENTS.md)（跨 harness 共享：Cursor/Codex 等读同一份）；
Claude 特有的机制写在这里，不进 AGENTS.md：

- 需要你本人跑交互式命令（如登录）时，提示用户用 `! <命令>` 前缀在本会话里执行。
- 权限与 hook 配置走 Claude Code 的 settings 体系，与仓库配置（`amber config`）无关。
