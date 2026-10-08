# Skills API

## Overview

The Skills API allows you to create and manage custom agent skills. This is a beta feature that enables building reusable capabilities for Claude agents.

**Endpoint:** `POST /v1/skills`

## Create Skill

### Request

**Method:** `POST /v1/skills`

**Headers:**
- `anthropic-version: 2023-06-01`
- `x-api-key: your-api-key`
- `anthropic-beta: skills-2025-10-02` (required for beta access)

**Body:** Skill creation parameters (structured data)

### Example Request

**cURL:**
```bash
curl https://api.anthropic.com/v1/skills \
  -X POST \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: skills-2025-10-02' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "display_title": "Data Analysis Skill",
    "description": "A skill for analyzing data and generating insights",
    "configuration": {
      "capabilities": ["data_analysis", "visualization", "reporting"]
    }
  }'
```

**Python:**
```python
import requests

url = "https://api.anthropic.com/v1/skills"
headers = {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "skills-2025-10-02",
    "x-api-key": "your-api-key",
    "Content-Type": "application/json"
}

data = {
    "display_title": "Data Analysis Skill",
    "description": "A skill for analyzing data and generating insights",
    "configuration": {
        "capabilities": ["data_analysis", "visualization", "reporting"]
    }
}

response = requests.post(url, headers=headers, json=data)
print(response.json())
```

## Response Format

### Skill Creation Response

```json
{
  "id": "skill_1234567890abcdef",
  "created_at": "2025-01-21T14:33:00Z",
  "display_title": "Data Analysis Skill",
  "latest_version": "v1.0.0",
  "source": "custom",
  "type": "skill",
  "updated_at": "2025-01-21T14:33:00Z"
}
```

### Response Fields:

- `id: string` - Unique identifier for the skill. The format and length of IDs may change over time.
- `created_at: string` - ISO 8601 timestamp of when the skill was created.
- `display_title: string` - Display title for the skill. This is a human-readable label that is not included in the prompt sent to the model.
- `latest_version: string` - The latest version identifier for the skill. This represents the most recent version of the skill that has been created.
- `source: string` - Source of the skill. This may be one of the following values:
  - `"custom"`: the skill was created by a user
  - `"anthropic"`: the skill was created by Anthropic
- `type: string` - Object type. For Skills, this is always `"skill"`.
- `updated_at: string` - ISO 8601 timestamp of when the skill was last updated.

## Skill Operations

### 1. Create Skill
Create a new custom skill.

**Endpoint:** `POST /v1/skills`

**Required Parameters:**
- `display_title: string` - Human-readable title for the skill
- `description: string` - Description of the skill's capabilities
- `configuration: object` - Skill configuration and capabilities

### 2. Retrieve Skill
Get skill details by ID.

**Endpoint:** `GET /v1/skills/{skill_id}`

**Example:**
```bash
curl https://api.anthropic.com/v1/skills/skill_1234567890abcdef \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: skills-2025-10-02' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

### 3. List Skills
List all skills available to your organization.

**Endpoint:** `GET /v1/skills`

**Example:**
```bash
curl https://api.anthropic.com/v1/skills \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: skills-2025-10-02' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

### 4. Update Skill
Update an existing skill.

**Endpoint:** `PUT /v1/skills/{skill_id}`

**Example:**
```bash
curl -X PUT https://api.anthropic.com/v1/skills/skill_1234567890abcdef \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: skills-2025-10-02' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "display_title": "Enhanced Data Analysis Skill",
    "description": "Updated skill with additional capabilities",
    "configuration": {
      "capabilities": ["data_analysis", "visualization", "reporting", "prediction"]
    }
  }'
```

### 5. Delete Skill
Remove a skill.

**Endpoint:** `DELETE /v1/skills/{skill_id}`

