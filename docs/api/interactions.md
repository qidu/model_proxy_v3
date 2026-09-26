# Gemini API

The Gemini Interactions API is an experimental API that allows developers to build generative AI applications using Gemini models. Gemini is our most capable model, built from the ground up to be multimodal. It can generalize and seamlessly understand, operate across, and combine different types of information including language, images, audio, video, and code. You can use the Gemini API for use cases like reasoning across text and images, content generation, dialogue agents, summarization and classification systems, and more.
- refer to https://ai.google.dev/gemini-api/docs/interactions

## Default

### Creating an interaction

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Creates a new interaction.


#### Request Body
- **model** (`<a href="#Resource:ModelOption">ModelOption</a>`) The name of the `Model` used for generating the interaction. <br><strong>Required if `agent` is not provided.</strong>
 Possible values:
 - `gemini-2.5-pro`: Our state-of-the-art multipurpose model, which excels at coding and complex reasoning tasks. - `gemini-2.5-flash`: Our first hybrid reasoning model which supports a 1M token context window and has thinking budgets. - `gemini-2.5-flash-preview-09-2025`: The latest model based on the 2.5 Flash model. 2.5 Flash Preview is best for large scale processing, low-latency, high volume tasks that require thinking, and agentic use cases. - `gemini-2.5-flash-lite`: Our smallest and most cost effective model, built for at scale usage. - `gemini-2.5-flash-lite-preview-09-2025`: The latest model based on Gemini 2.5 Flash lite optimized for cost-efficiency, high throughput and high quality. - `gemini-2.5-flash-preview-native-audio-dialog`: Our native audio models optimized for higher quality audio outputs with better pacing, voice naturalness, verbosity, and mood. - `gemini-2.5-flash-image-preview`: Our native image generation model, optimized for speed, flexibility, and contextual understanding. Text input and output is priced the same as 2.5 Flash. - `gemini-2.5-pro-preview-tts`: Our 2.5 Pro text-to-speech audio model optimized for powerful, low-latency speech generation for more natural outputs and easier to steer prompts. - `gemini-3-pro-preview`: Our most intelligent model with SOTA reasoning and multimodal understanding, and powerful agentic and vibe coding capabilities. - `gemini-3-flash-preview`: Our most intelligent model built for speed, combining frontier intelligence with superior search and grounding.
- **agent** (`<a href="#Resource:AgentOption">AgentOption</a>`) The name of the `Agent` used for generating the interaction. <br><strong>Required if `model` is not provided.</strong>
 Possible values:
 - `deep-research-pro-preview-12-2025`: Gemini Deep Research Agent
- **input** (`<a href="#Resource:Content">Content</a> or array (<a href="#Resource:Content">Content</a>) or array (<a href="#Resource:Turn">Turn</a>) or string`) *(Required)* The inputs for the interaction (common to both Model and Agent).

- **system_instruction** (`string`) System instruction for the interaction.

- **tools** (`array (<a href="#Resource:Tool">Tool</a>)`) A list of tool declarations the model may call during interaction.

- **response_format** (`object`) Enforces that the generated response is a JSON object that complies with the JSON schema specified in this field.

- **response_mime_type** (`string`) The mime type of the response. This is required if response_format is set.

- **stream** (`boolean`) Input only. Whether the interaction will be streamed.

- **store** (`boolean`) Input only. Whether to store the response and request for later retrieval.

- **background** (`boolean`) Input only. Whether to run the model interaction in the background.

- **generation_config** (`<a href="#Resource:GenerationConfig">GenerationConfig</a>`) <strong>Model Configuration</strong><br>Configuration parameters for the model interaction. <br><em>Alternative to `agent_config`. Only applicable when `model` is set.</em>
 - **temperature** (`number`)  Controls the randomness of the output.

 - **top_p** (`number`)  The maximum cumulative probability of tokens to consider when sampling.

 - **seed** (`integer`)  Seed used in decoding for reproducibility.

 - **stop_sequences** (`array (string)`)  A list of character sequences that will stop output interaction.

 - **tool_choice** (`<a href="#Resource:ToolChoice">ToolChoice</a>`)  The tool choice for the interaction.

 - **thinking_level** (`<a href="#Resource:ThinkingLevel">ThinkingLevel</a>`)  The level of thought tokens that the model should generate.
  Possible values:
  - `minimal`  - `low`  - `medium`  - `high`
 - **thinking_summaries** (`<a href="#Resource:ThinkingSummaries">ThinkingSummaries</a>`)  Whether to include thought summaries in the response.
  Possible values:
  - `auto`  - `none`
 - **max_output_tokens** (`integer`)  The maximum number of tokens to include in the response.

 - **speech_config** (`array (<a href="#Resource:SpeechConfig">SpeechConfig</a>)`)  Configuration for speech interaction.
  - **voice** (`string`)   The voice of the speaker.

  - **language** (`string`)   The language of the speech.

  - **speaker** (`string`)   The speaker's name, it should match the speaker name given in the prompt.


 - **image_config** (`<a href="#Resource:ImageConfig">ImageConfig</a>`)  Configuration for image interaction.
  - **aspect_ratio** (`enum (string)`)
   Possible values:
   - `1:1`   - `2:3`   - `3:2`   - `3:4`   - `4:3`   - `4:5`   - `5:4`   - `9:16`   - `16:9`   - `21:9`
  - **image_size** (`enum (string)`)
   Possible values:
   - `1K`   - `2K`   - `4K`


- **agent_config** (`<a href="#Resource:DeepResearchAgentConfig">DeepResearchAgentConfig</a> or <a href="#Resource:DynamicAgentConfig">DynamicAgentConfig</a>`) <strong>Agent Configuration</strong><br>Configuration for the agent. <br><em>Alternative to `generation_config`. Only applicable when `agent` is set.</em>
 **Possible Types:** (Discriminator: `type`) - **DynamicAgentConfig**: Configuration for dynamic agents.
  - **type** (`object`)
   Value: `dynamic`
 - **DeepResearchAgentConfig**: Configuration for the Deep Research agent.
  - **thinking_summaries** (`<a href="#Resource:ThinkingSummaries">ThinkingSummaries</a>`)   Whether to include thought summaries in the response.
   Possible values:
   - `auto`   - `none`
  - **type** (`object`)
   Value: `deep-research`

- **previous_interaction_id** (`string`) The ID of the previous interaction, if any.

- **response_modalities** (`array (<a href="#Resource:ResponseModality">ResponseModality</a>)`) The requested modalities of the response (TEXT, IMAGE, AUDIO).
 Possible values:
 - `text` - `image` - `audio`

