# Claude Messages API 测试说明文档

## 1. 文档概述

本文档基于 [Claude Messages API 官方规范](https://platform.claude.com/docs/en/api/messages/create) 和 [Count Tokens API 规范](https://platform.claude.com/docs/en/api/messages/count_tokens) 生成，用于指导 `https://api.qnaigc.com/v1/messages` API 的对比测试工作。

### 1.1 测试目标

| 目标API | 地址 |
|---------|------|
| 目标API | `https://api.qnaigc.com/v1/messages` |
| 对照API (代理) | `http://localhost:8787/https/api.qnaigc.com/v1/messages` |

### 1.2 测试配置

- **Model**: `abcd`
- **API Key**: `xyz`

---

## 2. API 接口规范

### 2.1 Messages Create API (`POST /v1/messages`)

#### 2.1.1 请求头要求

```http
Content-Type: application/json
anthropic-version: 2023-06-01
X-Api-Key: {API_KEY}
```

#### 2.1.2 Body 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 (如 `abcd`) |
| `messages` | array | 是 | 输入消息列表 |
| `max_tokens` | number | 是 | 最大生成token数 |
| `system` | string/array | 否 | 系统提示 |
| `temperature` | number | 否 | 温度 (0.0-1.0, 默认1.0) |
| `top_p` | number | 否 | top_p采样 |
| `top_k` | number | 否 | top_k采样 |
| `stop_sequences` | array | 否 | 停止序列 |
| `stream` | boolean | 否 | 是否流式响应 |
| `tools` | array | 否 | 工具定义 |
| `tool_choice` | object | 否 | 工具选择策略 |
| `thinking` | object | 否 | 扩展思考配置 |
| `metadata` | object | 否 | 元数据 |
| `service_tier` | string | 否 | 服务等级 (`auto`/`standard_only`) |

#### 2.1.3 Message 结构

```json
{
  "role": "user" | "assistant",
  "content": "string" | ContentBlock[]
}
```

#### 2.1.4 ContentBlock 类型

- `text` - 文本块
- `image` - 图片块 (base64/url)
- `document` - 文档块 (PDF等)
- `tool_use` - 工具调用
- `tool_result` - 工具结果
- `thinking` - 思考块
- `search_result` - 搜索结果

#### 2.1.5 响应结构

```json
{
  "id": "string",
  "type": "message",
  "role": "assistant",
  "content": ContentBlock[],
  "model": "string",
  "stop_reason": "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal",
  "stop_sequence": "string | null",
  "usage": {
    "input_tokens": number,
    "output_tokens": number,
    "cache_creation_input_tokens": number,
    "cache_read_input_tokens": number,
    "service_tier": "standard" | "priority" | "batch"
  }
}
```

---

### 2.2 Count Tokens API (`POST /v1/messages/count_tokens`)

#### 2.2.1 请求头要求

同 Messages Create API

#### 2.2.2 Body 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型名称 |
| `messages` | array | 是 | 输入消息列表 |
| `system` | string/array | 否 | 系统提示 |
| `tools` | array | 否 | 工具定义 |
| `tool_choice` | object | 否 | 工具选择策略 |
| `thinking` | object | 否 | 扩展思考配置 |

#### 2.2.3 响应结构

```json
{
  "input_tokens": number
}
```

---

## 3. 测试用例

### 3.1 Messages Create API 测试用例

#### TC001: 基础文本对话

**描述**: 测试最简单的用户消息发送功能

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "你好，请介绍一下你自己"}],
    "max_tokens": 1024
  }'
```

**验证点**:
- [ ] 响应状态码为 200
- [ ] 响应包含 `id`, `type`, `role`, `content`, `model` 字段
- [ ] `type` 值为 `message`
- [ ] `role` 值为 `assistant`
- [ ] `content` 包含至少一个 `text` 类型块
- [ ] `stop_reason` 为有效值
- [ ] `usage` 包含 `input_tokens` 和 `output_tokens`

---

#### TC002: 多轮对话

**描述**: 测试包含多轮上下文的消息

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [
      {"role": "user", "content": "什么是机器学习？"},
      {"role": "assistant", "content": "机器学习是..."},
      {"role": "user", "content": "能举个具体的例子吗？"}
    ],
    "max_tokens": 1024
  }'
```

