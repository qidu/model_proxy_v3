#!/bin/bash

# Llama Messages API Test Script for model_proxy_v3
# Tests the /v1/messages endpoint with llama model

set -e

# ============================================================
# 配置
# ============================================================

# Proxy endpoint configuration
PORT=8788
PROXY_ENDPOINT="http://localhost:${PORT}/v1/messages"

# Model configuration
MODEL="llama"

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Output functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Common curl request function
curl_post() {
    local endpoint="$1"
    local data="$2"
    local desc="$3"

    log_info "测试: $desc"
    log_info "端点: $endpoint"

    time curl -s -X POST "$endpoint" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -d "$data" | jq '.'
}

# ============================================================
# 测试用例
# ============================================================

# TC01: 基础文本对话
test_TC01() {
    log_info "=== TC01: 基础文本对话 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "你好，请介绍一下你自己"}], "max_tokens": 1024}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC01 基础对话"
}

# TC02: 多轮对话
test_TC02() {
    log_info "=== TC02: 多轮对话 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "什么是机器学习？"}, {"role": "assistant", "content": "机器学习是..."}, {"role": "user", "content": "能举个具体的例子吗？"}], "max_tokens": 1024}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC02 多轮对话"
}

# TC03: 系统提示词
test_TC03() {
    log_info "=== TC03: 系统提示词 ==="

    local data='{"model": "'"$MODEL"'", "system": "你是一位专业的Python编程助手", "messages": [{"role": "user", "content": "写一个快速排序算法"}], "max_tokens": 2048}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC03 系统提示词"
}

# TC04: 自定义停止序列
test_TC04() {
    log_info "=== TC04: 自定义停止序列 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "列出5个编程语言"}], "max_tokens": 1024, "stop_sequences": ["4."]}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC04 停止序列"
}

# TC05: 温度参数测试
test_TC05() {
    log_info "=== TC05: 温度参数测试 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "1+1等于几"}], "max_tokens": 1024, "temperature": 0.0}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC05 温度参数"
}

# TC06: 流式响应
test_TC06() {
    log_info "=== TC06: 流式响应 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "写一首关于春天的诗"}], "max_tokens": 1024, "stream": true}'

    log_info "TC06 流式响应"
    curl -s -X POST "$PROXY_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -d "$data" \
        --no-buffer
}

# TC07: 工具调用 (Tool Use)
test_TC07() {
    log_info "=== TC07: 工具调用 (Tool Use) ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "请帮我查询天气"}], "max_tokens": 1024, "tools": [{"name": "get_weather", "description": "获取指定城市的天气信息", "input_schema": {"type": "object", "properties": {"city": {"type": "string", "description": "城市名称"}}, "required": ["city"]}}]}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC07 工具调用"
}

# TC08: 扩展思考 (Thinking)
test_TC08() {
    log_info "=== TC08: 扩展思考 (Thinking) ==="

    local data='{"model": "'"$MODEL"'", "exists": [{"role": "user", "content": "分析一下人工智能的发展趋势"}], "max_tokens": 4096, "thinking": {"type": "enabled", "budget_tokens": 2048}}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC08 扩展思考"
}

# TC09: 缺少必填参数
test_TC09() {
    log_info "=== TC09: 缺少必填参数 ==="

    echo "测试缺少必填参数"
    curl -s -X POST "$PROXY_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -d '{"model": "'"$MODEL"'"}' | jq '.'
}

# TC10: 无效的Model名称
test_TC10() {
    log_info "=== TC10: 无效的Model名称 ==="

    local data='{"model": "non_existent_model", "messages": [{"role": "user", "content": "test"}], "max_tokens": 1024}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC10 无效Model"
}

# TC11: 性能测试
test_TC11() {
    log_info "=== TC11: 性能测试 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "你好"}], "max_tokens": 512}'
    local iterations=3

    log_info "进行 $iterations 次性能测试..."

    local total_time=0
    for i in {1..3}; do
        local start_time=$(date +%s%N)
        curl -s -X POST "$PROXY_ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "anthropic-version: 2023-06-01" \
            -d "$data" > /dev/null
        local end_time=$(date +%s%N)
        local duration=$(( (end_time - start_time) / 1000000 ))
        total_time=$(( total_time + duration ))
        echo "  第 $i 次: ${duration}ms"
    done
    local avg_time=$(( total_time / iterations ))
    echo "  平均响应时间: ${avg_time}ms"
}