#### Response
Returns [Interaction](#interaction) resources.

#### Examples
**Simple Request**

**REST**

```sh
curl -X POST https://generativelanguage.googleapis.com/v1beta/interactions \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "input": "Hello, how are you?"
  }'

```
**Python**

```python
from google import genai

client = genai.Client()
interaction = client.interactions.create(
    model="gemini-3-flash-preview",
    input="Hello, how are you?",
)
print(interaction.outputs[-1].text)

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.create({
    model: 'gemini-3-flash-preview',
    input: 'Hello, how are you?',
});
console.log(interaction.outputs[interaction.outputs.length - 1].text);

```

Response:
```json
{
  "created": "2025-11-26T12:25:15Z",
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "model": "gemini-3-flash-preview",
  "object": "interaction",
  "outputs": [
    {
      "text": "Hello! I'm functioning perfectly and ready to assist you.\n\nHow are you doing today?",
      "type": "text"
    }
  ],
  "role": "model",
  "status": "completed",
  "updated": "2025-11-26T12:25:15Z",
  "usage": {
    "input_tokens_by_modality": [
      {
        "modality": "text",
        "tokens": 7
      }
    ],
    "total_cached_tokens": 0,
    "total_input_tokens": 7,
    "total_output_tokens": 20,
    "total_thought_tokens": 22,
    "total_tokens": 49,
    "total_tool_use_tokens": 0
  }
}
```
**Multi-turn**

**REST**

```sh
curl -X POST https://generativelanguage.googleapis.com/v1beta/interactions \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "input": [
      {
        "role": "user",
        "content": "Hello!"
      },
      {
        "role": "model",
        "content": "Hi there! How can I help you today?"
      },
      {
        "role": "user",
        "content": "What is the capital of France?"
      }
    ]
  }'

```
**Python**

```python
from google import genai

client = genai.Client()
response = client.interactions.create(
    model="gemini-3-flash-preview",
    input=[
        { "role": "user", "content": "Hello!" },
        { "role": "model", "content": "Hi there! How can I help you today?" },
        { "role": "user", "content": "What is the capital of France?" }
    ]
)
print(response.outputs[-1].text)

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.create({
    model: 'gemini-3-flash-preview',
    input: [
        { role: 'user', content: 'Hello' },
        { role: 'model', content: 'Hi there! How can I help you today?' },
        { role: 'user', content: 'What is the capital of France?' }
    ]
});
console.log(interaction.outputs[interaction.outputs.length - 1].text);

```

Response:
```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "model": "gemini-3-flash-preview",
  "status": "completed",
  "object": "interaction",
  "created": "2025-11-26T12:22:47Z",
  "updated": "2025-11-26T12:22:47Z",
  "role": "model",
  "outputs": [
    {
      "type": "text",
      "text": "The capital of France is Paris."
    }
  ],
  "usage": {
    "input_tokens_by_modality": [
      {
        "modality": "text",
        "tokens": 50
      }
    ],
    "total_cached_tokens": 0,
    "total_input_tokens": 50,
    "total_output_tokens": 10,
    "total_thought_tokens": 0,
    "total_tokens": 60,
    "total_tool_use_tokens": 0
  }
}
```
**Image Input**

**REST**

```sh
curl -X POST https://generativelanguage.googleapis.com/v1beta/interactions \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "input": [
      {
        "type": "text",
        "text": "What is in this picture?"
      },
      {
        "type": "image",
        "data": "BASE64_ENCODED_IMAGE",
        "mime_type": "image/png"
      }
    ]
  }'

```
**Python**

```python
from google import genai

client = genai.Client()
response = client.interactions.create(
    model="gemini-3-flash-preview",
    input=[
      { "type": "text", "text": "What is in this picture?" },
      { "type": "image", "data": "BASE64_ENCODED_IMAGE", "mime_type": "image/png" }
    ]
)
print(response.outputs[-1].text)

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.create({
    model: 'gemini-3-flash-preview',
    input: [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', data: 'BASE64_ENCODED_IMAGE', mime_type: 'image/png' }
    ]
});
console.log(interaction.outputs[interaction.outputs.length - 1].text);

```

Response:
```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "model": "gemini-3-flash-preview",
  "status": "completed",
  "object": "interaction",
  "created": "2025-11-26T12:22:47Z",
  "updated": "2025-11-26T12:22:47Z",
  "role": "model",
  "outputs": [
    {
      "type": "text",
      "text": "A white humanoid robot with glowing blue eyes stands holding a red skateboard."
    }
  ],
  "usage": {
    "input_tokens_by_modality": [
      {
        "modality": "text",
        "tokens": 10
      },
      {
        "modality": "image",
        "tokens": 258
      }
    ],
    "total_cached_tokens": 0,
    "total_input_tokens": 268,
    "total_output_tokens": 20,
    "total_thought_tokens": 0,
    "total_tokens": 288,
    "total_tool_use_tokens": 0
  }
}
```
**Function Calling**

**REST**

```sh
curl -X POST https://generativelanguage.googleapis.com/v1beta/interactions \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "Get the current weather in a given location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "The city and state, e.g. San Francisco, CA"
            }
          },
          "required": [
            "location"
          ]
        }
      }
    ],
    "input": "What is the weather like in Boston, MA?"
  }'

```
**Python**

```python
from google import genai

client = genai.Client()
response = client.interactions.create(
    model="gemini-3-flash-preview",
    tools=[{
        "type": "function",
        "name": "get_weather",
        "description": "Get the current weather in a given location",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The city and state, e.g. San Francisco, CA"
                }
            },
            "required": ["location"]
        }
    }],
    input="What is the weather like in Boston, MA?"
)
print(response.outputs[0])

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.create({
    model: 'gemini-3-flash-preview',
    tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather in a given location',
        parameters: {
            type: 'object',
            properties: {
                location: {
                    type: 'string',
                    description: 'The city and state, e.g. San Francisco, CA'
                }
            },
            required: ['location']
        }
    }],
    input: 'What is the weather like in Boston, MA?'
});
console.log(interaction.outputs[0]);

```

Response:
```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "model": "gemini-3-flash-preview",
  "status": "requires_action",
  "object": "interaction",
  "created": "2025-11-26T12:22:47Z",
  "updated": "2025-11-26T12:22:47Z",
  "role": "model",
  "outputs": [
    {
      "type": "function_call",
      "name": "get_weather",
      "arguments": {
        "location": "Boston, MA"
      }
    }
  ],
  "usage": {
    "input_tokens_by_modality": [
      {
        "modality": "text",
        "tokens": 100
      }
    ],
    "total_cached_tokens": 0,
    "total_input_tokens": 100,
    "total_output_tokens": 25,
    "total_thought_tokens": 0,
    "total_tokens": 125,
    "total_tool_use_tokens": 50
  }
}
```
**Deep Research**

**REST**

```sh
curl -X POST https://generativelanguage.googleapis.com/v1beta/interactions \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "deep-research-pro-preview-12-2025",
    "input": "Find a cure to cancer",
    "background": true
  }'

```
**Python**

```python
from google import genai

client = genai.Client()
interaction = client.interactions.create(
    agent="deep-research-pro-preview-12-2025",
    input="find a cure to cancer",
    background=True,
)
print(interaction.status)

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.create({
    agent: 'deep-research-pro-preview-12-2025',
    input: 'find a cure to cancer',
    background: true,
});
console.log(interaction.status);

```

Response:
```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "agent": "deep-research-pro-preview-12-2025",
  "status": "completed",
  "object": "interaction",
  "created": "2025-11-26T12:22:47Z",
  "updated": "2025-11-26T12:22:47Z",
  "role": "model",
  "outputs": [
    {
      "type": "text",
      "text": "Here is a comprehensive research report on the current state of cancer research..."
    }
  ],
  "usage": {
    "input_tokens_by_modality": [
      {
        "modality": "text",
        "tokens": 20
      }
    ],
    "total_cached_tokens": 0,
    "total_input_tokens": 20,
    "total_output_tokens": 1000,
    "total_thought_tokens": 500,
    "total_tokens": 1520,
    "total_tool_use_tokens": 0
  }
}
```

---
### Retrieving an interaction

`GET https://generativelanguage.googleapis.com/v1beta/interactions/{id}`

Retrieves the full details of a single interaction based on its `Interaction.id`.

#### Parameters
- **id** (`string`) *(Required)* The unique identifier of the interaction to retrieve.

- **stream** (`boolean`) If set to true, the generated content will be streamed incrementally.
 Default: `False`
- **last_event_id** (`string`) Optional. If set, resumes the interaction stream from the next chunk after the event marked by the event id. Can only be used if `stream` is true.

- **api_version** (`string`) Which version of the API to use.



#### Response
Returns [Interaction](#interaction) resources.

#### Examples
**Get Interaction**

**REST**

```sh
curl -X GET https://generativelanguage.googleapis.com/v1beta/interactions/v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg \
  -H "x-goog-api-key: $GEMINI_API_KEY"

```
**Python**

```python
from google import genai

client = genai.Client()

interaction = client.interactions.get(id="v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg")
print(interaction.status)

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.get('v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg');
console.log(interaction.status);

```

Response:
```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "model": "gemini-3-flash-preview",
  "status": "completed",
  "object": "interaction",
  "created": "2025-11-26T12:25:15Z",
  "updated": "2025-11-26T12:25:15Z",
  "role": "model",
  "outputs": [
    {
      "type": "text",
      "text": "I'm doing great, thank you for asking! How can I help you today?"
    }
  ]
}
```

---
### Deleting an interaction

`DELETE https://generativelanguage.googleapis.com/v1beta/interactions/{id}`

Deletes the interaction by id.

#### Parameters
- **id** (`string`) *(Required)* The unique identifier of the interaction to delete.

- **api_version** (`string`) Which version of the API to use.



#### Response

#### Examples
**Delete Interaction**

**REST**

```sh
curl -X DELETE https://generativelanguage.googleapis.com/v1beta/interactions/v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg \
  -H "x-goog-api-key: $GEMINI_API_KEY"

```
**Python**

```python
from google import genai

client = genai.Client()

interaction = client.interactions.delete(id="v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg")
print(interaction.status)

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.delete('v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg');
console.log(interaction.status);

```


---
### Canceling an interaction

`POST https://generativelanguage.googleapis.com/v1beta/interactions/{id}/cancel`

Cancels an interaction by id. This only applies to background interactions that are still running.

#### Parameters
- **id** (`string`) *(Required)* The unique identifier of the interaction to cancel.

- **api_version** (`string`) Which version of the API to use.



#### Response
Returns [Interaction](#interaction) resources.

#### Examples
**Cancel Interaction**

**REST**

```sh
curl -X POST https://generativelanguage.googleapis.com/v1beta/interactions/v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg/cancel \
  -H "x-goog-api-key: $GEMINI_API_KEY"

```
**Python**

```python
from google import genai

client = genai.Client()

interaction = client.interactions.cancel(id="v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg")
print(interaction.status)

```
**JavaScript**

```javascript
import {GoogleGenAI} from '@google/genai';

const ai = new GoogleGenAI({});
const interaction = await ai.interactions.cancel('v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg');
console.log(interaction.status);

```

Response:
```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "agent": "deep-research-pro-preview-12-2025",
  "status": "cancelled",
  "object": "interaction",
  "created": "2025-11-26T12:25:15Z",
  "updated": "2025-11-26T12:25:15Z",
  "role": "model"
}
```

---

## Resources
### Interaction
The Interaction resource.

**Properties:**
- **model** (`<a href="#Resource:ModelOption">ModelOption</a>`) The name of the `Model` used for generating the interaction.
 Possible values:
 - `gemini-2.5-pro`: Our state-of-the-art multipurpose model, which excels at coding and complex reasoning tasks. - `gemini-2.5-flash`: Our first hybrid reasoning model which supports a 1M token context window and has thinking budgets. - `gemini-2.5-flash-preview-09-2025`: The latest model based on the 2.5 Flash model. 2.5 Flash Preview is best for large scale processing, low-latency, high volume tasks that require thinking, and agentic use cases. - `gemini-2.5-flash-lite`: Our smallest and most cost effective model, built for at scale usage. - `gemini-2.5-flash-lite-preview-09-2025`: The latest model based on Gemini 2.5 Flash lite optimized for cost-efficiency, high throughput and high quality. - `gemini-2.5-flash-preview-native-audio-dialog`: Our native audio models optimized for higher quality audio outputs with better pacing, voice naturalness, verbosity, and mood. - `gemini-2.5-flash-image-preview`: Our native image generation model, optimized for speed, flexibility, and contextual understanding. Text input and output is priced the same as 2.5 Flash. - `gemini-2.5-pro-preview-tts`: Our 2.5 Pro text-to-speech audio model optimized for powerful, low-latency speech generation for more natural outputs and easier to steer prompts. - `gemini-3-pro-preview`: Our most intelligent model with SOTA reasoning and multimodal understanding, and powerful agentic and vibe coding capabilities. - `gemini-3-flash-preview`: Our most intelligent model built for speed, combining frontier intelligence with superior search and grounding.
- **agent** (`<a href="#Resource:AgentOption">AgentOption</a>`) The name of the `Agent` used for generating the interaction.
 Possible values:
 - `deep-research-pro-preview-12-2025`: Gemini Deep Research Agent
- **id** (`string`) *(Required)* Output only. A unique identifier for the interaction completion.

- **status** (`enum (string)`) *(Required)* Output only. The status of the interaction.
 Possible values:
 - `in_progress` - `requires_action` - `completed` - `failed` - `cancelled`
- **created** (`string`) Output only. The time at which the response was created in ISO 8601 format (YYYY-MM-DDThh:mm:ssZ).

- **updated** (`string`) Output only. The time at which the response was last updated in ISO 8601 format (YYYY-MM-DDThh:mm:ssZ).

- **role** (`string`) Output only. The role of the interaction.

- **outputs** (`array (<a href="#Resource:Content">Content</a>)`) Output only. Responses from the model.

- **system_instruction** (`string`) System instruction for the interaction.

- **tools** (`array (<a href="#Resource:Tool">Tool</a>)`) A list of tool declarations the model may call during interaction.

- **usage** (`<a href="#Resource:Usage">Usage</a>`) Output only. Statistics on the interaction request's token usage.
 - **total_input_tokens** (`integer`)  Number of tokens in the prompt (context).

 - **input_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)  A breakdown of input token usage by modality.
  - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)   The modality associated with the token count.
   Possible values:
   - `text`   - `image`   - `audio`
  - **tokens** (`integer`)   Number of tokens for the modality.


 - **total_cached_tokens** (`integer`)  Number of tokens in the cached part of the prompt (the cached content).

 - **cached_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)  A breakdown of cached token usage by modality.
  - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)   The modality associated with the token count.
   Possible values:
   - `text`   - `image`   - `audio`
  - **tokens** (`integer`)   Number of tokens for the modality.


 - **total_output_tokens** (`integer`)  Total number of tokens across all the generated responses.

 - **output_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)  A breakdown of output token usage by modality.
  - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)   The modality associated with the token count.
   Possible values:
   - `text`   - `image`   - `audio`
  - **tokens** (`integer`)   Number of tokens for the modality.


 - **total_tool_use_tokens** (`integer`)  Number of tokens present in tool-use prompt(s).

 - **tool_use_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)  A breakdown of tool-use token usage by modality.
  - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)   The modality associated with the token count.
   Possible values:
   - `text`   - `image`   - `audio`
  - **tokens** (`integer`)   Number of tokens for the modality.


 - **total_thought_tokens** (`integer`)  Number of tokens of thoughts for thinking models.

 - **total_tokens** (`integer`)  Total token count for the interaction request (prompt + responses + other internal tokens).