**Example:**
```bash
curl -X DELETE https://api.anthropic.com/v1/skills/skill_1234567890abcdef \
  -H 'anthropic-version: 2023-06-01' \
  -H 'anthropic-beta: skills-2025-10-02' \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

## Skill Configuration

### Basic Skill Structure

```json
{
  "display_title": "Customer Support Agent",
  "description": "A skill for handling customer support inquiries with contextual understanding",
  "configuration": {
    "capabilities": [
      "ticket_handling",
      "faq_retrieval",
      "escalation_detection",
      "sentiment_analysis"
    ],
    "parameters": {
      "response_tone": "professional",
      "max_response_length": 500,
      "allow_escalation": true
    },
    "examples": [
      {
        "input": "My order hasn't arrived yet",
        "output": "I understand you're concerned about your order. Let me check the status for you."
      }
    ]
  }
}
```

### Advanced Skill Configuration

```json
{
  "display_title": "Code Review Assistant",
  "description": "A skill for reviewing code and providing constructive feedback",
  "configuration": {
    "capabilities": [
      "syntax_analysis",
      "best_practices",
      "security_checks",
      "performance_optimization"
    ],
    "parameters": {
      "language": "python",
      "strictness": "medium",
      "include_examples": true,
      "max_issues_per_file": 10
    },
    "templates": {
      "feedback_format": "## Issue: {issue}\n**Location:** {location}\n**Severity:** {severity}\n**Suggestion:** {suggestion}",
      "summary_format": "Found {total_issues} issues in {file_count} files"
    },
    "rules": [
      {
        "condition": "code_complexity > 10",
        "action": "flag_for_refactor",
        "message": "Consider breaking down this complex function"
      }
    ]
  }
}
```

## Using Skills in API Calls

### Messages API with Skills

Skills can be referenced in Messages API calls to enable specific capabilities.

**Example:**
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "Analyze this customer feedback and suggest improvements: 'The app crashes frequently on startup.'"
    }
  ],
  "skills": [
    {
      "skill_id": "skill_1234567890abcdef",
      "configuration": {
        "analysis_depth": "detailed",
        "include_examples": true
      }
    }
  ]
}
```

### Skill Activation Modes

#### 1. Explicit Activation
```json
{
  "skills": [
    {
      "skill_id": "skill_1234567890abcdef",
      "mode": "explicit"
    }
  ]
}
```

#### 2. Automatic Activation
```json
{
  "skills": [
    {
      "skill_id": "skill_1234567890abcdef",
      "mode": "auto",
      "triggers": ["customer_feedback", "sentiment_analysis"]
    }
  ]
}
```

#### 3. Conditional Activation
```json
{
  "skills": [
    {
      "skill_id": "skill_1234567890abcdef",
      "mode": "conditional",
      "conditions": [
        {
          "field": "message_topic",
          "operator": "contains",
          "value": "bug report"
        }
      ]
    }
  ]
}
```

## Skill Development Lifecycle

### 1. Design Phase
More- Define skill purpose and capabilities
- Identify use cases and examples
- Design skill configuration schema
- Plan testing and validation

### 2. Development Phase
- Create skill configuration
- Implement skill logic (if custom)
- Add examples and templates
- Configure parameters and rules

### 3. Testing Phase
- Test with sample inputs
- Validate outputs and behavior
- Performance testing
- Security validation

### 4. Deployment Phase
 - Create skill via API
- Test in staging environment
- Monitor performance
- Gather user feedback

### 5. Maintenance Phase
- Monitor skill usage
- Update based on feedback
- Fix issues and bugs
- Deprecate when needed

## Skill Types

### 1. Analysis Skills
- **Purpose**: Analyze content and extract insights
- **Examples**: Sentiment analysis, data extraction, pattern recognition
- **Configuration**: Analysis depth, output format, filters

### 2. Processing Skills
- **Purpose**: Transform or process content
- **Examples**: Format conversion, data normalization, summarization
- **Configuration**: Processing rules, output format, quality settings

### 3. Decision Skills
- **Purpose**: Make decisions or recommendations
- **Examples**: Classification, prioritization, routing
- **Configuration**: Decision criteria, confidence thresholds, fallback options

### 4. Integration Skills
- **Purpose**: Integrate with external systems
- **Examples**: API calls, database queries, file operations
- **Configuration**: Connection details, authentication, timeout settings

## Error Handling

### Common Errors:

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `invalid_skill_configuration` | 400 | Invalid skill configuration |
| `skill_not_found` | 404 | Skill ID does not exist |
| `skill_limit_exceeded` | 403 | Maximum number of skills reached |
| `permission_denied` | 403 | No permission to create/use skill |
| `skill_execution_error` | 500 | Error during skill execution |

### Example Error Response:
```json
{
  "type": "error",
  "error": {
    "type": "invalid_skill_configuration",
    "message": "Skill configuration validation failed",
    "details": {
      "field": "capabilities",
      "issue": "Must contain at least one capability"
    }
  }
}
```

## Performance Considerations

### 1. Skill Complexity
- **Simple skills**: Fast execution, low resource usage
- **Complex skills**: May have latency, higher resource usage
- **Optimization**: Profile and optimize skill performance

### 2. Caching Strategies
- **Result caching**: Cache skill outputs when appropriate
- **Configuration caching**: Cache skill configurations
- **Template caching**: Cache skill templates and examples

### 3. Parallel Execution
- **Independent skills**: Can run in parallel
- **Dependent skills**: Sequential execution required
- **Resource management**: Monitor concurrent skill usage

## Security Considerations

### 1. Access Control
- **Skill permissions**: Control who can create/use skills
- **Data access**: Limit skill access to sensitive data
- **API restrictions**: Control external API calls from skills

