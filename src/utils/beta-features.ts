/**
 * Beta feature validation utilities for Claude Proxy v3
 *
 * Based on Claude API documentation beta features list
 */

export const VALID_BETA_FEATURES = [
    "message-batches-2024-09-24",
    "prompt-caching-2024-07-31",
    "computer-use-2024-10-22",
    "computer-use-2025-01-24",
    "pdfs-2024-09-25",
    "token-counting-2024-11-01",
    "token-efficient-tools-2025-02-19",
    "output-128k-2025-02-19",
    "files-api-2025-04-14",
    "mcp-client-2025-04-04",
    "mcp-client-2025-11-20",
    "dev-full-thinking-2025-05-14",
    "interleaved-thinking-2025-05-14",
    "code-execution-2025-05-22",
    "extended-cache-ttl-2025-04-11",
    "context-1m-2025-08-07",
    "context-management-2025-06-27",
    "model-context-window-exceeded-2025-08-26",
    "skills-2025-10-02",
] as const;

export type AnthropicBeta = typeof VALID_BETA_FEATURES[number];

/**
 * Parse and validate anthropic-beta header
 */
export function validateBetaFeatures(headerValue: string | null): AnthropicBeta[] | null {
    if (!headerValue) {
        return null;
    }

    try {
        // Parse as JSON array
        const features = JSON.parse(headerValue);

        if (!Array.isArray(features)) {
            throw new Error('anthropic-beta header must be a JSON array');
        }

        // Validate each feature
        const validFeatures: AnthropicBeta[] = [];
        for (const feature of features) {
            if (typeof feature !== 'string') {
                throw new Error(`Beta feature must be a string, got ${typeof feature}`);
            }

            if (VALID_BETA_FEATURES.includes(feature as any)) {
                validFeatures.push(feature as AnthropicBeta);
            } else {
                // Drop unknown features — do NOT forward unrecognized beta values upstream.
            }
        }

        return validFeatures;
    } catch (error) {
        // Return null to indicate parsing failed, but don't throw
        return null;
    }
}

/**
 * Check if a specific beta feature is enabled
 */
export function hasBetaFeature(
    betaFeatures: AnthropicBeta[] | null,
    feature: AnthropicBeta
): boolean {
    if (!betaFeatures) {
        return false;
    }
    return betaFeatures.includes(feature);
}

/**
 * Create beta feature header value
 */
export function createBetaHeader(features: AnthropicBeta[]): string {
    return JSON.stringify(features);
}

/**
 * Endpoint hook retained for compatibility; currently performs no validation.
 */
export function validateBetaFeaturesForEndpoint(
    betaFeatures: AnthropicBeta[] | null,
    endpoint: string
): void {
    if (!betaFeatures) {
        return;
    }

    if (endpoint === 'v1/messages/count_tokens') {
        if (!hasBetaFeature(betaFeatures, 'token-counting-2024-11-01')) {
        }
    }

    if (endpoint.startsWith('v1/files')) {
        if (!hasBetaFeature(betaFeatures, 'files-api-2025-04-14')) {
        }
    }

    if (endpoint.startsWith('v1/skills')) {
        if (!hasBetaFeature(betaFeatures, 'skills-2025-10-02')) {
        }
    }
}