- **response_modalities** (`array (<a href="#Resource:ResponseModality">ResponseModality</a>)`) The requested modalities of the response (TEXT, IMAGE, AUDIO).
 Possible values:
 - `text` - `image` - `audio`
- **response_format** (`object`) Enforces that the generated response is a JSON object that complies with the JSON schema specified in this field.

- **response_mime_type** (`string`) The mime type of the response. This is required if response_format is set.

- **previous_interaction_id** (`string`) The ID of the previous interaction, if any.

- **input** (`<a href="#Resource:Content">Content</a> or array (<a href="#Resource:Content">Content</a>) or array (<a href="#Resource:Turn">Turn</a>) or string`) The inputs for the interaction.

- **generation_config** (`<a href="#Resource:GenerationConfig">GenerationConfig</a>`) Input only. Configuration parameters for the model interaction.
 - **temperature** (`number`)  Controls the randomness of the output.

 - **top_p** (`number`)  The maximum cumulative probability of tokens to consider when sampling.

 - **seed** (`integer`)  Seed used in decoding for reproducibility.

 - **stop_sequences** (`array (string)`)  A list of character sequences that will stop output interaction.

 - **tool_choice** (`<a href="#Resource:ToolChoice">ToolChoice</a>`)  The tool choice for the interaction.

 - **thinking_level** (`<a href="#Resource:ThinkingLevel">ThinkingLevel</a>`)  The level of thought tokens that the model should generate.
  Possible values:
  - `minimal`  - `low`  - `medium`  - `high`
 - **thinking_summaries** (`<a href="#Resource:ThinkingSummaries">ThinkingSummaries</a>`)  Whether to include thought summaries in the response.
  Possible values:
  - `auto`  - `none`
 - **max_output_tokens** (`integer`)  The maximum number of tokens to include in the response.

 - **speech_config** (`array (<a href="#Resource:SpeechConfig">SpeechConfig</a>)`)  Configuration for speech interaction.
  - **voice** (`string`)   The voice of the speaker.

  - **language** (`string`)   The language of the speech.

  - **speaker** (`string`)   The speaker's name, it should match the speaker name given in the prompt.


 - **image_config** (`<a href="#Resource:ImageConfig">ImageConfig</a>`)  Configuration for image interaction.
  - **aspect_ratio** (`enum (string)`)
   Possible values:
   - `1:1`   - `2:3`   - `3:2`   - `3:4`   - `4:3`   - `4:5`   - `5:4`   - `9:16`   - `16:9`   - `21:9`
  - **image_size** (`enum (string)`)
   Possible values:
   - `1K`   - `2K`   - `4K`