# TC12: 验证响应格式
test_TC12() {
    log_info "=== TC12: 验证响应格式 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "你好"}], "max_tokens": 512}'

    log_info "获取响应并验证格式"
    local response=$(curl -s -X POST "$PROXY_ENDPOINT" \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -d "$data")

    echo "响应字段:"
    echo "$response" | jq -r 'keys | .[]' | sort

    local model=$(echo "$response" | jq -r '.model')
    if [ "$model" == "llama" ]; then
        log_info "✅ model字段正确: $model"
    else
        log_error "❌ model字段不正确: $model"
    fi

    local has_content=$(echo "$response" | jq -r '.content[0].text')
    if [ -n "$has_content" ]; then
        log_info "✅ content字段存在且包含文本"
    else
        log_error "❌ content字段缺失或为空"
    fi
}

# TC13: 基础请求（原 SDK 集成测试；sdk:// 路由及其 SDK 已移除）
test_TC13() {
    log_info "=== TC13: 基础请求 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "Hello, how are you?"}], "max_tokens": 512}'

    curl_post "$PROXY_ENDPOINT" "$data" "TC13 基础请求"
}

# TC14: 并发请求测试
test_TC14() {
    log_info "=== TC14: 并发请求测试 ==="

    local data='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "test"}], "max_tokens": 64}'

    log_info "发送 3 个并发请求..."
    for i in {1..3}; do
        curl -s -w "%{http_code}" -X POST "$PROXY_ENDPOINT" \
            -H "Content-Type: application/json" \
            -H "anthropic-version: 2023-06-01" \
            -d '{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "test '"$i"'" }], "max_tokens": 64}' \
            -o /dev/null
        echo " 请求 $i: ${http_code}"
    done
    wait
    log_info "并发请求完成"
}

# TC15: 不同max_tokens值测试
test_TC15() {
    log_info "=== TC15: 不同max_tokens值测试 ==="

    local data_small='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "简短回答"}], "max_tokens": 50}'
    local data_medium='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "中等长度回答"}], "max_tokens": 256}'
    local data_large='{"model": "'"$MODEL"'", "messages": [{"role": "user", "content": "详细回答"}], "max_tokens": 1024}'

    echo "--- 小max_tokens测试 ---"
    curl_post "$PROXY_ENDPOINT" "$data_small" "小max_tokens"

    echo ""
    echo "--- 中等max_tokens测试 ---"
    curl_post "$PROXY_ENDPOINT" "$data_medium" "中等max_tokens"

    echo ""
    echo "--- 大max_tokens测试 ---"
    curl_post "$PROXY_ENDPOINT" "$data_large" "大max_tokens"
}

# 打印帮助信息
print_help() {
    echo "用法: $0 [test_case_number]"
    echo ""
    echo "可用测试用例:"
    echo "  TC01-TC15  - 运行单个测试用例"
    echo "  all        - 运行所有测试用例"
    echo "  help       - 显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  $0                    # 运行所有测试"
    echo "  $0 TC01              # 只运行 TC01"
    echo "  $0 TC06 TC11 TC12    # 运行多个测试"
}

# 主函数
main() {
    if [ $# -eq 0 ]; then
        print_help
        exit 0
    fi

    case "$1" in
        help|--help|-h)
            print_help
            ;;
        all)
            test_TC01
            test_TC02
            test_TC03
            test_TC04
            test_TC05
            test_TC06
            test_TC07
            test_TC08
            test_TC09
            test_TC10
            test_TC11
            test_TC12
            test_TC13
            test_TC14
            test_TC15
            ;;
        TC01) test_TC01 ;;
        TC02) test_TC02 ;;
        TC03) test_TC03 ;;
        TC04) test_TC04 ;;
        TC05) test_TC05 ;;
        TC06) test_TC06 ;;
        TC07) test_TC07 ;;
        TC08) test_TC08 ;;
        TC09) test_TC09 ;;
        TC10) test_TC10 ;;
        TC11) test_TC11 ;;
        TC12) test_TC12 ;;
        TC13) test_TC13 ;;
        TC14) test_TC14 ;;
        TC15) test_TC15 ;;
        *)
            log_error "未知测试用例: $1"
            print_help
            exit 1
            ;;
    esac
}

main "$@"