# DsBot 对话时间线 + 人设回复

## 目标
1. IM 入站按伙伴人格 LLM 回复（失败才回退模板）。
2. DsBot 页：左联系人、右气泡时间线；`im-chat.jsonl` 落盘。

## 数据
- 路径：`~/.dsh/soulmate/.../im-chat.jsonl`
- 字段：`id, at, platform, peerId, peerLabel, role(user|bot), text, messageId?`

## API
- `GET /dsh-soulmate/api/im/chat?platform=weixin&peer=&limit=50&before=`
- 返回 `{ contacts, messages }`（无 peer 时 messages 为空，仅 contacts）

## UI
- DsBot 下半：左栏 contacts，右栏气泡；拉取消息 / 试发写入时间线。

## 人设回复
- 默认 `imReplyGenerator`：`oneShotLlm` + 人设/心情/记忆短 prompt；失败 → `buildTemplateReply`。