- **agent_config** (`<a href="#Resource:DeepResearchAgentConfig">DeepResearchAgentConfig</a> or <a href="#Resource:DynamicAgentConfig">DynamicAgentConfig</a>`) Configuration for the agent.
 **Possible Types:** (Discriminator: `type`) - **DynamicAgentConfig**: Configuration for dynamic agents.
  - **type** (`object`)
   Value: `dynamic`
 - **DeepResearchAgentConfig**: Configuration for the Deep Research agent.
  - **thinking_summaries** (`<a href="#Resource:ThinkingSummaries">ThinkingSummaries</a>`)   Whether to include thought summaries in the response.
   Possible values:
   - `auto`   - `none`
  - **type** (`object`)
   Value: `deep-research`


**JSON Representation:**
```json
{
  "created": "2025-12-04T15:01:45Z",
  "id": "v1_ChdXS0l4YWZXTk9xbk0xZThQczhEcmlROBIXV0tJeGFmV05PcW5NMWU4UHM4RHJpUTg",
  "model": "gemini-3-flash-preview",
  "object": "interaction",
  "outputs": [
    {
      "text": "Hello! I'm doing well, functioning as expected. Thank you for asking! How are you doing today?",
      "type": "text"
    }
  ],
  "role": "model",
  "status": "completed",
  "updated": "2025-12-04T15:01:45Z",
  "usage": {
    "input_tokens_by_modality": [
      {
        "modality": "text",
        "tokens": 7
      }
    ],
    "total_cached_tokens": 0,
    "total_input_tokens": 7,
    "total_output_tokens": 23,
    "total_thought_tokens": 49,
    "total_tokens": 79,
    "total_tool_use_tokens": 0
  }
}
```


## Data Models
### Content
The content of the response.

**Polymorphic Types:** (Discriminator: `type`)- **TextContent**
    - A text content block.
     - **text** (`string`)  The text content.

     - **annotations** (`array (<a href="#Resource:Annotation">Annotation</a>)`)  Citation information for model-generated content.
  - **start_index** (`integer`)   Start of segment of the response that is attributed to this source.  Index indicates the start of the segment, measured in bytes.

  - **end_index** (`integer`)   End of the attributed segment, exclusive.

  - **source** (`string`)   Source attributed for a portion of the text. Could be a URL, title, or other identifier.


     - **type** (`object`) *(Required)*
  Value: `text`
- **ImageContent**
    - An image content block.
     - **data** (`string`)  The image content.

     - **uri** (`string`)  The URI of the image.

     - **mime_type** (`<a href="#Resource:ImageMimeTypeOption">ImageMimeTypeOption</a>`)
  Possible values:
  - `image/png`  - `image/jpeg`  - `image/webp`  - `image/heic`  - `image/heif`
     - **resolution** (`<a href="#Resource:MediaResolution">MediaResolution</a>`)  The resolution of the media.
  Possible values:
  - `low`  - `medium`  - `high`  - `ultra_high`
     - **type** (`object`) *(Required)*
  Value: `image`
- **AudioContent**
    - An audio content block.
     - **data** (`string`)  The audio content.

     - **uri** (`string`)  The URI of the audio.

     - **mime_type** (`<a href="#Resource:AudioMimeTypeOption">AudioMimeTypeOption</a>`)
  Possible values:
  - `audio/wav`  - `audio/mp3`  - `audio/aiff`  - `audio/aac`  - `audio/ogg`  - `audio/flac`
     - **type** (`object`) *(Required)*
  Value: `audio`
- **DocumentContent**
    - A document content block.
     - **data** (`string`)  The document content.

     - **uri** (`string`)  The URI of the document.

     - **mime_type** (`<a href="#Resource:DocumentMimeTypeOption">DocumentMimeTypeOption</a>`)
  Possible values:
  - `application/pdf`
     - **type** (`object`) *(Required)*
  Value: `document`
- **VideoContent**
    - A video content block.
     - **data** (`string`)  The video content.

     - **uri** (`string`)  The URI of the video.

     - **mime_type** (`<a href="#Resource:VideoMimeTypeOption">VideoMimeTypeOption</a>`)
  Possible values:
  - `video/mp4`  - `video/mpeg`  - `video/mov`  - `video/avi`  - `video/x-flv`  - `video/mpg`  - `video/webm`  - `video/wmv`  - `video/3gpp`
     - **resolution** (`<a href="#Resource:MediaResolution">MediaResolution</a>`)  The resolution of the media.
  Possible values:
  - `low`  - `medium`  - `high`  - `ultra_high`
     - **type** (`object`) *(Required)*
  Value: `video`
