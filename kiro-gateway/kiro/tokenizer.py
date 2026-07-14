# -*- coding: utf-8 -*-

# Kiro Gateway
# https://github.com/jwadow/kiro-gateway
# Copyright (C) 2025 Jwadow
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""
Module for fast token counting.

Uses tiktoken (OpenAI's Rust library) for approximate
token counting. The cl100k_base encoding is close to Claude tokenization.

Note: This is an approximate count, as the exact Claude tokenizer
is not public. Anthropic does not publish their tokenizer,
so tiktoken with a correction coefficient is used.

The correction coefficient CLAUDE_CORRECTION_FACTOR = 1.15 is based on
empirical observations: Claude tokenizes text approximately 15%
more than GPT-4 (cl100k_base). This is due to differences in BPE vocabularies.
"""

from typing import List, Dict, Any, Optional
from loguru import logger

# Lazy loading of tiktoken to speed up import
_encoding = None

# Correction coefficient for Claude models
# Claude tokenizes text approximately 15% more than GPT-4 (cl100k_base)
# This is an empirical value based on comparison with context_usage from API
CLAUDE_CORRECTION_FACTOR = 1.15


def _get_encoding():
    """
    Lazy initialization of tokenizer.
    
    Uses cl100k_base - encoding for GPT-4/ChatGPT,
    which is close enough to Claude tokenization.
    
    Returns:
        tiktoken.Encoding or None if tiktoken is unavailable
    """
    global _encoding
    if _encoding is None:
        try:
            import tiktoken
            _encoding = tiktoken.get_encoding("cl100k_base")
            logger.debug("[Tokenizer] Initialized tiktoken with cl100k_base encoding")
        except ImportError:
            logger.warning(
                "[Tokenizer] tiktoken not installed. "
                "Token counting will use fallback estimation. "
                "Install with: pip install tiktoken"
            )
            _encoding = False  # Marker that import failed
        except Exception as e:
            logger.error(f"[Tokenizer] Failed to initialize tiktoken: {e}")
            _encoding = False
    return _encoding if _encoding else None


def count_tokens(text: str, apply_claude_correction: bool = True) -> int:
    """
    Counts the number of tokens in text.
    
    Args:
        text: Text to count tokens for
        apply_claude_correction: Apply correction coefficient for Claude (default True)
    
    Returns:
        Number of tokens (approximate, with Claude correction)
    """
    if not text:
        return 0
    
    encoding = _get_encoding()
    if encoding:
        try:
            base_tokens = len(encoding.encode(text))
            if apply_claude_correction:
                return int(base_tokens * CLAUDE_CORRECTION_FACTOR)
            return base_tokens
        except Exception as e:
            logger.warning(f"[Tokenizer] Error encoding text: {e}")
    
    # Fallback: rough estimate ~4 characters per token for English,
    # ~2-3 characters for other languages (taking average ~3.5)
    # For Claude we add correction
    base_estimate = len(text) // 4 + 1
    if apply_claude_correction:
        return int(base_estimate * CLAUDE_CORRECTION_FACTOR)
    return base_estimate


def count_message_tokens(messages: List[Dict[str, Any]], apply_claude_correction: bool = True) -> int:
    """
    Counts tokens in a list of chat messages.
    
    Accounts for OpenAI/Claude message structure:
    - role: ~1 token
    - content: text tokens
    - Service tokens between messages: ~3-4 tokens
    
    Args:
        messages: List of messages in OpenAI format
        apply_claude_correction: Apply correction coefficient for Claude
    
    Returns:
        Approximate number of tokens (with Claude correction)
    """
    if not messages:
        return 0

    import json as _json
    parts = []   # accumulate ALL text -> ONE count_tokens(tiktoken) call
    service = 0  # integer service-token overhead (no tiktoken calls)

    for message in messages:
        service += 4  # ~per-message overhead (role, delimiters)
        role = message.get("role", "")
        if role:
            parts.append(role)

        content = message.get("content")
        if content:
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                # Collect every structured block (text/thinking/tool_use/
                # tool_result/...). Previously each was a separate count_tokens
                # call; under concurrent load the hundreds of tiktoken calls per
                # request were the suspected SIGSEGV trigger.
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    itype = item.get("type")
                    if itype == "text":
                        parts.append(item.get("text", "") or "")
                    elif itype == "thinking":
                        parts.append(item.get("thinking", "") or item.get("text", "") or "")
                        parts.append(item.get("signature", "") or "")
                    elif itype == "redacted_thinking":
                        parts.append(item.get("data", "") or "")
                    elif itype == "tool_use":
                        parts.append(item.get("name", "") or "")
                        parts.append(_json.dumps(item.get("input", {}) or {}, ensure_ascii=False))
                    elif itype == "tool_result":
                        tr = item.get("content", "")
                        if isinstance(tr, str):
                            parts.append(tr)
                        elif isinstance(tr, list):
                            for sub in tr:
                                if isinstance(sub, dict):
                                    if sub.get("type") == "text":
                                        parts.append(sub.get("text", "") or "")
                                    elif sub.get("type") in ("image", "image_url"):
                                        service += 100
                                elif isinstance(sub, str):
                                    parts.append(sub)
                    elif itype in ("image", "image_url"):
                        service += 100
                    else:
                        for _v in item.values():
                            if isinstance(_v, str):
                                parts.append(_v)

        tool_calls = message.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                service += 4
                func = tc.get("function", {})
                parts.append(func.get("name", "") or "")
                parts.append(func.get("arguments", "") or "")

        if message.get("tool_call_id"):
            parts.append(message["tool_call_id"])

    service += 3
    # Single tiktoken call over all accumulated text.
    base = count_tokens("\n".join(parts), apply_claude_correction=False) + service
    if apply_claude_correction:
        return int(base * CLAUDE_CORRECTION_FACTOR)
    return base


def count_tools_tokens(tools: Optional[List[Dict[str, Any]]], apply_claude_correction: bool = True) -> int:
    """
    Counts tokens in tool definitions.
    
    Args:
        tools: List of tools in OpenAI format
        apply_claude_correction: Apply correction coefficient for Claude
    
    Returns:
        Approximate number of tokens (with Claude correction)
    """
    if not tools:
        return 0

    import json
    parts = []   # accumulate all tool text -> ONE count_tokens call
    service = 0  # integer per-tool overhead

    for tool in tools:
        service += 4
        if tool.get("type") == "function":
            func = tool.get("function", {})
            parts.append(func.get("name", "") or "")
            parts.append(func.get("description", "") or "")
            params = func.get("parameters")
            if params:
                parts.append(json.dumps(params, ensure_ascii=False))
        else:
            # Anthropic-format tool: name, description, input_schema
            parts.append(tool.get("name", "") or "")
            parts.append(tool.get("description", "") or "")
            schema = tool.get("input_schema") or tool.get("inputSchema")
            if schema:
                parts.append(json.dumps(schema, ensure_ascii=False))

    # Single tiktoken call over all tool schemas (was ~3 calls per tool).
    base = count_tokens("\n".join(parts), apply_claude_correction=False) + service
    if apply_claude_correction:
        return int(base * CLAUDE_CORRECTION_FACTOR)
    return base


def _collect_strings(obj: Any, acc: List[str]) -> None:
    """Recursively collect all string VALUES from a nested structure."""
    if isinstance(obj, str):
        acc.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_strings(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            _collect_strings(v, acc)


def count_payload_tokens(payload: Any, apply_claude_correction: bool = True) -> int:
    """
    Count tokens of ALL string values in an arbitrary payload (e.g. the Kiro
    wire payload produced by anthropic_to_kiro / build_kiro_payload).

    This reflects exactly what the upstream model actually receives — system
    prompt, message text, tool_use arguments, tool results, and tool schemas —
    regardless of block structure, so it can never silently undercount
    structured content (the bug that made tool_use/tool_result/thinking blocks
    read as ~0 tokens). Content the converter drops (e.g. thinking signatures,
    prior thinking text for native-reasoning models) is correctly excluded
    because it is simply not present in the payload.

    Args:
        payload: The Kiro payload dict (or any nested dict/list/str structure)
        apply_claude_correction: Apply the Claude correction factor (default True)

    Returns:
        Approximate number of input tokens the upstream will process.
    """
    acc: List[str] = []
    _collect_strings(payload, acc)
    if not acc:
        return 0
    return count_tokens("\n".join(acc), apply_claude_correction=apply_claude_correction)


def estimate_request_tokens(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    system_prompt: Optional[str] = None
) -> Dict[str, int]:
    """
    Estimates total number of tokens in request.
    
    Args:
        messages: List of messages
        tools: List of tools (optional)
        system_prompt: System prompt (optional, if not in messages)
    
    Returns:
        Dictionary with token breakdown:
        - messages_tokens: message tokens
        - tools_tokens: tool tokens
        - system_tokens: system prompt tokens
        - total_tokens: total count
    """
    messages_tokens = count_message_tokens(messages)
    tools_tokens = count_tools_tokens(tools)
    system_tokens = count_tokens(system_prompt) if system_prompt else 0
    
    return {
        "messages_tokens": messages_tokens,
        "tools_tokens": tools_tokens,
        "system_tokens": system_tokens,
        "total_tokens": messages_tokens + tools_tokens + system_tokens
    }