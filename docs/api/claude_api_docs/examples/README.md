# API Examples

This directory contains example code for using the Claude API in various programming languages.

## Table of Contents

1. [Basic Examples](#basic-examples)
2. [Advanced Examples](#advanced-examples)
3. [Language-Specific Examples](#language-specific-examples)
4. [Use Case Examples](#use-case-examples)

## Basic Examples

### 1. Hello World
- **Description**: Simple message sending
- **Languages**: Python, JavaScript, cURL, Java, Go, C#, Ruby, PHP
- **Features**: Basic authentication, simple request/response

### 2. Streaming Responses
- **Description**: Real-time streaming of responses
- **Languages**: Python, JavaScript
- **Features**: Server-sent events, incremental response handling

### 3. Multi-turn Conversations
- **Description**: Maintaining conversation context
- **Languages**: Python, JavaScript
- **Features**: Message history, context management

## Advanced Examples

### 4. Tool Use
- **Description**: Integrating external tools with Claude
- **Languages**: Python, JavaScript
- **Features**: Tool definitions, tool execution, result handling

### 5. File Processing
- **Description**: Uploading and processing files
- **Languages**: Python
- **Features**: File upload, document analysis, image processing

### 6. Batch Processing
- **Description**: Processing multiple requests efficiently
- **Languages**: Python
- **Features**: Batch API, async processing, result aggregation

### 7. Skills Integration
- **Description**: Using custom skills with Claude
- **Languages**: Python
- **Features**: Skill creation, skill activation, configuration

## Language-Specific Examples

### Python
- Basic usage with the `anthropic` package
- Async/await patterns
- Error handling and retries
- Streaming and tool use

### JavaScript/TypeScript
- Frontend integration
- Node.js server usage
- React integration examples
- TypeScript type definitions

### cURL
- Command-line examples
- Authentication setup
- Response parsing
- Error handling

### Other Languages
- Java enterprise patterns
- Go concurrent processing
- C# .NET integration
- Ruby Rails examples
- PHP web applications

## Use Case Examples

### Chat Applications
- Real-time chat interfaces
- Message history management
- User authentication integration
- Rate limiting and quotas

### Content Generation
- Blog post generation
- Code documentation
- Marketing copy
- Translation services

### Data Analysis
- Document summarization
- Data extraction
- Report generation
- Trend analysis

### Automation
- Customer support automation
- Code review automation
- Content moderation
- Workflow automation

## Getting Started

### Prerequisites
1. **API Key**: Get your API key from [Anthropic Console](https://platform.claude.com)
2. **Environment Setup**: Set `ANTHROPIC_API_KEY` environment variable
3. **SDK Installation**: Install the appropriate SDK for your language

### Quick Start

#### Python
```python
from anthropic import Anthropic

client = Anthropic()
response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Claude"}]
)
print(response.content[0].text)
```

#### JavaScript
```javascript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();
const message = await anthropic.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello, Claude' }]
});
console.log(message.content[0].text);
```

#### cURL
```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello, Claude"}]
  }'
```

## Best Practices

### 1. Error Handling
- Implement comprehensive error handling
- Use retry logic for transient failures
- Monitor rate limits and adjust accordingly

### 2. Performance
- Use streaming for interactive applications
- Implement caching for repeated requests
- Batch requests when possible

### 3. Security
- Keep API keys secure
- Validate user input
- Implement appropriate access controls

### 4. Monitoring
- Track API usage and costs
- Monitor response times and errors
- Set up alerts for abnormal patterns

## Contributing

Want to add more examples? Here's how:

1. **Fork the repository**
2. **Create a new example file** in the appropriate directory
3. **Follow the existing format** and include:
   - Clear comments
   - Error handling
   - Usage instructions
4. **Test your example** thoroughly
5. **Submit a pull request**

## Need Help?

- Check the [main documentation](../README.md)
- Review [API reference](https://platform.claude.com/docs/api)
- Join the [Anthropic community](https://community.anthropic.com)
- Contact [support](https://support.anthropic.com)

## License

These examples are provided under the MIT License. See [LICENSE](../LICENSE) for details.

---

**Note**: Always test examples in a development environment before using in production. Monitor your API usage and costs regularly.