- **ThoughtContent**
    - A thought content block.
     - **signature** (`string`)  Signature to match the backend source to be part of the generation.

     - **summary** (`<a href="#Resource:ThoughtSummary">ThoughtSummary</a>`)  A summary of the thought.

     - **type** (`object`) *(Required)*
  Value: `thought`
- **FunctionCallContent**
    - A function tool call content block.
     - **name** (`string`) *(Required)*  The name of the tool to call.

     - **arguments** (`object`) *(Required)*  The arguments to pass to the function.

     - **type** (`object`) *(Required)*
  Value: `function_call`
     - **id** (`string`) *(Required)*  A unique ID for this specific tool call.

- **FunctionResultContent**
    - A function tool result content block.
     - **name** (`string`)  The name of the tool that was called.

     - **is_error** (`boolean`)  Whether the tool call resulted in an error.

     - **type** (`object`) *(Required)*
  Value: `function_result`
     - **result** (`object or string`) *(Required)*  The result of the tool call.

     - **call_id** (`string`) *(Required)*  ID to match the ID from the function call block.

- **CodeExecutionCallContent**
    - Code execution content.
     - **arguments** (`<a href="#Resource:CodeExecutionCallArguments">CodeExecutionCallArguments</a>`)  The arguments to pass to the code execution.
  - **language** (`enum (string)`)   Programming language of the `code`.
   Possible values:
   - `python`
  - **code** (`string`)   The code to be executed.


     - **type** (`object`) *(Required)*
  Value: `code_execution_call`
     - **id** (`string`)  A unique ID for this specific tool call.

- **CodeExecutionResultContent**
    - Code execution result content.
     - **result** (`string`)  The output of the code execution.

     - **is_error** (`boolean`)  Whether the code execution resulted in an error.

     - **signature** (`string`)  A signature hash for backend validation.

     - **type** (`object`) *(Required)*
  Value: `code_execution_result`
     - **call_id** (`string`)  ID to match the ID from the code execution call block.

- **UrlContextCallContent**
    - URL context content.
     - **arguments** (`<a href="#Resource:UrlContextCallArguments">UrlContextCallArguments</a>`)  The arguments to pass to the URL context.
  - **urls** (`array (string)`)   The URLs to fetch.


     - **type** (`object`) *(Required)*
  Value: `url_context_call`
     - **id** (`string`)  A unique ID for this specific tool call.

- **UrlContextResultContent**
    - URL context result content.
     - **signature** (`string`)  The signature of the URL context result.

     - **result** (`array (<a href="#Resource:UrlContextResult">UrlContextResult</a>)`)  The results of the URL context.
  - **url** (`string`)   The URL that was fetched.

  - **status** (`enum (string)`)   The status of the URL retrieval.
   Possible values:
   - `success`   - `error`   - `paywall`   - `unsafe`

     - **is_error** (`boolean`)  Whether the URL context resulted in an error.

     - **type** (`object`) *(Required)*
  Value: `url_context_result`
     - **call_id** (`string`)  ID to match the ID from the url context call block.

- **GoogleSearchCallContent**
    - Google Search content.
     - **arguments** (`<a href="#Resource:GoogleSearchCallArguments">GoogleSearchCallArguments</a>`)  The arguments to pass to Google Search.
  - **queries** (`array (string)`)   Web search queries for the following-up web search.


     - **type** (`object`) *(Required)*
  Value: `google_search_call`
     - **id** (`string`)  A unique ID for this specific tool call.

- **GoogleSearchResultContent**
    - Google Search result content.
     - **signature** (`string`)  The signature of the Google Search result.

     - **result** (`array (<a href="#Resource:GoogleSearchResult">GoogleSearchResult</a>)`)  The results of the Google Search.
  - **url** (`string`)   URI reference of the search result.

  - **title** (`string`)   Title of the search result.

  - **rendered_content** (`string`)   Web content snippet that can be embedded in a web page or an app webview.


     - **is_error** (`boolean`)  Whether the Google Search resulted in an error.

     - **type** (`object`) *(Required)*
  Value: `google_search_result`
     - **call_id** (`string`)  ID to match the ID from the google search call block.

- **McpServerToolCallContent**
    - MCPServer tool call content.
     - **name** (`string`) *(Required)*  The name of the tool which was called.

     - **server_name** (`string`) *(Required)*  The name of the used MCP server.

     - **arguments** (`object`) *(Required)*  The JSON object of arguments for the function.

     - **type** (`object`) *(Required)*
  Value: `mcp_server_tool_call`
     - **id** (`string`) *(Required)*  A unique ID for this specific tool call.

- **McpServerToolResultContent**
    - MCPServer tool result content.
     - **name** (`string`)  Name of the tool which is called for this specific tool call.

     - **server_name** (`string`)  The name of the used MCP server.

     - **type** (`object`) *(Required)*
  Value: `mcp_server_tool_result`
     - **result** (`object or string`) *(Required)*  The result of the tool call.

     - **call_id** (`string`) *(Required)*  ID to match the ID from the MCP server tool call block.

- **FileSearchCallContent**
    - File Search content.
     - **type** (`object`) *(Required)*
  Value: `file_search_call`
     - **id** (`string`)  A unique ID for this specific tool call.

- **FileSearchResultContent**
    - File Search result content.
     - **result** (`array (<a href="#Resource:FileSearchResult">FileSearchResult</a>)`)  The results of the File Search.
  - **title** (`string`)   The title of the search result.

  - **text** (`string`)   The text of the search result.

  - **file_search_store** (`string`)   The name of the file search store.


     - **type** (`object`) *(Required)*
  Value: `file_search_result`

**JSON Representation:**
```json
{
  "text": "string",
  "annotations": [
    {
      "start_index": 0,
      "end_index": 0,
      "source": "string"
    }
  ],
  "type": {}
}
```

### Tool


**Polymorphic Types:** (Discriminator: `type`)- **Function**
    - A tool that can be used by the model.
     - **name** (`string`)  The name of the function.

     - **description** (`string`)  A description of the function.

     - **parameters** (`object`)  The JSON Schema for the function's parameters.

     - **type** (`string`) *(Required)*
  Value: `function`
- **GoogleSearch**
    - A tool that can be used by the model to search Google.
     - **type** (`string`) *(Required)*
  Value: `google_search`
- **CodeExecution**
    - A tool that can be used by the model to execute code.
     - **type** (`string`) *(Required)*
  Value: `code_execution`
- **UrlContext**
    - A tool that can be used by the model to fetch URL context.
     - **type** (`string`) *(Required)*
  Value: `url_context`
- **ComputerUse**
    - A tool that can be used by the model to interact with the computer.
     - **environment** (`enum (string)`)  The environment being operated.
  Possible values:
  - `browser`
     - **excludedPredefinedFunctions** (`array (string)`)  The list of predefined functions that are excluded from the model call.

     - **type** (`string`) *(Required)*
  Value: `computer_use`
