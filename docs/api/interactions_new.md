The Interactions API lets developers build generative AI applications using
generative models and agents hosted on Gemini Enterprise Agent Platform. For conceptual
information, supported models and tools, and billing and compliance details, see the
[Interactions API overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/interactions.md.txt).
For SDK setup instructions and code samples for common interaction workflows, see the
[Interactions API developer guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/interactions/developer-guide.md.txt).

## Creating an interaction

post https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/interactions Creates a new interaction.
- [Request body](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#CreateInteraction.request_body)
- [Response](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#CreateInteraction.response)

### Request body

The request body contains data with the following structure:
model ModelOption (optional) The name of the \`Model\` used for generating the interaction.

**Required if \`agent\` is not provided.**

Possible
values:

- `gemini-4-hydrogen`

  Google's near-frontier model built for
  speed and efficiency across everyday coding and agentic workflows, multimodal
  analysis, and tool use.
- `gemini-4-carbon`

  Google's frontier model that excels
  at deep work in complex, real-world tasks across domains including coding,
  finance, legal, cybersecurity, and science.
- `gemini-4-carbon-cyber-permissive`

  Cybersecurity variant of
  `gemini-4-carbon` for defensive cybersecurity workflows (available
  behind the Fairwind Program allowlist).
- `gemini-4-argon`

  Google's frontier model that excels
  at deep work in complex, real-world tasks across domains including coding,
  finance, legal, cybersecurity, and science.
- `gemini-4-argon-cyber-permissive`

  Cybersecurity variant of
  `gemini-4-argon` for defensive cybersecurity workflows (available
  behind the Fairwind Program allowlist).
- `gemini-3.8-flash`

  Our fast, high-performance
  multimodal model optimized for coding, reasoning, multimodal understanding,
  and agentic workflows.
- `gemini-3.7-flash`

  Our fast, high-performance
  multimodal model optimized for coding, reasoning, and agentic workflows.
  Default model for Interactions API.
- `gemini-3.6-flash`

  Fast, high-performance multimodal
  model optimized for reasoning, multimodal understanding, and
  agentic workflows.
- `gemini-3.5-flash-lite`

  Lightweight, highly cost-efficient
  multimodal model optimized for high throughput and low-latency agentic tasks.
- `gemini-3.1-pro-preview`

  Our most capable multimodal model
  for complex reasoning, coding, and multi-step agentic tasks.
- `gemini-3.1-flash-lite`

  Highly cost-efficient, low-latency
  model for high-frequency requests.
- `gemini-omni-1.2-flash`

  Our generally available multimodal
  model designed for video, image, and text tasks, optimized for video generation
  and editing up to 15 seconds, video extension, and standalone video upscaling
  alongside text responses.
- `gemini-omni-1.1-flash-preview`

  Our updated multimodal model
  designed for video, image, and text tasks, optimized for video generation
  alongside text responses.
- `gemini-omni-flash-preview`

  Our high-performance multimodal
  model designed for fast, conversational video generation, editing, and
  cinematic control.
- `lyria-3-clip-preview`

  Our low-latency, music generation
  model optimized for high-fidelity audio clips and precise rhythmic control.
  Available in stateless interactions only (`store=false`).
- `lyria-3-pro-preview`

  Our advanced, full-song generative
  model with deep compositional understanding, optimized for precise structural
  control and complex transitions across diverse musical styles. Available in
  stateless interactions only (`store=false`).

The model that will complete your prompt.\\n\\nSee \[models\](https://ai.google.dev/gemini-api/docs/models) for additional details.
agent AgentOption (optional) The name of the \`Agent\` used for generating the interaction.   
**Required if \`model\` is not provided.**

Possible
values:

- `antigravity-preview-05-2026`

  Our general-purpose autonomous agent
  designed for multi-step reasoning, coding, file operations, and tool use.
- `deep-research-preview-04-2026`

  Gemini Deep Research Agent designed
  for autonomous, multi-step web research and synthesis.

The agent to interact with.
input [Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content) or array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) or array ([Step](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Step)) or string (required) The inputs for the interaction (common to both Model and Agent).
system_instruction string (optional) System instruction for the interaction.
tools array ([Tool](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Tool)) (optional) A list of tool declarations the model may call during interaction.
response_format [ResponseFormat](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:ResponseFormat) or array ([ResponseFormat](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:ResponseFormat)) (optional) Enforces that the generated response is a JSON object that complies with the JSON schema specified in this field.
stream boolean (optional) Input only. Whether the interaction will be streamed.
store boolean (optional) Input only. Whether to store the response and request for later retrieval. Defaults to `true`; set to `false` for stateless interactions.
background boolean (optional) Input only. Whether to run the model interaction in the background.
generation_config GenerationConfig (optional) **Model Configuration**   
Configuration parameters for the model interaction.   
*Alternative to \`agent_config\`. Only applicable when \`model\` is set.*
Configuration parameters for model interactions.

#### Fields

temperature number (optional) Controls the randomness of the output.
top_p number (optional) The maximum cumulative probability of tokens to consider when sampling.
seed integer (optional) Seed used in decoding for reproducibility.
stop_sequences array (string) (optional) A list of character sequences that will stop output interaction.
thinking_level ThinkingLevel (optional) The level of thought tokens that the model should generate.

Possible
values:

- `minimal`
- `low`
- `medium`
- `high`

<br />

thinking_summaries ThinkingSummaries (optional) Whether to include thought summaries in the response.

Possible
values:

- `auto`
- `none`

<br />

max_output_tokens integer (optional) The maximum number of tokens to include in the response.
speech_config SpeechConfig (optional) Configuration for speech interaction.
The configuration for speech interaction.

#### Fields

voice string (optional) The voice of the speaker.
language string (optional) The language of the speech.
speaker string (optional) The speaker's name, it should match the speaker name given in the prompt.
image_config ImageConfig (optional) Configuration for image interaction.
The configuration for image interaction.

#### Fields

aspect_ratio enum (string) (optional) No description provided.

Possible
values:

- `1:1`
- `2:3`
- `3:2`
- `3:4`
- `4:3`
- `4:5`
- `5:4`
- `9:16`
- `16:9`
- `21:9`
- `1:8`
- `8:1`
- `1:4`
- `4:1`
image_size enum (string) (optional) No description provided.

Possible
values:

- `1K`
- `2K`
- `4K`
- `512`
tool_choice [ToolChoiceConfig](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:ToolChoiceConfig) or [ToolChoiceType](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:ToolChoiceType) (optional) The tool choice configuration.
agent_config object (optional) **Agent Configuration**   
Configuration for the agent.   
*Alternative to \`generation_config\`. Only applicable when \`agent\` is set.*

#### Possible Types

Polymorphic discriminator: `type`
DynamicAgentConfig Configuration for dynamic agents.
type object (required) No description provided.

Always set to `"dynamic"`.
previous_interaction_id string (optional) The ID of the previous interaction, if any.
response_modalities ResponseModality (optional) The requested modalities of the response (TEXT, IMAGE, AUDIO).

Possible
values:

- `text`
- `image`
- `audio`
- `video`
- `document`

<br />

### Response

Returns an [Interaction](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Interaction) resource or a stream of server-sent events of [InteractionSseEvent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:InteractionSseEvent) resource.

### Simple Request

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_d622e64f3cfa7c15f486c69e339afb5a92189d48b4701df263202bdac978da69.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

#### Example Response

```json
{
  "id": "u-sAauOtHceE6dgPnsup0Qo",
  "status": "completed",
  "created": "2026-05-10T20:34:13Z",
  "updated": "2026-05-10T20:34:13Z",
  "steps": [
    {
      "content": [
        {
          "text": "[0.0:] Let the music lift you high\n[3.8:] Dancing under neon skies\n[7.5:] Feel the rhythm in your soul\n[11.3:] Lose yourself and lose control",
          "type": "text"
        }
      ],
      "type": "model_output"
    },
    {
      "content": [
        {
          "text": "Caption: This is a quintessential example of high-energy, euphoric Progressive House, a subgenre of EDM defined by its massive scale and uplifting melodic content...",
          "type": "text"
        }
      ],
      "type": "model_output"
    },
    {
      "content": [
        {
          "mime_type": "audio/mpeg",
          "data": "",
          "type": "audio"
        }
      ],
      "type": "model_output"
    }
  ],
  "object": "interaction",
  "model": "lyria-3-clip-preview"
}
```

### Image Input

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_3550e4510a1aaeffaecf51c497da357a1a00c14dfe1544d57f30adb787fec451.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

#### Example Response

```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "status": "completed",
  "created": "2026-05-10T20:35:12Z",
  "updated": "2026-05-10T20:35:12Z",
  "steps": [
    {
      "type": "model_output",
      "content": [
        {
          "type": "text",
          "text": "[0.0:] High energy beats\n[3.8:] Matching the vibrant neon street"
        }
      ]
    },
    {
      "type": "model_output",
      "content": [
        {
          "type": "text",
          "text": "Caption: Inspired by the cyberpunk aesthetic of the image, this upbeat EDM track features heavy synthesizer bass and crisp percussion..."
        }
      ]
    },
    {
      "type": "model_output",
      "content": [
        {
          "type": "audio",
          "mime_type": "audio/mpeg",
          "data": ""
        }
      ]
    }
  ],
  "object": "interaction",
  "model": "lyria-3-clip-preview",
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
    "total_output_tokens": 45,
    "total_thought_tokens": 0,
    "total_tokens": 313,
    "total_tool_use_tokens": 0
  }
}
```

### Deep Research

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_02333a33abcfac8d52e26624dbe3df109d083158cb985b6175b5e39da544c8d5.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

#### Example Response

```json
{
  "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "agent": "deep-research-preview-04-2026",
  "status": "completed",
  "object": "interaction",
  "created": "2025-11-26T12:22:47Z",
  "updated": "2025-11-26T12:22:47Z",
  "steps": [
    {
      "type": "model_output",
      "content": [
        {
          "type": "text",
          "text": "Here is an investment memo about the luxury retail industry over the last 3 years..."
        }
      ]
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

## Listing created interactions

get https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/interactions Retrieves a list of interactions.
- [Path / Query parameters](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#listInteractions.PATH_PARAMETERS)
- [Response](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#listInteractions.response)

### Path / Query Parameters

page_size integer (optional) The maximum number of interactions to return (per page).

*If unspecified, defaults to 10. The maximum allowed value is 500.*
page_token string (optional) A page token, received from a previous `ListInteractions` call.

### Response

Returns a response containing a list of [InteractionMetadata](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:InteractionMetadata) resources and a `next_page_token`.

### List Interactions

```
curl -X GET \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://aiplatform.googleapis.com/v1/projects/$PROJECT_ID/locations/global/interactions?page_size=10&page_token=page-token-67890"
```

### Response

```
{
  "interaction_metadatas": [
    {
      "id": "interaction-12345"
    }
  ],
  "next_page_token": "page-token-67890"
}
```

## Retrieving an interaction

get https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/interactions/{id} Retrieves the full details of a single interaction based on its \`Interaction.id\`.
- [Path / Query parameters](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#getInteractionById.PATH_PARAMETERS)
- [Response](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#getInteractionById.response)

### Path / Query Parameters

id string (required) The unique identifier of the interaction to retrieve.
stream boolean (optional) If set to true, the generated content will be streamed incrementally.

*Defaults to: `False`*
last_event_id string (optional) Optional. If set, resumes the interaction stream from the next chunk after the event marked by the event id. Can only be used if \`stream\` is true.

### Response

Returns an [Interaction](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Interaction) resource or a stream of server-sent events of [InteractionSseEvent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:InteractionSseEvent) resource.

### Get Interaction

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_1031fc0ec7d917d376c19c14e2653422f2e567fa23ed1c98738eb915b860039d.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

#### Example Response

```
event: interaction.created
data: {
  "interaction": {
    "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
    "status": "in_progress",
    "object": "interaction"
  },
  "event_type": "interaction.created"
}

event: interaction.status_update
data: {
  "interaction_id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
  "status": "in_progress",
  "event_type": "interaction.status_update"
}

event: step.start
data: {
  "index": 0,
  "step": {
    "type": "model_output"
  },
  "event_type": "step.start"
}

event: step.delta
data: {
  "index": 0,
  "delta": {
    "text": "Hello! How can I help you today? If you have a question or need research on a specific topic, just let me know!",
    "type": "text"
  },
  "event_type": "step.delta"
}

event: step.stop
data: {
  "index": 0,
  "event_type": "step.stop"
}

event: interaction.completed
data: {
  "interaction": {
    "id": "v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg",
    "status": "completed",
    "usage": {
      "total_tokens": 790,
      "total_input_tokens": 533,
      "input_tokens_by_modality": [
        {
          "modality": "text",
          "tokens": 533
        }
      ],
      "total_output_tokens": 27,
      "output_tokens_by_modality": [
        {
          "modality": "text",
          "tokens": 27
        }
      ],
      "total_thought_tokens": 230
    },
    "created": "2026-05-10T22:14:16Z",
    "updated": "2026-05-10T22:14:16Z",
    "object": "interaction"
  },
  "event_type": "interaction.completed"
}

event: done
data: [DONE]
```

## Canceling an interaction

post https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/interactions/{id}/cancel Cancels an interaction by ID. This only applies to background interactions that are still in progress. Users will still be charged for partially generated tokens for cancelled interactions.
- [Path / Query parameters](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#cancelInteractionById.PATH_PARAMETERS)
- [Response](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#cancelInteractionById.response)

### Path / Query Parameters

id string (required) The unique identifier of the interaction to cancel.

### Response

Returns an [Interaction](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Interaction) resource.

### Cancel Interaction

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_4fc81bcd761c4228c44463cb993ba7605c51381f2e2ffc141a73432a330bdf7d.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

#### Example Response

```json
{
  "id": "v1_ChdXS0l4YWZXTk9xbk0xZThQczhEcmlROBIXV0tJeGFmV05PcW5NMWU4UHM4RHJpUTg",
  "status": "cancelled",
  "created": "2026-08-17T18:00:00Z",
  "updated": "2026-08-17T18:00:02Z",
  "object": "interaction",
  "model": "gemini-3.8-flash"
}
```

## Deleting an interaction

delete https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/interactions/{id} Deletes an interaction.
- [Path parameters](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#deleteInteraction.PATH_PARAMETERS)
- [Response](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#deleteInteraction.response)

### Path Parameters

id string (required) The unique identifier of the interaction to delete.

### Response

Returns an empty response on success.

### Delete Interaction

```bash
curl -X DELETE \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://aiplatform.googleapis.com/v1/projects/$PROJECT_ID/locations/global/interactions/v1_ChdPU0F4YWFtNkFwS2kxZThQZ05lbXdROBIXT1NBeGFhbTZBcEtpMWU4UGdOZW13UTg"
```

## Resources

### InteractionMetadata

The metadata for an interaction. Note: Only the id field is currently supported; other fields are not yet supported.

#### Fields

id string (optional) The unique identifier of the interaction.

### Interaction

The Interaction resource.

#### Fields

model ModelOption (optional) The name of the \`Model\` used for generating the interaction.

Possible
values:

- `gemini-4-hydrogen`

  Google's near-frontier model built for
  speed and efficiency across everyday coding and agentic workflows, multimodal
  analysis, and tool use.
- `gemini-4-carbon`

  Google's frontier model that excels
  at deep work in complex, real-world tasks across domains including coding,
  finance, legal, cybersecurity, and science.
- `gemini-4-carbon-cyber-permissive`

  Cybersecurity variant of
  `gemini-4-carbon` for defensive cybersecurity workflows (available
  behind the Fairwind Program allowlist).
- `gemini-4-argon`

  Google's frontier model that excels
  at deep work in complex, real-world tasks across domains including coding,
  finance, legal, cybersecurity, and science.
- `gemini-4-argon-cyber-permissive`

  Cybersecurity variant of
  `gemini-4-argon` for defensive cybersecurity workflows (available
  behind the Fairwind Program allowlist).
- `gemini-3.8-flash`

  Our fast, high-performance
  multimodal model optimized for coding, reasoning, multimodal understanding,
  and agentic workflows.
- `gemini-3.7-flash`

  Our fast, high-performance
  multimodal model optimized for coding, reasoning, and agentic workflows.
  Default model for Interactions API.
- `gemini-3.6-flash`

  Fast, high-performance multimodal
  model optimized for reasoning, multimodal understanding, and
  agentic workflows.
- `gemini-3.5-flash-lite`

  Lightweight, highly cost-efficient
  multimodal model optimized for high throughput and low-latency agentic tasks.
- `gemini-3.1-pro-preview`

  Our most capable multimodal model
  for complex reasoning, coding, and multi-step agentic tasks.
- `gemini-3.1-flash-lite`

  Highly cost-efficient, low-latency
  model for high-frequency requests.
- `gemini-omni-1.2-flash`

  Our generally available multimodal
  model designed for video, image, and text tasks, optimized for video generation
  and editing up to 15 seconds, video extension, and standalone video upscaling
  alongside text responses.
- `gemini-omni-1.1-flash-preview`

  Our updated multimodal model
  designed for video, image, and text tasks, optimized for video generation
  alongside text responses.
- `gemini-omni-flash-preview`

  Our high-performance multimodal
  model designed for fast, conversational video generation, editing, and
  cinematic control.
- `lyria-3-clip-preview`

  Our low-latency, music generation
  model optimized for high-fidelity audio clips and precise rhythmic control.
  Available in stateless interactions only (`store=false`).
- `lyria-3-pro-preview`

  Our advanced, full-song generative
  model with deep compositional understanding, optimized for precise structural
  control and complex transitions across diverse musical styles. Available in
  stateless interactions only (`store=false`).

The model that will complete your prompt.\\n\\nSee \[models\](https://ai.google.dev/gemini-api/docs/models) for additional details.
agent AgentOption (optional) The name of the \`Agent\` used for generating the interaction.

Possible
values:

- `antigravity-preview-05-2026`

  Our general-purpose autonomous agent
  designed for multi-step reasoning, coding, file operations, and tool use.
- `deep-research-preview-04-2026`

  Gemini Deep Research Agent designed
  for autonomous, multi-step web research and synthesis.

The agent to interact with.
id string (optional) Required. Output only. A unique identifier for the interaction completion.
errors array (Error) (optional) Output only. Diagnostic faults / platform errors recorded on the interaction.
Error message from an interaction.

#### Fields

code string (optional) A URI that identifies the error type.
message string (optional) A human-readable error message.
status enum (string) (optional) Required. Output only. The status of the interaction.

Possible
values:

- `in_progress`
- `requires_action`
- `completed`
- `failed`
- `cancelled`
- `incomplete`
created string (optional) Required. Output only. The time at which the response was created in ISO 8601 format
(YYYY-MM-DDThh:mm:ssZ).
updated string (optional) Required. Output only. The time at which the response was last updated in ISO 8601 format
(YYYY-MM-DDThh:mm:ssZ).
system_instruction string (optional) System instruction for the interaction.
tools array ([Tool](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Tool)) (optional) A list of tool declarations the model may call during interaction.
usage Usage (optional) Output only. Statistics on the interaction request's token usage.
Statistics on the interaction request's token usage.

#### Fields

total_input_tokens integer (optional) Number of tokens in the prompt (context).
input_tokens_by_modality ModalityTokens (optional) A breakdown of input token usage by modality.
The token count for a single response modality.

#### Fields

modality ResponseModality (optional) The modality associated with the token count.

Possible
values:

- `text`
- `image`
- `audio`
- `video`
- `document`

<br />

tokens integer (optional) Number of tokens for the modality.
total_cached_tokens integer (optional) Number of tokens in the cached part of the prompt (the cached content).
cached_tokens_by_modality ModalityTokens (optional) A breakdown of cached token usage by modality.
The token count for a single response modality.

#### Fields

modality ResponseModality (optional) The modality associated with the token count.

Possible
values:

- `text`
- `image`
- `audio`
- `video`
- `document`

<br />

tokens integer (optional) Number of tokens for the modality.
total_output_tokens integer (optional) Total number of tokens across all the generated responses.
output_tokens_by_modality ModalityTokens (optional) A breakdown of output token usage by modality.
The token count for a single response modality.

#### Fields

modality ResponseModality (optional) The modality associated with the token count.

Possible
values:

- `text`
- `image`
- `audio`
- `video`
- `document`

<br />

tokens integer (optional) Number of tokens for the modality.
total_tool_use_tokens integer (optional) Number of tokens present in tool-use prompt(s).
tool_use_tokens_by_modality ModalityTokens (optional) A breakdown of tool-use token usage by modality.
The token count for a single response modality.

#### Fields

modality ResponseModality (optional) The modality associated with the token count.

Possible
values:

- `text`
- `image`
- `audio`
- `video`
- `document`

<br />

tokens integer (optional) Number of tokens for the modality.
total_thought_tokens integer (optional) Number of tokens of thoughts for thinking models.
total_tokens integer (optional) Total token count for the interaction request (prompt + responses + other
internal tokens).
grounding_tool_count GroundingToolCount (optional) Grounding tool count.
The number of grounding tool counts.

#### Fields

type enum (string) (optional) The grounding tool type associated with the count.

Possible
values:

- `google_search`
- `google_maps`
- `retrieval`
count integer (optional) The number of grounding tool counts.
response_modalities ResponseModality (optional) The requested modalities of the response (TEXT, IMAGE, AUDIO).

Possible
values:

- `text`
- `image`
- `audio`
- `video`
- `document`

<br />

previous_interaction_id string (optional) The ID of the previous interaction, if any.
steps array ([Step](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Step)) (optional) Output only. The steps that make up the interaction.
A step in the interaction.

#### Possible Types

Polymorphic discriminator: `type`
UserInputStep Input provided by the user.
type object (required) No description provided.

Always set to `"user_input"`.
content array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) (optional) No description provided.
ModelOutputStep Output generated by the model.
type object (required) No description provided.

Always set to `"model_output"`.
content array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) (optional) No description provided.
ThoughtStep A thought step.
type object (required) No description provided.

Always set to `"thought"`.
signature string (optional) A signature hash for backend validation.
summary ThoughtSummaryContent (optional) A summary of the thought.
<br />

#### Possible Types

Polymorphic discriminator: `type`
TextContent A text content block.
type object (required) No description provided.

Always set to `"text"`.
text string (required) Required. The text content.
annotations Annotation (optional) Citation information for model-generated content.
Citation information for model-generated content.

#### Possible Types

Polymorphic discriminator: `type`
UrlCitation A URL citation annotation.
type object (required) No description provided.

Always set to `"url_citation"`.
url string (optional) The URL.
title string (optional) The title of the URL.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
FileCitation A file citation annotation.
type object (required) No description provided.

Always set to `"file_citation"`.
document_uri string (optional) The URI of the file.
file_name string (optional) The name of the file.
source string (optional) Source attributed for a portion of the text.
custom_metadata object (optional) User provided metadata about the retrieved context.
page_number integer (optional) Page number of the cited document, if applicable.
media_id string (optional) Media ID in-case of image citations, if applicable.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
PlaceCitation A place citation annotation.
type object (required) No description provided.

Always set to `"place_citation"`.
place_id string (optional) The ID of the place, in \`places/{place_id}\` format.
name string (optional) Title of the place.
url string (optional) URI reference of the place.
review_snippets ReviewSnippet (optional) Snippets of reviews that are used to generate answers about the
features of a given place in Google Maps.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
ImageContent An image content block.
type object (required) No description provided.

Always set to `"image"`.
data string (optional) The image content.
uri string (optional) The URI of the image.
mime_type enum (string) (optional) The mime type of the image.

Possible
values:

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/heic`
- `image/heif`
- `image/gif`
- `image/bmp`
- `image/tiff`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

FunctionCallStep A function tool call step.
type object (required) No description provided.

Always set to `"function_call"`.
name string (required) Required. The name of the tool to call.
arguments object (required) Required. The arguments to pass to the function.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
CodeExecutionCallStep Code execution call step.
type object (required) No description provided.

Always set to `"code_execution_call"`.
arguments CodeExecutionCallStepArguments (required) Required. The arguments to pass to the code execution.
The arguments to pass to the code execution.

#### Fields

language enum (string) (optional) Programming language of the \`code\`.

Possible
values:

- `python`
code string (optional) The code to be executed.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
UrlContextCallStep URL context call step.
type object (required) No description provided.

Always set to `"url_context_call"`.
arguments UrlContextCallStepArguments (required) Required. The arguments to pass to the URL context.
The arguments to pass to the URL context.

#### Fields

urls array (string) (optional) The URLs to fetch.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
McpServerToolCallStep MCPServer tool call step.
type object (required) No description provided.

Always set to `"mcp_server_tool_call"`.
name string (required) Required. The name of the tool which was called.
server_name string (required) Required. The name of the used MCP server.
arguments object (required) Required. The JSON object of arguments for the function.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
GoogleSearchCallStep Google Search call step.
type object (required) No description provided.

Always set to `"google_search_call"`.
arguments GoogleSearchCallStepArguments (required) Required. The arguments to pass to Google Search.
The arguments to pass to Google Search.

#### Fields

queries array (string) (optional) Web search queries for the following-up web search.
search_type enum (string) (optional) The type of search grounding enabled.

Possible
values:

- `web_search`
- `image_search`
- `enterprise_web_search`
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
FileSearchCallStep File Search call step.
type object (required) No description provided.

Always set to `"file_search_call"`.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
GoogleMapsCallStep Google Maps call step.
type object (required) No description provided.

Always set to `"google_maps_call"`.
arguments GoogleMapsCallStepArguments (optional) The arguments to pass to the Google Maps tool.
The arguments to pass to the Google Maps tool.

#### Fields

queries array (string) (optional) The queries to be executed.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
FunctionResultStep Result of a function tool call.
type object (required) No description provided.

Always set to `"function_result"`.
name string (optional) The name of the tool that was called.
is_error boolean (optional) Whether the tool call resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
result array ([FunctionResultSubcontent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:FunctionResultSubcontent)) or string (required) The result of the tool call.
CodeExecutionResultStep Code execution result step.
type object (required) No description provided.

Always set to `"code_execution_result"`.
result string (required) Required. The output of the code execution.
is_error boolean (optional) Whether the code execution resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
UrlContextResultStep URL context result step.
type object (required) No description provided.

Always set to `"url_context_result"`.
result UrlContextResultItem (required) Required. The results of the URL context.
The result of the URL context.

#### Fields

url string (optional) The URL that was fetched.
status enum (string) (optional) The status of the URL retrieval.

Possible
values:

- `success`
- `error`
- `paywall`
- `unsafe`
is_error boolean (optional) Whether the URL context resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
GoogleSearchResultStep Google Search result step.
type object (required) No description provided.

Always set to `"google_search_result"`.
result GoogleSearchResultItem (required) Required. The results of the Google Search.
The result of the Google Search.

#### Fields

search_suggestions string (optional) Web content snippet that can be embedded in a web page or an app webview.
is_error boolean (optional) Whether the Google Search resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
McpServerToolResultStep MCPServer tool result step.
type object (required) No description provided.

Always set to `"mcp_server_tool_result"`.
name string (optional) Name of the tool which is called for this specific tool call.
server_name string (optional) The name of the used MCP server.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
result array ([FunctionResultSubcontent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:FunctionResultSubcontent)) or string (required) The output from the MCP server call. Can be simple text or rich content.
FileSearchResultStep File Search result step.
type object (required) No description provided.

Always set to `"file_search_result"`.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
GoogleMapsResultStep Google Maps result step.
type object (required) No description provided.

Always set to `"google_maps_result"`.
result GoogleMapsResultItem (required) No description provided.
The result of the Google Maps.

#### Fields

places GoogleMapsResultPlaces (optional) No description provided.
<br />

#### Fields

place_id string (optional) No description provided.
name string (optional) No description provided.
url string (optional) No description provided.
review_snippets ReviewSnippet (optional) No description provided.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
widget_context_token string (optional) No description provided.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
input [Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content) or array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) or array ([Step](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Step)) or string (optional) The input for the interaction.
response_format [ResponseFormat](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:ResponseFormat) or array ([ResponseFormat](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:ResponseFormat)) (optional) Enforces that the generated response is a JSON object that complies with the JSON schema specified in this field.
agent_config object (optional) Configuration parameters for the agent interaction.

#### Possible Types

Polymorphic discriminator: `type`
DynamicAgentConfig Configuration for dynamic agents.
type object (required) No description provided.

Always set to `"dynamic"`.

### Examples

### Example

```bash
{
  "created": "2025-12-04T15:01:45Z",
  "id": "v1_ChdXS0l4YWZXTk9xbk0xZThQczhEcmlROBIXV0tJeGFmV05PcW5NMWU4UHM4RHJpUTg",
  "agent": "deep-research-preview-04-2026",
  "object": "interaction",
  "steps": [
    {
      "type": "model_output",
      "content": [
        {
          "type": "text",
          "text": "Hello! I'm doing well, functioning as expected. Thank you for asking! How are you doing today?"
        }
      ]
    }
  ],
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

### Possible Types

Polymorphic discriminator: `type`
TextContent A text content block.
type object (required) No description provided.

Always set to `"text"`.
text string (required) Required. The text content.
annotations Annotation (optional) Citation information for model-generated content.
Citation information for model-generated content.

#### Possible Types

Polymorphic discriminator: `type`
UrlCitation A URL citation annotation.
type object (required) No description provided.

Always set to `"url_citation"`.
url string (optional) The URL.
title string (optional) The title of the URL.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
FileCitation A file citation annotation.
type object (required) No description provided.

Always set to `"file_citation"`.
document_uri string (optional) The URI of the file.
file_name string (optional) The name of the file.
source string (optional) Source attributed for a portion of the text.
custom_metadata object (optional) User provided metadata about the retrieved context.
page_number integer (optional) Page number of the cited document, if applicable.
media_id string (optional) Media ID in-case of image citations, if applicable.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
PlaceCitation A place citation annotation.
type object (required) No description provided.

Always set to `"place_citation"`.
place_id string (optional) The ID of the place, in \`places/{place_id}\` format.
name string (optional) Title of the place.
url string (optional) URI reference of the place.
review_snippets ReviewSnippet (optional) Snippets of reviews that are used to generate answers about the
features of a given place in Google Maps.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
ImageContent An image content block.
type object (required) No description provided.

Always set to `"image"`.
data string (optional) The image content.
uri string (optional) The URI of the image.
mime_type enum (string) (optional) The mime type of the image.

Possible
values:

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/heic`
- `image/heif`
- `image/gif`
- `image/bmp`
- `image/tiff`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

AudioContent An audio content block.
type object (required) No description provided.

Always set to `"audio"`.
data string (optional) The audio content.
uri string (optional) The URI of the audio.
mime_type enum (string) (optional) The mime type of the audio.

Possible
values:

- `audio/wav`
- `audio/mp3`
- `audio/aiff`
- `audio/aac`
- `audio/ogg`
- `audio/flac`
- `audio/mpeg`
- `audio/m4a`
- `audio/l16`
- `audio/opus`
- `audio/alaw`
- `audio/mulaw`
channels integer (optional) The number of audio channels.
sample_rate integer (optional) The sample rate of the audio.
DocumentContent A document content block.
type object (required) No description provided.

Always set to `"document"`.
data string (optional) The document content.
uri string (optional) The URI of the document.
mime_type enum (string) (optional) The mime type of the document.

Possible
values:

- `application/pdf`
VideoContent A video content block.
type object (required) No description provided.

Always set to `"video"`.
data string (optional) The video content.
uri string (optional) The URI of the video.
mime_type enum (string) (optional) The mime type of the video.

Possible
values:

- `video/mp4`
- `video/mpeg`
- `video/mpg`
- `video/mov`
- `video/avi`
- `video/x-flv`
- `video/webm`
- `video/wmv`
- `video/3gpp`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

### Examples

### Text

```json
{
  "type": "text",
  "text": "Hello, how are you?"
}
```

### Image

```json
{
  "type": "image",
  "data": "BASE64_ENCODED_IMAGE",
  "mime_type": "image/png"
}
```

### Audio

```json
{
  "type": "audio",
  "data": "BASE64_ENCODED_AUDIO",
  "mime_type": "audio/wav"
}
```

### Document

```json
{
  "type": "document",
  "data": "BASE64_ENCODED_DOCUMENT",
  "mime_type": "application/pdf"
}
```

### Video

```json
{
  "type": "video",
  "uri": "https://www.youtube.com/watch?v=9hE5-98ZeCg"
}
```

### Step

A step in the interaction.

### Possible Types

Polymorphic discriminator: `type`
UserInputStep Input provided by the user.
type object (required) No description provided.

Always set to `"user_input"`.
content array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) (optional) No description provided.
ModelOutputStep Output generated by the model.
type object (required) No description provided.

Always set to `"model_output"`.
content array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) (optional) No description provided.
ThoughtStep A thought step.
type object (required) No description provided.

Always set to `"thought"`.
signature string (optional) A signature hash for backend validation.
summary ThoughtSummaryContent (optional) A summary of the thought.
<br />

#### Possible Types

Polymorphic discriminator: `type`
TextContent A text content block.
type object (required) No description provided.

Always set to `"text"`.
text string (required) Required. The text content.
annotations Annotation (optional) Citation information for model-generated content.
Citation information for model-generated content.

#### Possible Types

Polymorphic discriminator: `type`
UrlCitation A URL citation annotation.
type object (required) No description provided.

Always set to `"url_citation"`.
url string (optional) The URL.
title string (optional) The title of the URL.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
FileCitation A file citation annotation.
type object (required) No description provided.

Always set to `"file_citation"`.
document_uri string (optional) The URI of the file.
file_name string (optional) The name of the file.
source string (optional) Source attributed for a portion of the text.
custom_metadata object (optional) User provided metadata about the retrieved context.
page_number integer (optional) Page number of the cited document, if applicable.
media_id string (optional) Media ID in-case of image citations, if applicable.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
PlaceCitation A place citation annotation.
type object (required) No description provided.

Always set to `"place_citation"`.
place_id string (optional) The ID of the place, in \`places/{place_id}\` format.
name string (optional) Title of the place.
url string (optional) URI reference of the place.
review_snippets ReviewSnippet (optional) Snippets of reviews that are used to generate answers about the
features of a given place in Google Maps.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
ImageContent An image content block.
type object (required) No description provided.

Always set to `"image"`.
data string (optional) The image content.
uri string (optional) The URI of the image.
mime_type enum (string) (optional) The mime type of the image.

Possible
values:

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/heic`
- `image/heif`
- `image/gif`
- `image/bmp`
- `image/tiff`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

FunctionCallStep A function tool call step.
type object (required) No description provided.

Always set to `"function_call"`.
name string (required) Required. The name of the tool to call.
arguments object (required) Required. The arguments to pass to the function.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
CodeExecutionCallStep Code execution call step.
type object (required) No description provided.

Always set to `"code_execution_call"`.
arguments CodeExecutionCallStepArguments (required) Required. The arguments to pass to the code execution.
The arguments to pass to the code execution.

#### Fields

language enum (string) (optional) Programming language of the \`code\`.

Possible
values:

- `python`
code string (optional) The code to be executed.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
UrlContextCallStep URL context call step.
type object (required) No description provided.

Always set to `"url_context_call"`.
arguments UrlContextCallStepArguments (required) Required. The arguments to pass to the URL context.
The arguments to pass to the URL context.

#### Fields

urls array (string) (optional) The URLs to fetch.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
McpServerToolCallStep MCPServer tool call step.
type object (required) No description provided.

Always set to `"mcp_server_tool_call"`.
name string (required) Required. The name of the tool which was called.
server_name string (required) Required. The name of the used MCP server.
arguments object (required) Required. The JSON object of arguments for the function.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
GoogleSearchCallStep Google Search call step.
type object (required) No description provided.

Always set to `"google_search_call"`.
arguments GoogleSearchCallStepArguments (required) Required. The arguments to pass to Google Search.
The arguments to pass to Google Search.

#### Fields

queries array (string) (optional) Web search queries for the following-up web search.
search_type enum (string) (optional) The type of search grounding enabled.

Possible
values:

- `web_search`
- `image_search`
- `enterprise_web_search`
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
FileSearchCallStep File Search call step.
type object (required) No description provided.

Always set to `"file_search_call"`.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
GoogleMapsCallStep Google Maps call step.
type object (required) No description provided.

Always set to `"google_maps_call"`.
arguments GoogleMapsCallStepArguments (optional) The arguments to pass to the Google Maps tool.
The arguments to pass to the Google Maps tool.

#### Fields

queries array (string) (optional) The queries to be executed.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
FunctionResultStep Result of a function tool call.
type object (required) No description provided.

Always set to `"function_result"`.
name string (optional) The name of the tool that was called.
is_error boolean (optional) Whether the tool call resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
result array ([FunctionResultSubcontent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:FunctionResultSubcontent)) or string (required) The result of the tool call.
CodeExecutionResultStep Code execution result step.
type object (required) No description provided.

Always set to `"code_execution_result"`.
result string (required) Required. The output of the code execution.
is_error boolean (optional) Whether the code execution resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
UrlContextResultStep URL context result step.
type object (required) No description provided.

Always set to `"url_context_result"`.
result UrlContextResultItem (required) Required. The results of the URL context.
The result of the URL context.

#### Fields

url string (optional) The URL that was fetched.
status enum (string) (optional) The status of the URL retrieval.

Possible
values:

- `success`
- `error`
- `paywall`
- `unsafe`
is_error boolean (optional) Whether the URL context resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
GoogleSearchResultStep Google Search result step.
type object (required) No description provided.

Always set to `"google_search_result"`.
result GoogleSearchResultItem (required) Required. The results of the Google Search.
The result of the Google Search.

#### Fields

search_suggestions string (optional) Web content snippet that can be embedded in a web page or an app webview.
is_error boolean (optional) Whether the Google Search resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
McpServerToolResultStep MCPServer tool result step.
type object (required) No description provided.

Always set to `"mcp_server_tool_result"`.
name string (optional) Name of the tool which is called for this specific tool call.
server_name string (optional) The name of the used MCP server.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
result array ([FunctionResultSubcontent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:FunctionResultSubcontent)) or string (required) The output from the MCP server call. Can be simple text or rich content.
FileSearchResultStep File Search result step.
type object (required) No description provided.

Always set to `"file_search_result"`.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
GoogleMapsResultStep Google Maps result step.
type object (required) No description provided.

Always set to `"google_maps_result"`.
result GoogleMapsResultItem (required) No description provided.
The result of the Google Maps.

#### Fields

places GoogleMapsResultPlaces (optional) No description provided.
<br />

#### Fields

place_id string (optional) No description provided.
name string (optional) No description provided.
url string (optional) No description provided.
review_snippets ReviewSnippet (optional) No description provided.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
widget_context_token string (optional) No description provided.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.

### Examples

### UserInputStep

```json
{
  "type": "user_input",
  "content": [
    {
      "type": "text",
      "text": "What is the capital of France?"
    }
  ]
}
```

### ModelOutputStep

```json
{
  "type": "model_output",
  "content": [
    {
      "type": "text",
      "text": "The capital of France is Paris."
    }
  ]
}
```

### ThoughtStep

```json
{
  "type": "thought",
  "signature": "thought_sig_abcd1234",
  "summary": [
    {
      "type": "text",
      "text": "The model is searching Google for the capital of France."
    }
  ]
}
```

### FunctionCallStep

```json
{
  "name": "get_weather",
  "type": "function_call",
  "arguments": {
    "location": "Boston, MA"
  },
  "id": "call_98231"
}
```

### CodeExecutionCallStep

```json
{
  "type": "code_execution_call",
  "arguments": {
    "code": "print(sum(range(1, 11)))"
  },
  "id": "code_call_71021"
}
```

### UrlContextCallStep

```json
{
  "type": "url_context_call",
  "arguments": {
    "urls": [
      "https://www.example.com"
    ]
  },
  "id": "url_call_10219"
}
```

### McpServerToolCallStep

```json
{
  "name": "calculate_tax",
  "type": "mcp_server_tool_call",
  "arguments": {
    "income": 120000,
    "state": "CA"
  },
  "id": "mcp_call_29012",
  "server_name": "financial_mcp_server"
}
```

### GoogleSearchCallStep

```json
{
  "type": "google_search_call",
  "arguments": {
    "queries": [
      "Who won the men's 100m in Paris 2024?"
    ]
  },
  "id": "search_call_19201"
}
```

### FileSearchCallStep

```json
{
  "type": "file_search_call",
  "id": "file_call_88192"
}
```

### GoogleMapsCallStep

```json
{
  "type": "google_maps_call",
  "arguments": {
    "queries": [
      "coffee shops near Golden Gate Park"
    ]
  },
  "id": "maps_call_39201"
}
```

### FunctionResultStep

```json
{
  "name": "get_weather",
  "type": "function_result",
  "call_id": "call_98231",
  "result": [
    {
      "type": "text",
      "text": "{\"weather\":\"sunny\"}"
    }
  ]
}
```

### CodeExecutionResultStep

```json
{
  "type": "code_execution_result",
  "call_id": "code_call_71021",
  "result": "55\n"
}
```

### UrlContextResultStep

```json
{
  "type": "url_context_result",
  "call_id": "url_call_10219",
  "result": [
    {
      "url": "https://www.example.com",
      "status": "success"
    }
  ]
}
```

### GoogleSearchResultStep

```json
{
  "type": "google_search_result",
  "call_id": "search_call_19201",
  "result": [
    {
      "title": "Paris 2024 Olympics: Noah Lyles wins men's 100m gold",
      "url": "https://olympics.com/en/news/paris-2024-noah-lyles-wins-mens-100m-gold"
    }
  ]
}
```

### McpServerToolResultStep

```json
{
  "name": "calculate_tax",
  "server_name": "financial_mcp_server",
  "type": "mcp_server_tool_result",
  "call_id": "mcp_call_29012",
  "result": {
    "tax_due": 32400
  }
}
```

### FileSearchResultStep

```json
{
  "type": "file_search_result",
  "call_id": "file_call_88192",
  "result": [
    {
      "title": "Project Overview",
      "text": "Summary of the document content.",
      "file_search_store": "projects/my-project/locations/global/fileSearchStores/my-store"
    }
  ]
}
```

### GoogleMapsResultStep

```json
{
  "type": "google_maps_result",
  "call_id": "maps_call_39201",
  "result": [
    {
      "places": [
        {
          "name": "Golden Gate Park",
          "place_id": "ChIJIQBpAG2ahYAR9R7bNdTLg8M",
          "url": "https://maps.google.com/?cid=14084699562006944757"
        }
      ]
    }
  ]
}
```

### Tool

A tool that can be used by the model.

### Possible Types

Polymorphic discriminator: `type`
Function A tool that can be used by the model.
type object (required) No description provided.

Always set to `"function"`.
name string (optional) The name of the function.
description string (optional) A description of the function.
parameters object (optional) The JSON Schema for the function's parameters.
CodeExecution A tool that can be used by the model to execute code.
type object (required) No description provided.

Always set to `"code_execution"`.
UrlContext A tool that can be used by the model to fetch URL context.
type object (required) No description provided.

Always set to `"url_context"`.
ComputerUse A tool that can be used by the model to interact with the computer.
type object (required) No description provided.

Always set to `"computer_use"`.
environment enum (string) (optional) The environment being operated.

Possible
values:

- `browser`
excluded_predefined_functions array (string) (optional) The list of predefined functions that are excluded from the model call.
McpServer A MCPServer is a server that can be called by the model to perform actions.
type object (required) No description provided.

Always set to `"mcp_server"`.
name string (optional) The name of the MCPServer.
url string (optional) The full URL for the MCPServer endpoint.
Example: "https://api.example.com/mcp"
headers object (optional) Optional: Fields for authentication headers, timeouts, etc., if needed.
allowed_tools AllowedTools (optional) The allowed tools.
The configuration for allowed tools.

#### Fields

mode ToolChoiceType (optional) The mode of the tool choice.

Possible
values:

- `auto`
- `any`
- `none`
- `validated`

<br />

tools array (string) (optional) The names of the allowed tools.
GoogleSearch A tool that can be used by the model to search Google.
type object (required) No description provided.

Always set to `"google_search"`.
search_types array (enum (string)) (optional) The types of search grounding to enable.

Possible
values:

- `web_search`
- `image_search`
- `enterprise_web_search`
GoogleMaps A tool that can be used by the model to call Google Maps.
type object (required) No description provided.

Always set to `"google_maps"`.
enable_widget boolean (optional) Whether to return a widget context token in the tool call result of the
response.
latitude number (optional) The latitude of the user's location.
longitude number (optional) The longitude of the user's location.
Retrieval A tool that can be used by the model to retrieve files.
type object (required) No description provided.

Always set to `"retrieval"`.
retrieval_types array (enum (string)) (optional) The types of file retrieval to enable.

Possible
values:

- `vertex_ai_search`
vertex_ai_search_config VertexAISearchConfig (optional) Used to specify configuration for VertexAISearch.
Used to specify configuration for VertexAISearch.

#### Fields

engine string (optional) Optional. Used to specify Agent Platform Search engine.
datastores array (string) (optional) Optional. Used to specify Agent Platform Search datastores.

### Examples

### Function

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_28f71b7fd29782b705131c39a62cea5bb731f9416538712d6db5708eb207d7d7.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

### CodeExecution

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_e795d15b07ed7c9174df7822635cef47e872aadb0c71302e75565a7640108c27.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

### UrlContext

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_6fc5140531fb31287e44ce2ad1813a86fca61d7d0a4c544248b726da8ea2d49c.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

### ComputerUse

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_ee1fdd33d738bdd751687788cbf2b588e287debb7cc90d82c8d6543d694ab825.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

### McpServer

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_976056887c9dbec0a9cf86c7eef6677669b3474779c6937f684fa035be29cb8d.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

### GoogleSearch

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_bd28374979a3789fbd9f74eed4e047ebc48e9ee96a3a41783c90f58665fb0de5.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

### GoogleMaps

<iframe src="https:///frame/gemini-enterprise-agent-platform/reference/models/interactions-api_65addf471df8860adc520b23c7d41dbd60224b8e769f0236bbf07a02c397be71.frame" class="framebox inherit-locale " allow="clipboard-write https://" allowfullscreen is-upgraded></iframe>

### Retrieval

No examples available for this type.

### InteractionSseEvent

<br />

### Possible Types

Polymorphic discriminator: `event_type`
InteractionCreatedEvent <br />

event_type object (required) No description provided.

Always set to `"interaction.created"`.
interaction [Interaction](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Interaction) (required) No description provided.
event_id string (optional) The event_id token to be used to resume the interaction stream, from
this event.
InteractionCompletedEvent <br />

event_type object (required) No description provided.

Always set to `"interaction.completed"`.
interaction [Interaction](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Interaction) (required) Required. The completed interaction with empty outputs to reduce the payload size.
Use the preceding ContentDelta events for the actual output.
event_id string (optional) The event_id token to be used to resume the interaction stream, from
this event.
InteractionStatusUpdate <br />

event_type object (required) No description provided.

Always set to `"interaction.status_update"`.
interaction_id string (required) No description provided.
status enum (string) (required) No description provided.

Possible
values:

- `in_progress`
- `requires_action`
- `completed`
- `failed`
- `cancelled`
- `incomplete`
event_id string (optional) The event_id token to be used to resume the interaction stream, from
this event.
ErrorEvent <br />

event_type object (required) No description provided.

Always set to `"error"`.
error Error (optional) No description provided.
Error message from an interaction.

#### Fields

code string (optional) A URI that identifies the error type.
message string (optional) A human-readable error message.
event_id string (optional) The event_id token to be used to resume the interaction stream, from
this event.
StepStart <br />

event_type object (required) No description provided.

Always set to `"step.start"`.
index integer (required) No description provided.
step [Step](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Step) (required) No description provided.
A step in the interaction.

#### Possible Types

Polymorphic discriminator: `type`
UserInputStep Input provided by the user.
type object (required) No description provided.

Always set to `"user_input"`.
content array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) (optional) No description provided.
ModelOutputStep Output generated by the model.
type object (required) No description provided.

Always set to `"model_output"`.
content array ([Content](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:Content)) (optional) No description provided.
ThoughtStep A thought step.
type object (required) No description provided.

Always set to `"thought"`.
signature string (optional) A signature hash for backend validation.
summary ThoughtSummaryContent (optional) A summary of the thought.
<br />

#### Possible Types

Polymorphic discriminator: `type`
TextContent A text content block.
type object (required) No description provided.

Always set to `"text"`.
text string (required) Required. The text content.
annotations Annotation (optional) Citation information for model-generated content.
Citation information for model-generated content.

#### Possible Types

Polymorphic discriminator: `type`
UrlCitation A URL citation annotation.
type object (required) No description provided.

Always set to `"url_citation"`.
url string (optional) The URL.
title string (optional) The title of the URL.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
FileCitation A file citation annotation.
type object (required) No description provided.

Always set to `"file_citation"`.
document_uri string (optional) The URI of the file.
file_name string (optional) The name of the file.
source string (optional) Source attributed for a portion of the text.
custom_metadata object (optional) User provided metadata about the retrieved context.
page_number integer (optional) Page number of the cited document, if applicable.
media_id string (optional) Media ID in-case of image citations, if applicable.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
PlaceCitation A place citation annotation.
type object (required) No description provided.

Always set to `"place_citation"`.
place_id string (optional) The ID of the place, in \`places/{place_id}\` format.
name string (optional) Title of the place.
url string (optional) URI reference of the place.
review_snippets ReviewSnippet (optional) Snippets of reviews that are used to generate answers about the
features of a given place in Google Maps.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
ImageContent An image content block.
type object (required) No description provided.

Always set to `"image"`.
data string (optional) The image content.
uri string (optional) The URI of the image.
mime_type enum (string) (optional) The mime type of the image.

Possible
values:

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/heic`
- `image/heif`
- `image/gif`
- `image/bmp`
- `image/tiff`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

FunctionCallStep A function tool call step.
type object (required) No description provided.

Always set to `"function_call"`.
name string (required) Required. The name of the tool to call.
arguments object (required) Required. The arguments to pass to the function.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
CodeExecutionCallStep Code execution call step.
type object (required) No description provided.

Always set to `"code_execution_call"`.
arguments CodeExecutionCallStepArguments (required) Required. The arguments to pass to the code execution.
The arguments to pass to the code execution.

#### Fields

language enum (string) (optional) Programming language of the \`code\`.

Possible
values:

- `python`
code string (optional) The code to be executed.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
UrlContextCallStep URL context call step.
type object (required) No description provided.

Always set to `"url_context_call"`.
arguments UrlContextCallStepArguments (required) Required. The arguments to pass to the URL context.
The arguments to pass to the URL context.

#### Fields

urls array (string) (optional) The URLs to fetch.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
McpServerToolCallStep MCPServer tool call step.
type object (required) No description provided.

Always set to `"mcp_server_tool_call"`.
name string (required) Required. The name of the tool which was called.
server_name string (required) Required. The name of the used MCP server.
arguments object (required) Required. The JSON object of arguments for the function.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
GoogleSearchCallStep Google Search call step.
type object (required) No description provided.

Always set to `"google_search_call"`.
arguments GoogleSearchCallStepArguments (required) Required. The arguments to pass to Google Search.
The arguments to pass to Google Search.

#### Fields

queries array (string) (optional) Web search queries for the following-up web search.
search_type enum (string) (optional) The type of search grounding enabled.

Possible
values:

- `web_search`
- `image_search`
- `enterprise_web_search`
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
FileSearchCallStep File Search call step.
type object (required) No description provided.

Always set to `"file_search_call"`.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
GoogleMapsCallStep Google Maps call step.
type object (required) No description provided.

Always set to `"google_maps_call"`.
arguments GoogleMapsCallStepArguments (optional) The arguments to pass to the Google Maps tool.
The arguments to pass to the Google Maps tool.

#### Fields

queries array (string) (optional) The queries to be executed.
id string (required) Required. A unique ID for this specific tool call.
signature string (optional) A signature hash for backend validation.
FunctionResultStep Result of a function tool call.
type object (required) No description provided.

Always set to `"function_result"`.
name string (optional) The name of the tool that was called.
is_error boolean (optional) Whether the tool call resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
result array ([FunctionResultSubcontent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:FunctionResultSubcontent)) or string (required) The result of the tool call.
CodeExecutionResultStep Code execution result step.
type object (required) No description provided.

Always set to `"code_execution_result"`.
result string (required) Required. The output of the code execution.
is_error boolean (optional) Whether the code execution resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
UrlContextResultStep URL context result step.
type object (required) No description provided.

Always set to `"url_context_result"`.
result UrlContextResultItem (required) Required. The results of the URL context.
The result of the URL context.

#### Fields

url string (optional) The URL that was fetched.
status enum (string) (optional) The status of the URL retrieval.

Possible
values:

- `success`
- `error`
- `paywall`
- `unsafe`
is_error boolean (optional) Whether the URL context resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
GoogleSearchResultStep Google Search result step.
type object (required) No description provided.

Always set to `"google_search_result"`.
result GoogleSearchResultItem (required) Required. The results of the Google Search.
The result of the Google Search.

#### Fields

search_suggestions string (optional) Web content snippet that can be embedded in a web page or an app webview.
is_error boolean (optional) Whether the Google Search resulted in an error.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
McpServerToolResultStep MCPServer tool result step.
type object (required) No description provided.

Always set to `"mcp_server_tool_result"`.
name string (optional) Name of the tool which is called for this specific tool call.
server_name string (optional) The name of the used MCP server.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
result array ([FunctionResultSubcontent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api.md.txt#Resource:FunctionResultSubcontent)) or string (required) The output from the MCP server call. Can be simple text or rich content.
FileSearchResultStep File Search result step.
type object (required) No description provided.

Always set to `"file_search_result"`.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
GoogleMapsResultStep Google Maps result step.
type object (required) No description provided.

Always set to `"google_maps_result"`.
result GoogleMapsResultItem (required) No description provided.
The result of the Google Maps.

#### Fields

places GoogleMapsResultPlaces (optional) No description provided.
<br />

#### Fields

place_id string (optional) No description provided.
name string (optional) No description provided.
url string (optional) No description provided.
review_snippets ReviewSnippet (optional) No description provided.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
widget_context_token string (optional) No description provided.
call_id string (required) Required. ID to match the ID from the function call block.
signature string (optional) A signature hash for backend validation.
event_id string (optional) The event_id token to be used to resume the interaction stream, from
this event.
StepDelta <br />

event_type object (required) No description provided.

Always set to `"step.delta"`.
index integer (required) No description provided.
delta StepDeltaData (required) No description provided.
<br />

#### Possible Types

Polymorphic discriminator: `type`
TextDelta <br />

type object (required) No description provided.

Always set to `"text"`.
text string (required) No description provided.
ImageDelta <br />

type object (required) No description provided.

Always set to `"image"`.
data string (optional) No description provided.
uri string (optional) No description provided.
mime_type enum (string) (optional) No description provided.

Possible
values:

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/heic`
- `image/heif`
- `image/gif`
- `image/bmp`
- `image/tiff`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

AudioDelta <br />

type object (required) No description provided.

Always set to `"audio"`.
data string (optional) No description provided.
uri string (optional) No description provided.
mime_type enum (string) (optional) No description provided.

Possible
values:

- `audio/wav`
- `audio/mp3`
- `audio/aiff`
- `audio/aac`
- `audio/ogg`
- `audio/flac`
- `audio/mpeg`
- `audio/m4a`
- `audio/l16`
- `audio/opus`
- `audio/alaw`
- `audio/mulaw`
rate integer (optional) Deprecated. Use sample_rate instead. The value is ignored.
sample_rate integer (optional) The sample rate of the audio.
channels integer (optional) The number of audio channels.
DocumentDelta <br />

type object (required) No description provided.

Always set to `"document"`.
data string (optional) No description provided.
uri string (optional) No description provided.
mime_type enum (string) (optional) No description provided.

Possible
values:

- `application/pdf`
VideoDelta <br />

type object (required) No description provided.

Always set to `"video"`.
data string (optional) No description provided.
uri string (optional) No description provided.
mime_type enum (string) (optional) No description provided.

Possible
values:

- `video/mp4`
- `video/mpeg`
- `video/mpg`
- `video/mov`
- `video/avi`
- `video/x-flv`
- `video/webm`
- `video/wmv`
- `video/3gpp`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

ThoughtSummaryDelta <br />

type object (required) No description provided.

Always set to `"thought_summary"`.
content ThoughtSummaryContent (optional) A new summary item to be added to the thought.
<br />

#### Possible Types

Polymorphic discriminator: `type`
TextContent A text content block.
type object (required) No description provided.

Always set to `"text"`.
text string (required) Required. The text content.
annotations Annotation (optional) Citation information for model-generated content.
Citation information for model-generated content.

#### Possible Types

Polymorphic discriminator: `type`
UrlCitation A URL citation annotation.
type object (required) No description provided.

Always set to `"url_citation"`.
url string (optional) The URL.
title string (optional) The title of the URL.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
FileCitation A file citation annotation.
type object (required) No description provided.

Always set to `"file_citation"`.
document_uri string (optional) The URI of the file.
file_name string (optional) The name of the file.
source string (optional) Source attributed for a portion of the text.
custom_metadata object (optional) User provided metadata about the retrieved context.
page_number integer (optional) Page number of the cited document, if applicable.
media_id string (optional) Media ID in-case of image citations, if applicable.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
PlaceCitation A place citation annotation.
type object (required) No description provided.

Always set to `"place_citation"`.
place_id string (optional) The ID of the place, in \`places/{place_id}\` format.
name string (optional) Title of the place.
url string (optional) URI reference of the place.
review_snippets ReviewSnippet (optional) Snippets of reviews that are used to generate answers about the
features of a given place in Google Maps.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
ImageContent An image content block.
type object (required) No description provided.

Always set to `"image"`.
data string (optional) The image content.
uri string (optional) The URI of the image.
mime_type enum (string) (optional) The mime type of the image.

Possible
values:

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/heic`
- `image/heif`
- `image/gif`
- `image/bmp`
- `image/tiff`
resolution MediaResolution (optional) The resolution of the media.

Possible
values:

- `low`
- `medium`
- `high`
- `ultra_high`

<br />

ThoughtSignatureDelta <br />

type object (required) No description provided.

Always set to `"thought_signature"`.
signature string (optional) Signature to match the backend source to be part of the generation.
TextAnnotationDelta <br />

type object (required) No description provided.

Always set to `"text_annotation_delta"`.
annotations Annotation (optional) Citation information for model-generated content.
Citation information for model-generated content.

#### Possible Types

Polymorphic discriminator: `type`
UrlCitation A URL citation annotation.
type object (required) No description provided.

Always set to `"url_citation"`.
url string (optional) The URL.
title string (optional) The title of the URL.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
FileCitation A file citation annotation.
type object (required) No description provided.

Always set to `"file_citation"`.
document_uri string (optional) The URI of the file.
file_name string (optional) The name of the file.
source string (optional) Source attributed for a portion of the text.
custom_metadata object (optional) User provided metadata about the retrieved context.
page_number integer (optional) Page number of the cited document, if applicable.
media_id string (optional) Media ID in-case of image citations, if applicable.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
PlaceCitation A place citation annotation.
type object (required) No description provided.

Always set to `"place_citation"`.
place_id string (optional) The ID of the place, in \`places/{place_id}\` format.
name string (optional) Title of the place.
url string (optional) URI reference of the place.
review_snippets ReviewSnippet (optional) Snippets of reviews that are used to generate answers about the
features of a given place in Google Maps.
Encapsulates a snippet of a user review that answers a question about
the features of a specific place in Google Maps.

#### Fields

title string (optional) Title of the review.
url string (optional) A link that corresponds to the user review on Google Maps.
review_id string (optional) The ID of the review snippet.
start_index integer (optional) Start of segment of the response that is attributed to this source.

Index indicates the start of the segment, measured in bytes.
end_index integer (optional) End of the attributed segment, exclusive.
ArgumentsDelta <br />

type object (required) No description provided.

Always set to `"arguments_delta"`.
partial_arguments string (optional) No description provided.
event_id string (optional) The event_id token to be used to resume the interaction stream, from
this event.
StepStop <br />

event_type object (required) No description provided.

Always set to `"step.stop"`.
index integer (required) No description provided.
event_id string (optional) The event_id token to be used to resume the interaction stream, from
this event.

### Examples

### Interaction Created

```json
{
  "event_type": "interaction.created",
  "interaction": {
    "id": "v1_ChdXS0l4YWZXTk9xbk0xZThQczhEcmlROBIXV0tJeGFmV05PcW5NMWU4UHM4RHJpUTg",
    "agent": "deep-research-preview-04-2026",
    "status": "in_progress",
    "created": "2025-12-04T15:01:45Z",
    "updated": "2025-12-04T15:01:45Z"
  },
  "event_id": "evt_123"
}
```

### Interaction Completed

```json
{
  "event_type": "interaction.completed",
  "interaction": {
    "id": "v1_ChdXS0l4YWZXTk9xbk0xZThQczhEcmlROBIXV0tJeGFmV05PcW5NMWU4UHM4RHJpUTg",
    "agent": "deep-research-preview-04-2026",
    "status": "completed",
    "created": "2025-12-04T15:01:45Z",
    "updated": "2025-12-04T15:01:45Z"
  },
  "event_id": "evt_123"
}
```

### Interaction Status Update

```json
{
  "event_type": "interaction.status_update",
  "interaction_id": "v1_ChdTMjQ0YWJ5TUF1TzcxZThQdjRpcnFRcxIXUzI0NGFieU1BdU83MWU4UHY0aXJxUXM",
  "status": "in_progress"
}
```

### Error Event

```json
{
  "event_type": "error",
  "error": {
    "message": "Failed to get completed interaction: Result not found.",
    "code": "not_found"
  }
}
```

### Step Start

```json
{
  "event_type": "step.start",
  "index": 0,
  "step": {
    "type": "model_output"
  }
}
```

### Step Delta

```json
{
  "event_type": "step.delta",
  "index": 0,
  "delta": {
    "type": "text",
    "text": "Hello"
  }
}
```

### Step Stop

```json
{
  "event_type": "step.stop",
  "index": 0
}
```

### ResponseFormat

<br />

### Possible Types

VideoResponseFormat Configuration for video output format.
aspect_ratio enum (string) (optional) The aspect ratio for the video output.

Possible
values:

- `16:9`

  16:9 aspect ratio.
- `9:16`

  9:16 aspect ratio.
delivery enum (string) (optional) The delivery mode for the video output.

Possible
values:

- `inline`

  Video data is returned inline in the response.
- `uri`

  Video data is returned as a URI.
duration string (optional) The duration for the video output.
gcs_uri string (optional) The Cloud Storage URI to store the video output. Required for Vertex if
delivery mode is URI.
resolution enum (string) (optional) The video output resolution. Defaults to 720p.

Possible
values:

- `360p`

  360p resolution.
- `720p`

  720p resolution.
- `1080p`

  1080p resolution.
- `4k`

  4K resolution.
type object (required) No description provided.

Always set to `"video"`.

### Examples

### Video Output

```json
{
  "type": "video",
  "aspect_ratio": "16:9",
  "delivery": "inline",
  "duration": "8s"
}
```