**验证点**:
- [ ] 正确理解上下文语境
- [ ] 响应内容与历史对话相关

---

#### TC003: 系统提示词

**描述**: 测试添加系统提示词

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "system": "你是一位专业的Python编程助手",
    "messages": [{"role": "user", "content": "写一个快速排序算法"}],
    "max_tokens": 2048
  }'
```

**验证点**:
- [ ] 系统提示词被正确应用
- [ ] 响应符合设定的角色

---

#### TC004: 自定义停止序列

**描述**: 测试自定义停止序列功能

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "列出5个编程语言"}],
    "max_tokens": 1024,
    "stop_sequences": ["4."]
  }'
```

**验证点**:
- [ ] 当遇到停止序列时停止生成
- [ ] `stop_reason` 为 `stop_sequence`

---

#### TC005: 温度参数测试

**描述**: 测试不同温度值对输出的影响

**请求 (temperature=0)**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "1+1等于几"}],
    "max_tokens": 1024,
    "temperature": 0.0
  }'
```

**验证点**:
- [ ] 较低温度下输出更确定性

---

#### TC006: 流式响应

**描述**: 测试流式响应功能

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "写一首关于春天的诗"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

**验证点**:
- [ ] 支持 Server-Sent Events 格式
- [ ] 返回 `message_start`, `content_block_delta`, `message_delta` 等事件

---

#### TC007: 工具调用 (Tool Use)

**描述**: 测试工具调用功能

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "请帮我查询天气"}],
    "max_tokens": 1024,
    "tools": [
      {
        "name": "get_weather",
        "description": "获取指定城市的天气信息",
        "input_schema": {
          "type": "object",
          "properties": {
            "city": {
              "type": "string",
              "description": "城市名称"
            }
          },
          "required": ["city"]
        }
      }
    ]
  }'
```

**验证点**:
- [ ] 返回 `tool_use` 类型的内容块
- [ ] 包含 `id`, `name`, `input` 字段

---

#### TC008: 扩展思考 (Thinking)

**描述**: 测试扩展思考功能

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "分析一下人工智能的发展趋势"}],
    "max_tokens": 4096,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 2048
    }
  }'
```

**验证点**:
- [ ] 响应包含 `thinking` 类型的内容块
- [ ] 思考内容与最终回答相关

---

#### TC009: 图片输入 (Image)

**描述**: 测试图片输入功能

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "描述这张图片中的内容"},
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "BASE64_ENCODED_IMAGE_DATA"
          }
        }
      ]
    }],
    "max_tokens": 1024
  }'
```

**验证点**:
- [ ] 正确解析图片内容
- [ ] 生成合理的图片描述

---

#### TC010: 长文本输入

**描述**: 测试长文本输入场景

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{
      "role": "user",
      "content": "'$(cat long_text.txt)'
    }],
    "max_tokens": 1024
  }'
```

**验证点**:
- [ ] 能处理大段文本
- [ ] `usage.input_tokens` 正确计数

---

### 3.2 Count Tokens API 测试用例

#### TC011: 基础Token计数

**描述**: 测试基本消息的Token计数

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages/count_tokens" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "Hello, world"}]
  }'
```

**验证点**:
- [ ] 响应包含 `input_tokens` 字段
- [ ] 返回有效的正整数

---

#### TC012: 带系统提示的Token计数

**描述**: 测试包含系统提示的Token计数

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages/count_tokens" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "system": "你是一位helpful assistant",
    "messages": [{"role": "user", "content": "今天天气怎么样"}]
  }'
```

**验证点**:
- [ ] 系统提示也被计入Token
- [ ] 返回正确的总Token数

---

#### TC013: 工具定义的Token计数

**描述**: 测试包含工具定义的Token计数

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages/count_tokens" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "请帮我查询天气"}],
    "tools": [
      {
        "name": "get_weather",
        "description": "获取天气",
        "input_schema": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    ]
  }'
```