- **McpServer**
    - A MCPServer is a server that can be called by the model to perform actions.
     - **name** (`string`)  The name of the MCPServer.

     - **url** (`string`)  The full URL for the MCPServer endpoint. Example: "https://api.example.com/mcp"

     - **headers** (`object`)  Optional: Fields for authentication headers, timeouts, etc., if needed.

     - **allowed_tools** (`array (<a href="#Resource:AllowedTools">AllowedTools</a>)`)  The allowed tools.
  - **mode** (`<a href="#Resource:ToolChoiceType">ToolChoiceType</a>`)   The mode of the tool choice.
   Possible values:
   - `auto`   - `any`   - `none`   - `validated`
  - **tools** (`array (string)`)   The names of the allowed tools.


     - **type** (`string`) *(Required)*
  Value: `mcp_server`
- **FileSearch**
    - A tool that can be used by the model to search files.
     - **file_search_store_names** (`array (string)`)  The file search store names to search.

     - **top_k** (`integer`)  The number of semantic retrieval chunks to retrieve.

     - **metadata_filter** (`string`)  Metadata filter to apply to the semantic retrieval documents and chunks.

     - **type** (`string`) *(Required)*
  Value: `file_search`

**JSON Representation:**
```json
{
  "name": "string",
  "description": "string",
  "parameters": {},
  "type": "function"
}
```

### Turn


**Properties:**
- **role** (`string`) The originator of this turn. Must be user for input or model for model output.

- **content** (`array (<a href="#Resource:Content">Content</a>) or string`) The content of the turn.


**JSON Representation:**
```json
{
  "role": "string",
  "content": "string"
}
```

### InteractionSseEvent


**Polymorphic Types:** (Discriminator: `event_type`)- **InteractionEvent**
    -
     - **event_type** (`enum (string)`)
  Possible values:
  - `interaction.start`  - `interaction.complete`
     - **interaction** (`<a href="#Resource:Interaction">Interaction</a>`)
  - **model** (`<a href="#Resource:ModelOption">ModelOption</a>`)   The name of the `Model` used for generating the interaction.
   Possible values:
   - `gemini-2.5-pro`: Our state-of-the-art multipurpose model, which excels at coding and complex reasoning tasks.   - `gemini-2.5-flash`: Our first hybrid reasoning model which supports a 1M token context window and has thinking budgets.   - `gemini-2.5-flash-preview-09-2025`: The latest model based on the 2.5 Flash model. 2.5 Flash Preview is best for large scale processing, low-latency, high volume tasks that require thinking, and agentic use cases.   - `gemini-2.5-flash-lite`: Our smallest and most cost effective model, built for at scale usage.   - `gemini-2.5-flash-lite-preview-09-2025`: The latest model based on Gemini 2.5 Flash lite optimized for cost-efficiency, high throughput and high quality.   - `gemini-2.5-flash-preview-native-audio-dialog`: Our native audio models optimized for higher quality audio outputs with better pacing, voice naturalness, verbosity, and mood.   - `gemini-2.5-flash-image-preview`: Our native image generation model, optimized for speed, flexibility, and contextual understanding. Text input and output is priced the same as 2.5 Flash.   - `gemini-2.5-pro-preview-tts`: Our 2.5 Pro text-to-speech audio model optimized for powerful, low-latency speech generation for more natural outputs and easier to steer prompts.   - `gemini-3-pro-preview`: Our most intelligent model with SOTA reasoning and multimodal understanding, and powerful agentic and vibe coding capabilities.   - `gemini-3-flash-preview`: Our most intelligent model built for speed, combining frontier intelligence with superior search and grounding.
  - **agent** (`<a href="#Resource:AgentOption">AgentOption</a>`)   The name of the `Agent` used for generating the interaction.
   Possible values:
   - `deep-research-pro-preview-12-2025`: Gemini Deep Research Agent
  - **id** (`string`) *(Required)*   Output only. A unique identifier for the interaction completion.

  - **status** (`enum (string)`) *(Required)*   Output only. The status of the interaction.
   Possible values:
   - `in_progress`   - `requires_action`   - `completed`   - `failed`   - `cancelled`
  - **created** (`string`)   Output only. The time at which the response was created in ISO 8601 format (YYYY-MM-DDThh:mm:ssZ).

  - **updated** (`string`)   Output only. The time at which the response was last updated in ISO 8601 format (YYYY-MM-DDThh:mm:ssZ).

  - **role** (`string`)   Output only. The role of the interaction.

  - **outputs** (`array (<a href="#Resource:Content">Content</a>)`)   Output only. Responses from the model.

  - **system_instruction** (`string`)   System instruction for the interaction.

  - **tools** (`array (<a href="#Resource:Tool">Tool</a>)`)   A list of tool declarations the model may call during interaction.

  - **usage** (`<a href="#Resource:Usage">Usage</a>`)   Output only. Statistics on the interaction request's token usage.
   - **total_input_tokens** (`integer`)    Number of tokens in the prompt (context).

   - **input_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)    A breakdown of input token usage by modality.
    - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)     The modality associated with the token count.
     Possible values:
     - `text`     - `image`     - `audio`
    - **tokens** (`integer`)     Number of tokens for the modality.


   - **total_cached_tokens** (`integer`)    Number of tokens in the cached part of the prompt (the cached content).

   - **cached_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)    A breakdown of cached token usage by modality.
    - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)     The modality associated with the token count.
     Possible values:
     - `text`     - `image`     - `audio`
    - **tokens** (`integer`)     Number of tokens for the modality.


   - **total_output_tokens** (`integer`)    Total number of tokens across all the generated responses.

   - **output_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)    A breakdown of output token usage by modality.
    - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)     The modality associated with the token count.
     Possible values:
     - `text`     - `image`     - `audio`
    - **tokens** (`integer`)     Number of tokens for the modality.


   - **total_tool_use_tokens** (`integer`)    Number of tokens present in tool-use prompt(s).

   - **tool_use_tokens_by_modality** (`array (<a href="#Resource:ModalityTokens">ModalityTokens</a>)`)    A breakdown of tool-use token usage by modality.
    - **modality** (`<a href="#Resource:ResponseModality">ResponseModality</a>`)     The modality associated with the token count.
     Possible values:
     - `text`     - `image`     - `audio`
    - **tokens** (`integer`)     Number of tokens for the modality.


   - **total_thought_tokens** (`integer`)    Number of tokens of thoughts for thinking models.

   - **total_tokens** (`integer`)    Total token count for the interaction request (prompt + responses + other internal tokens).


  - **response_modalities** (`array (<a href="#Resource:ResponseModality">ResponseModality</a>)`)   The requested modalities of the response (TEXT, IMAGE, AUDIO).
   Possible values:
   - `text`   - `image`   - `audio`
  - **response_format** (`object`)   Enforces that the generated response is a JSON object that complies with the JSON schema specified in this field.

  - **response_mime_type** (`string`)   The mime type of the response. This is required if response_format is set.

  - **previous_interaction_id** (`string`)   The ID of the previous interaction, if any.

  - **input** (`<a href="#Resource:Content">Content</a> or array (<a href="#Resource:Content">Content</a>) or array (<a href="#Resource:Turn">Turn</a>) or string`)   The inputs for the interaction.

  - **generation_config** (`<a href="#Resource:GenerationConfig">GenerationConfig</a>`)   Input only. Configuration parameters for the model interaction.
   - **temperature** (`number`)    Controls the randomness of the output.

   - **top_p** (`number`)    The maximum cumulative probability of tokens to consider when sampling.

   - **seed** (`integer`)    Seed used in decoding for reproducibility.

   - **stop_sequences** (`array (string)`)    A list of character sequences that will stop output interaction.

   - **tool_choice** (`<a href="#Resource:ToolChoice">ToolChoice</a>`)    The tool choice for the interaction.

   - **thinking_level** (`<a href="#Resource:ThinkingLevel">ThinkingLevel</a>`)    The level of thought tokens that the model should generate.
    Possible values:
    - `minimal`    - `low`    - `medium`    - `high`
   - **thinking_summaries** (`<a href="#Resource:ThinkingSummaries">ThinkingSummaries</a>`)    Whether to include thought summaries in the response.
    Possible values:
    - `auto`    - `none`
   - **max_output_tokens** (`integer`)    The maximum number of tokens to include in the response.

   - **speech_config** (`array (<a href="#Resource:SpeechConfig">SpeechConfig</a>)`)    Configuration for speech interaction.
    - **voice** (`string`)     The voice of the speaker.

    - **language** (`string`)     The language of the speech.

    - **speaker** (`string`)     The speaker's name, it should match the speaker name given in the prompt.


   - **image_config** (`<a href="#Resource:ImageConfig">ImageConfig</a>`)    Configuration for image interaction.
    - **aspect_ratio** (`enum (string)`)
     Possible values:
     - `1:1`     - `2:3`     - `3:2`     - `3:4`     - `4:3`     - `4:5`     - `5:4`     - `9:16`     - `16:9`     - `21:9`
    - **image_size** (`enum (string)`)
     Possible values:
     - `1K`     - `2K`     - `4K`


  - **agent_config** (`<a href="#Resource:DeepResearchAgentConfig">DeepResearchAgentConfig</a> or <a href="#Resource:DynamicAgentConfig">DynamicAgentConfig</a>`)   Configuration for the agent.
   **Possible Types:** (Discriminator: `type`)   - **DynamicAgentConfig**: Configuration for dynamic agents.
    - **type** (`object`)
     Value: `dynamic`
   - **DeepResearchAgentConfig**: Configuration for the Deep Research agent.
    - **thinking_summaries** (`<a href="#Resource:ThinkingSummaries">ThinkingSummaries</a>`)     Whether to include thought summaries in the response.
     Possible values:
     - `auto`     - `none`
    - **type** (`object`)
     Value: `deep-research`


     - **event_id** (`string`)  The event_id token to be used to resume the interaction stream, from this event.