### 2. Input Validation
- **Sanitize inputs**: Prevent injection attacks
- **Validate configurations**: Ensure safe skill configurations
- **Size limits**: Prevent resource exhaustion attacks

### 3. Output Validation
- **Content filtering**: Filter inappropriate outputs
- **Data leakage**: Prevent sensitive data exposure
- **Quality checks**: Validate skill output quality

## Integration Examples

### Complete Skill Workflow:

```python
from anthropic import Anthropic

# Initialize client
client = Anthropic(api_key="YOUR_API_KEY")

# Step 1: Create a skill
def create_skill():
    skill_config = {
        "display_title": "Content Moderator",
        "description": "Skill for moderating user-generated content",
        "configuration": {
            "capabilities": ["profanity_detection", "spam_detection", "toxicity_analysis"],
            "parameters": {
                "strictness": "medium",
                "languages": ["en"],
                "auto_flag": True
            },
            "rules": [
                {
                    "pattern": "[profanity]",
                    "action": "flag",
                    "severity": "high"
                }
            ]
        }
    }

    response = client.skills.create(
        display_title=skill_config["display_title"],
        description=skill_config["description"],
        configuration=skill_config["configuration"]
    )

    return response.id

# Step 2: Use the skill in messages
def moderate_content(content, skill_id):
    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=256,
        messages=[
            {
                "role": "user",
                "content": f"Moderate this content: {content}"
            }
        ],
        skills=[
            {
                "skill_id": skill_id,
                "configuration": {
                    "strictness": "high",
                    "detailed_report": True
                }
            }
        ]
    )

    return response.content[0].text

# Step 3: Update skill based on feedback
def update_skill(skill_id, feedback):
    updated_config = {
        "display_title": "Enhanced Content Moderator",
        "description": "Updated based on user feedback",
        "configuration": {
            "capabilities": ["profanity_detection", "spam_detection", "toxicity_analysis", "context_awareness"],
            "parameters": {
                "strictness": "adaptive",
                "languages": ["en", "es"],
                "auto_flag": True,
                "learning_enabled": True
            }
        }
    }

    client.skills.update(
        skill_id=skill_id,
        display_title=updated_config["display_title"],
        description=updated_config["description"],
        configuration=updated_config["configuration"]
    )

# Usage
skill_id = create_skill()
moderation_result = moderate_content("User post content here", skill_id)
print(moderation_result)
```

### Skill Chaining Example:

```python
def process_document_with_skills(document_text):
    """Chain multiple skills to process a document."""

    skills_chain = [
        {
            "skill_id": "skill_summarization",
            "configuration": {"summary_length": "medium"}
        },
        {
            "skill_id": "skill_analysis",
            "configuration": {"analysis_type": "key_points"}
        },
        {
            "skill_id": "skill_formatting",
            "configuration": {"output_format": "markdown"}
        }
    ]

    response = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": f"Process this document: {document_text}"
            }
        ],
        skills=skills_chain
    )

    return {
        "summary": extract_summary(response),
        "analysis": extract_analysis(response),
        "formatted": extract_formatted(response)
    }
```

## Best Practices

### 1. Skill Design
- **Single responsibility**: Each skill should have a clear, focused purpose
- **Reusability**: Design skills to be reusable across different contexts
- **Configurability**: Make skills configurable for different use cases
- **Documentation**: Provide clear documentation for each skill

### 2. Performance Optimization
- **Efficient configurations**: Optimize skill configurations for performance
- **Caching**: Implement appropriate caching strategies
- **Monitoring**: Monitor skill performance and resource usage
- **Scaling**: Design skills to scale with increased usage

### 3. Security
- **Input validation**: Always validate skill inputs
- **Access control**: Implement proper access controls for skills
- **Audit logging**: Log skill usage and outcomes
- **Regular reviews**: Regularly review and update security measures

### 4. Maintenance
- **Version control**: Track skill versions and changes
- **Testing**: Maintain comprehensive test suites
- **Monitoring**: Monitor skill usage and effectiveness
- **Feedback loops**: Collect and act on user feedback

## Limitations

### Current Beta Limitations:
- **Availability**: Beta feature, subject to change
- **Skill limits**: Limited number of skills per organization
- **Complexity limits**: Skills have complexity limitations
- **Performance**: Beta may have performance constraints

### Planned Improvements:
- **Increased skill limits**
- **Advanced skill capabilities**
- **Improved performance**
- **Enhanced tooling and debugging**

## Next Steps

- [Messages API](messages-api.md): Using skills in conversations
- [Files API](files-api.md): Combining skills with file processing
- [Rate Limits](rate-limits.md): Understanding usage tiers
- [Examples](../examples/): Code samples and tutorials