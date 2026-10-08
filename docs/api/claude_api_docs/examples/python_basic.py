#!/usr/bin/env python3
"""
Basic Python example for Claude API
Demonstrates simple message sending with error handling
"""

import os
from anthropic import Anthropic, APIError, RateLimitError


def main():
    """Main function demonstrating basic Claude API usage."""

    # Initialize client
    # The SDK automatically reads ANTHROPIC_API_KEY from environment
    # You can also provide it explicitly: client = Anthropic(api_key="your-key")
    client = Anthropic()

    try:
        # Send a simple message
        print("Sending message to Claude...")
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=1024,
            messages=[
                {"role": "user", "content": "Hello, Claude! Can you introduce yourself?"}
            ]
        )

        # Print the response
        print("\nClaude's response:")
        print("-" * 50)
        print(response.content[0].text)
        print("-" * 50)

        # Show usage information
        print(f"\nUsage:")
        print(f"  Input tokens: {response.usage.input_tokens}")
        print(f"  Output tokens: {response.usage.output_tokens}")
        print(f"  Total tokens: {response.usage.input_tokens + response.usage.output_tokens}")

        # Show additional response metadata
        print(f"\nMetadata:")
        print(f"  Response ID: {response.id}")
        print(f"  Model: {response.model}")
        print(f"  Stop reason: {response.stop_reason}")

    except RateLimitError as e:
        print(f"Rate limit exceeded: {e}")
        print(f"Please wait {e.retry_after} seconds before retrying.")

    except APIError as e:
        print(f"API error occurred: {e.type} - {e.message}")
        print(f"Status code: {e.status_code}")

    except Exception as e:
        print(f"Unexpected error: {type(e).__name__}: {e}")


def multi_turn_conversation():
    """Example of a multi-turn conversation."""

    client = Anthropic()

    # First message
    print("\n=== Multi-turn Conversation Example ===")
    print("Starting conversation...")

    conversation_history = [
        {"role": "user", "content": "What's the capital of France?"}
    ]

    try:
        # First response
        response1 = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=512,
            messages=conversation_history
        )

        answer = response1.content[0].text
        print(f"\nClaude: {answer}")

        # Add Claude's response to history
        conversation_history.append({"role": "assistant", "content": answer})

        # Second question
        conversation_history.append({"role": "user", "content": "And what's a popular tourist attraction there?"})

        # Second response
        response2 = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=512,
            messages=conversation_history
        )

        print(f"\nClaude: {response2.content[0].text}")

        # Show total conversation tokens
        total_input = response1.usage.input_tokens + response2.usage.input_tokens
        total_output = response1.usage.output_tokens + response2.usage.output_tokens
        print(f"\nTotal conversation tokens: {total_input + total_output}")

    except Exception as e:
        print(f"Error in conversation: {e}")


def with_system_prompt():
    """Example using a system prompt."""

    client = Anthropic()

    print("\n=== System Prompt Example ===")
    print("Asking Claude to respond like a pirate...")

    try:
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=512,
            system="You are a friendly pirate. Respond in pirate speak.",
            messages=[
                {"role": "user", "content": "What's the weather like today?"}
            ]
        )

        print(f"\nPirate Claude: {response.content[0].text}")

    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    # Check for API key
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY environment variable is not set.")
        print("\nPlease set your API key:")
        print("  export ANTHROPIC_API_KEY='your-api-key-here'")
        print("\nYou can get an API key from: https://platform.claude.com/settings/keys")
        exit(1)

    # Run examples
    main()
    multi_turn_conversation()
    with_system_prompt()

    print("\n=== Examples Complete ===")
    print("\nFor more information, see:")
    print("- Claude API Documentation: https://platform.claude.com/docs")
    print("- Python SDK Documentation: https://github.com/anthropics/anthropic-sdk-python")