- **InteractionStatusUpdate**
    -
     - **interaction_id** (`string`)

     - **status** (`enum (string)`)
  Possible values:
  - `in_progress`  - `requires_action`  - `completed`  - `failed`  - `cancelled`
     - **event_type** (`string`)
  Value: `interaction.status_update`
     - **event_id** (`string`)  The event_id token to be used to resume the interaction stream, from this event.

- **ContentStart**
    -
     - **index** (`integer`)

     - **content** (`<a href="#Resource:Content">Content</a>`)

     - **event_type** (`string`)
  Value: `content.start`
     - **event_id** (`string`)  The event_id token to be used to resume the interaction stream, from this event.

- **ContentDelta**
    -
     - **index** (`integer`)

     - **event_type** (`string`)
  Value: `content.delta`
     - **event_id** (`string`)  The event_id token to be used to resume the interaction stream, from this event.

     - **delta** (`<a href="#Resource:AudioDelta">AudioDelta</a> or <a href="#Resource:CodeExecutionCallDelta">CodeExecutionCallDelta</a> or <a href="#Resource:CodeExecutionResultDelta">CodeExecutionResultDelta</a> or <a href="#Resource:DocumentDelta">DocumentDelta</a> or <a href="#Resource:FileSearchCallDelta">FileSearchCallDelta</a> or <a href="#Resource:FileSearchResultDelta">FileSearchResultDelta</a> or <a href="#Resource:FunctionCallDelta">FunctionCallDelta</a> or <a href="#Resource:FunctionResultDelta">FunctionResultDelta</a> or <a href="#Resource:GoogleSearchCallDelta">GoogleSearchCallDelta</a> or <a href="#Resource:GoogleSearchResultDelta">GoogleSearchResultDelta</a> or <a href="#Resource:ImageDelta">ImageDelta</a> or <a href="#Resource:McpServerToolCallDelta">McpServerToolCallDelta</a> or <a href="#Resource:McpServerToolResultDelta">McpServerToolResultDelta</a> or <a href="#Resource:TextDelta">TextDelta</a> or <a href="#Resource:ThoughtSignatureDelta">ThoughtSignatureDelta</a> or <a href="#Resource:ThoughtSummaryDelta">ThoughtSummaryDelta</a> or <a href="#Resource:UrlContextCallDelta">UrlContextCallDelta</a> or <a href="#Resource:UrlContextResultDelta">UrlContextResultDelta</a> or <a href="#Resource:VideoDelta">VideoDelta</a>`)
  **Possible Types:** (Discriminator: `type`)  - **TextDelta**:
   - **text** (`string`)

   - **annotations** (`array (<a href="#Resource:Annotation">Annotation</a>)`)    Citation information for model-generated content.
    - **start_index** (`integer`)     Start of segment of the response that is attributed to this source.  Index indicates the start of the segment, measured in bytes.

    - **end_index** (`integer`)     End of the attributed segment, exclusive.

    - **source** (`string`)     Source attributed for a portion of the text. Could be a URL, title, or other identifier.


   - **type** (`object`) *(Required)*
    Value: `text`
  - **ImageDelta**:
   - **data** (`string`)

   - **uri** (`string`)

   - **mime_type** (`<a href="#Resource:ImageMimeTypeOption">ImageMimeTypeOption</a>`)
    Possible values:
    - `image/png`    - `image/jpeg`    - `image/webp`    - `image/heic`    - `image/heif`
   - **resolution** (`<a href="#Resource:MediaResolution">MediaResolution</a>`)    The resolution of the media.
    Possible values:
    - `low`    - `medium`    - `high`    - `ultra_high`
   - **type** (`object`) *(Required)*
    Value: `image`
  - **AudioDelta**:
   - **data** (`string`)

   - **uri** (`string`)

   - **mime_type** (`<a href="#Resource:AudioMimeTypeOption">AudioMimeTypeOption</a>`)
    Possible values:
    - `audio/wav`    - `audio/mp3`    - `audio/aiff`    - `audio/aac`    - `audio/ogg`    - `audio/flac`
   - **type** (`object`) *(Required)*
    Value: `audio`
  - **DocumentDelta**:
   - **data** (`string`)

   - **uri** (`string`)

   - **mime_type** (`<a href="#Resource:DocumentMimeTypeOption">DocumentMimeTypeOption</a>`)
    Possible values:
    - `application/pdf`
   - **type** (`object`) *(Required)*
    Value: `document`
  - **VideoDelta**:
   - **data** (`string`)

   - **uri** (`string`)

   - **mime_type** (`<a href="#Resource:VideoMimeTypeOption">VideoMimeTypeOption</a>`)
    Possible values:
    - `video/mp4`    - `video/mpeg`    - `video/mov`    - `video/avi`    - `video/x-flv`    - `video/mpg`    - `video/webm`    - `video/wmv`    - `video/3gpp`
   - **resolution** (`<a href="#Resource:MediaResolution">MediaResolution</a>`)    The resolution of the media.
    Possible values:
    - `low`    - `medium`    - `high`    - `ultra_high`
   - **type** (`object`) *(Required)*
    Value: `video`
  - **ThoughtSummaryDelta**:
   - **type** (`object`) *(Required)*
    Value: `thought_summary`
   - **content** (`<a href="#Resource:ImageContent">ImageContent</a> or <a href="#Resource:TextContent">TextContent</a>`)
    **Possible Types:** (Discriminator: `type`)    - **TextContent**: A text content block.
     - **text** (`string`)      The text content.

     - **annotations** (`array (<a href="#Resource:Annotation">Annotation</a>)`)      Citation information for model-generated content.
      - **start_index** (`integer`)       Start of segment of the response that is attributed to this source.  Index indicates the start of the segment, measured in bytes.

      - **end_index** (`integer`)       End of the attributed segment, exclusive.

      - **source** (`string`)       Source attributed for a portion of the text. Could be a URL, title, or other identifier.


     - **type** (`object`) *(Required)*
      Value: `text`
    - **ImageContent**: An image content block.
     - **data** (`string`)      The image content.

     - **uri** (`string`)      The URI of the image.

     - **mime_type** (`<a href="#Resource:ImageMimeTypeOption">ImageMimeTypeOption</a>`)
      Possible values:
      - `image/png`      - `image/jpeg`      - `image/webp`      - `image/heic`      - `image/heif`
     - **resolution** (`<a href="#Resource:MediaResolution">MediaResolution</a>`)      The resolution of the media.
      Possible values:
      - `low`      - `medium`      - `high`      - `ultra_high`
     - **type** (`object`) *(Required)*
      Value: `image`

  - **ThoughtSignatureDelta**:
   - **signature** (`string`)    Signature to match the backend source to be part of the generation.

   - **type** (`object`) *(Required)*
    Value: `thought_signature`
  - **FunctionCallDelta**:
   - **name** (`string`)

   - **arguments** (`object`)

   - **type** (`object`) *(Required)*
    Value: `function_call`
   - **id** (`string`)    A unique ID for this specific tool call.

  - **FunctionResultDelta**:
   - **name** (`string`)

   - **is_error** (`boolean`)

   - **type** (`object`) *(Required)*
    Value: `function_result`
   - **result** (`object or string`)    Tool call result delta.

   - **call_id** (`string`)    ID to match the ID from the function call block.

  - **CodeExecutionCallDelta**:
   - **arguments** (`<a href="#Resource:CodeExecutionCallArguments">CodeExecutionCallArguments</a>`)
    - **language** (`enum (string)`)     Programming language of the `code`.
     Possible values:
     - `python`
    - **code** (`string`)     The code to be executed.


   - **type** (`object`) *(Required)*
    Value: `code_execution_call`
   - **id** (`string`)    A unique ID for this specific tool call.

  - **CodeExecutionResultDelta**:
   - **result** (`string`)

   - **is_error** (`boolean`)

   - **signature** (`string`)

   - **type** (`object`) *(Required)*
    Value: `code_execution_result`
   - **call_id** (`string`)    ID to match the ID from the function call block.

  - **UrlContextCallDelta**:
   - **arguments** (`<a href="#Resource:UrlContextCallArguments">UrlContextCallArguments</a>`)
    - **urls** (`array (string)`)     The URLs to fetch.


   - **type** (`object`) *(Required)*
    Value: `url_context_call`
   - **id** (`string`)    A unique ID for this specific tool call.

  - **UrlContextResultDelta**:
   - **signature** (`string`)

   - **result** (`array (<a href="#Resource:UrlContextResult">UrlContextResult</a>)`)
    - **url** (`string`)     The URL that was fetched.

    - **status** (`enum (string)`)     The status of the URL retrieval.
     Possible values:
     - `success`     - `error`     - `paywall`     - `unsafe`

   - **is_error** (`boolean`)

   - **type** (`object`) *(Required)*
    Value: `url_context_result`
   - **call_id** (`string`)    ID to match the ID from the function call block.

  - **GoogleSearchCallDelta**:
   - **arguments** (`<a href="#Resource:GoogleSearchCallArguments">GoogleSearchCallArguments</a>`)
    - **queries** (`array (string)`)     Web search queries for the following-up web search.


   - **type** (`object`) *(Required)*
    Value: `google_search_call`
   - **id** (`string`)    A unique ID for this specific tool call.

  - **GoogleSearchResultDelta**:
   - **signature** (`string`)

   - **result** (`array (<a href="#Resource:GoogleSearchResult">GoogleSearchResult</a>)`)
    - **url** (`string`)     URI reference of the search result.

    - **title** (`string`)     Title of the search result.

    - **rendered_content** (`string`)     Web content snippet that can be embedded in a web page or an app webview.


   - **is_error** (`boolean`)

   - **type** (`object`) *(Required)*
    Value: `google_search_result`
   - **call_id** (`string`)    ID to match the ID from the function call block.

  - **McpServerToolCallDelta**:
   - **name** (`string`)

   - **server_name** (`string`)

   - **arguments** (`object`)

   - **type** (`object`) *(Required)*
    Value: `mcp_server_tool_call`
   - **id** (`string`)    A unique ID for this specific tool call.

  - **McpServerToolResultDelta**:
   - **name** (`string`)

   - **server_name** (`string`)

   - **type** (`object`) *(Required)*
    Value: `mcp_server_tool_result`
   - **result** (`object or string`)    Tool call result delta.

   - **call_id** (`string`)    ID to match the ID from the function call block.

  - **FileSearchCallDelta**:
   - **type** (`object`) *(Required)*
    Value: `file_search_call`
   - **id** (`string`)    A unique ID for this specific tool call.

  - **FileSearchResultDelta**:
   - **result** (`array (<a href="#Resource:FileSearchResult">FileSearchResult</a>)`)
    - **title** (`string`)     The title of the search result.

    - **text** (`string`)     The text of the search result.

    - **file_search_store** (`string`)     The name of the file search store.


   - **type** (`object`) *(Required)*
    Value: `file_search_result`

