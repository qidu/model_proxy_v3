# Wrong response `openai-completions` message body in `/v1/messages` endpoint
Request of `llama3`
```
{ "stream": false, "max_tokens": 8192, "model": "llama3", "messages": [ { "role": "system", "content": "You are a helpful assistant." }, { "role": "user", "content": [{"type":"text","text":"what is 3+4=? how do you make it step by step? ONE WORD ANSWER."}] } ] }
```

Response of `llama3`
```
{"id":"chatcmpl-1779072301","object":"chat.completion","created":1779072301,"model":"llama3","choices":[{"index":0,"message":{"role":"assistant","content":"Three, add four, seven."},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":43,"completion_tokens":8,"total_tokens":51},"system_fingerprint":"chatjimmy-1779072301.2118626"}
```
```
{"id":"chatcmpl-1779073122","object":"chat.completion","created":1779073122,"model":"llama3.1-8B","choices":[{"index":0,"message":{"role":"assistant","content":"3, add, 4."},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":43,"completion_tokens":8,"total_tokens":51},"system_fingerprint":"chatjimmy-1779073122.3818276"}
```

# Right reponse `anthropic-messages` body in `/v1/messages` endpoint
Request of `gpt-5.3-codex`
```
{ "stream": false, "max_tokens": 8192, "model": "gpt-5.3-codex", "messages": [ { "role": "system", "content": "You are a helpful assistant." }, { "role": "user", "content": [{"type":"text","text":"what is 3+4=? how do you make it step by step? ONE WORD ANSWER."}] } ] }
```

Response of `gpt-5.3-codex`
```
{"id":"chatcmpl-b1b2140a-1636-44b0-8b1f-3ba470a0337d","type":"message","role":"assistant","model":"gpt-5.3-codex","content":[{"type":"text","text":"Seven"}],"stop_reason":"end_turn","usage":{"input_tokens":37,"output_tokens":34}}
```

```
{"id":"chatcmpl-1779074074","type":"message","role":"assistant","model":"llama3.1-8B","content":[{"type":"text","text":"Seven"}],"stop_reason":"end_turn","usage":{"input_tokens":43,"output_tokens":2}}
```

# SSE stream mode comparison to fix stream response
stream response of `llama3`
```
data: {"id":"chatcmpl-stream-1779074194264","object":"chat.completion.chunk","created":1779074194,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Three plus four equals seven."},"finish_reason":"stop","logprobs":null}]}
```

stream response of `gpt-5.4-mini`
```
event: message_start
data: {"type":"message_start","message":{"id":"req_1779074289245_vcs6fx99q","type":"message","role":"assistant","model":"gpt-5.4-mini","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Seven"}}

event: content_block_stop

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}

event: message_stop
data: {"type":"message_stop"}
```