**验证点**:
- [ ] 工具定义被计入Token
- [ ] 返回正确的总Token数

---

### 3.3 错误处理测试用例

#### TC014: 无效API Key

**描述**: 测试使用无效API Key的情况

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: invalid_key" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 1024
  }'
```

**验证点**:
- [ ] 返回 401 状态码
- [ ] 错误信息明确

---

#### TC015: 缺少必填参数

**描述**: 测试缺少必填参数的情况

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{"model": "abcd"}'
```

**验证点**:
- [ ] 返回 400 状态码
- [ ] 错误信息指出缺失参数

---

#### TC016: 无效的Model

**描述**: 测试使用不存在的模型

**请求**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "non_existent_model",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 1024
  }'
```

**验证点**:
- [ ] 返回适当的错误状态码
- [ ] 错误信息明确

---

#### TC017: 超出Rate Limit

**描述**: 测试超出速率限制的情况

**请求**: 并发发送大量请求

**验证点**:
- [ ] 返回 429 状态码
- [ ] 包含重试信息 (如有)

---

### 3.4 对比测试用例 (代理 vs 直连)

#### TC018: 基础功能对比

**描述**: 对比代理和直连的响应一致性

**请求1 (直连)**:
```bash
curl -X POST "https://api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 512
  }'
```

**请求2 (代理)**:
```bash
curl -X POST "http://localhost:8787/https/api.qnaigc.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: xyz" \
  -d '{
    "model": "abcd",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 512
  }'
```

**验证点**:
- [ ] 两个请求的 `model` 字段一致
- [ ] 两个请求的 `usage.input_tokens` 计数一致
- [ ] 两个请求的响应时间差异在可接受范围

---

#### TC019: 响应格式对比

**描述**: 对比代理和直连的响应格式

**验证点**:
- [ ] 响应结构一致 (包含相同字段)
- [ ] 字段类型一致
- [ ] ContentBlock 类型一致

---

#### TC020: 性能对比

**描述**: 对比代理和直连的性能表现

**测试方法**: 多次请求取平均值

**验证点**:
- [ ] 记录直连平均响应时间
- [ ] 记录代理平均响应时间
- [ ] 计算延迟差异百分比

---

## 4. 测试报告模板

### 4.1 环境信息

| 项目 | 值 |
|------|-----|
| 测试日期 | |
| 测试人员 | |
| API版本 | Claude Messages API |
| 模型 | abcd |
| API Key | xyz (脱敏) |

### 4.2 测试结果汇总

| 用例ID | 用例描述 | 直连结果 | 代理结果 | 对比结论 | 备注 |
|--------|----------|----------|----------|----------|------|
| TC001 | 基础文本对话 | PASS/FAIL | PASS/FAIL | 一致/不一致 | |
| TC002 | 多轮对话 | PASS/FAIL | PASS/FAIL | 一致/不一致 | |
| ... | ... | ... | ... | ... | |

### 4.3 问题记录

| 问题ID | 严重级别 | 问题描述 | 重现步骤 | 状态 |
|--------|----------|----------|----------|------|
| | P0/P1/P2 | | | OPEN/FIXED |

---

## 5. 附录

### 5.1 curl 命令模板

**直连请求**:
```bash
curl -X POST "{API_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: {API_KEY}" \
  -d '{REQUEST_BODY}'
```

**代理请求**:
```bash
curl -X POST "{PROXY_ENDPOINT}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-Api-Key: {API_KEY}" \
  -d '{REQUEST_BODY}'
```

### 5.2 响应字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 消息唯一标识 |
| `type` | string | 对象类型, 固定为 "message" |
| `role` | string | 消息角色, 固定为 "assistant" |
| `content` | array | 内容块列表 |
| `model` | string | 使用的模型 |
| `stop_reason` | string | 停止原因 |
| `usage.input_tokens` | number | 输入token数 |
| `usage.output_tokens` | number | 输出token数 |

### 5.3 HTTP状态码说明

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未授权, API Key无效 |
| 403 | 被禁止访问 |
| 429 | 超出速率限制 |
| 500 | 服务器内部错误 |