- **ContentStop**
    -
     - **index** (`integer`)

     - **event_type** (`string`)
  Value: `content.stop`
     - **event_id** (`string`)  The event_id token to be used to resume the interaction stream, from this event.

- **ErrorEvent**
    -
     - **event_type** (`string`)
  Value: `error`
     - **error** (`<a href="#Resource:Error">Error</a>`)
  - **code** (`string`)   A URI that identifies the error type.

  - **message** (`string`)   A human-readable error message.


     - **event_id** (`string`)  The event_id token to be used to resume the interaction stream, from this event.


**JSON Representation:**
```json
{
  "event_type": "interaction.start",
  "interaction": {
    "created": "2025-12-04T15:01:45Z",
    "id": "v1_ChdXS0l4YWZXTk9xbk0xZThQczhEcmlROBIXV0tJeGFmV05PcW5NMWU4UHM4RHJpUTg",
    "model": "gemini-3-flash-preview",
    "object": "interaction",
    "outputs": [
      {
        "text": "Hello! I'm doing well, functioning as expected. Thank you for asking! How are you doing today?",
        "type": "text"
      }
    ],
    "role": "model",
    "status": "completed",
    "updated": "2025-12-04T15:01:45Z",
    "usage": {
      "input_tokens_by_modality": [
        {
          "modality": "text",
          "tokens": 7
        }
      ],
      "total_cached_tokens": 0,
      "total_input_tokens": 7,
      "total_output_tokens": 23,
      "total_thought_tokens": 49,
      "total_tokens": 79,
      "total_tool_use_tokens": 0
    }
  },
  "event_id": "string"
}
```

