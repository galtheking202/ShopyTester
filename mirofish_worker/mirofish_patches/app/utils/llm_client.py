"""
LLM Client — CLI-only providers (Claude Code, Codex).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from typing import Optional, Dict, Any, List

from ..config import Config
from .logger import get_logger

logger = get_logger('mirofish.llm_client')

MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0  # seconds


class LLMClient:
    """LLM Client — supports claude-cli and codex-cli."""

    def __init__(self, provider: Optional[str] = None):
        self.provider = (provider or Config.LLM_PROVIDER or "claude-cli").lower()
        if self.provider not in ("claude-cli", "codex-cli", "gemini-api"):
            raise ValueError(
                f"Unsupported LLM provider: {self.provider!r}. "
                "Use 'claude-cli', 'codex-cli', or 'gemini-api'."
            )

    def _split_system_message(self, messages: List[Dict[str, str]]):
        """Split system message from conversation messages."""
        system_text = None
        conversation = []

        for msg in messages:
            if msg.get("role") == "system":
                if system_text is None:
                    system_text = msg["content"]
                else:
                    system_text += "\n\n" + msg["content"]
            else:
                conversation.append(msg)

        return system_text, conversation

    def _clean_content(self, content: str) -> str:
        """Remove <think> tags from reasoning models."""
        return re.sub(r'<think>[\s\S]*?</think>', '', content).strip()

    def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 4096,
        response_format: Optional[Dict] = None
    ) -> str:
        """Send a chat request via CLI with automatic retry on transient failures."""
        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                if self.provider == "gemini-api":
                    return self._chat_gemini_api(messages, temperature, max_tokens, response_format)
                if self.provider == "codex-cli":
                    return self._chat_codex_cli(messages, temperature, max_tokens, response_format)
                return self._chat_claude_cli(messages, temperature, max_tokens, response_format)
            except RuntimeError as exc:
                last_error = exc
                if attempt < MAX_RETRIES - 1:
                    delay = RETRY_BASE_DELAY * (2 ** attempt)
                    logger.warning(f"LLM call failed (attempt {attempt + 1}/{MAX_RETRIES}), retrying in {delay}s: {exc}")
                    time.sleep(delay)
        raise last_error

    def _chat_claude_cli(
        self,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: int,
        response_format: Optional[Dict] = None
    ) -> str:
        """Chat via Claude Code CLI."""
        system_text, conversation = self._split_system_message(messages)

        prompt_parts = []
        if system_text:
            prompt_parts.append(f"SYSTEM INSTRUCTIONS:\n{system_text}\n")

        if response_format and response_format.get("type") == "json_object":
            prompt_parts.append("IMPORTANT: Respond with valid JSON only. No markdown, no explanation, just pure JSON.\n")

        for msg in conversation:
            role = msg.get("role", "user").upper()
            prompt_parts.append(f"{role}: {msg['content']}")

        prompt = "\n\n".join(prompt_parts)

        try:
            claude_bin = shutil.which("claude") or "claude"
            result = subprocess.run(
                [claude_bin, "-p", "--output-format", "json", prompt],
                capture_output=True, text=True, timeout=300,
                cwd=tempfile.gettempdir()
            )

            if result.returncode != 0:
                logger.error(f"Claude CLI error: {result.stderr[:200]}")
                raise RuntimeError(f"Claude CLI failed: {result.stderr[:200]}")

            try:
                output = json.loads(result.stdout)
                content = output.get("result", result.stdout)
            except json.JSONDecodeError:
                content = result.stdout.strip()

            return self._clean_content(content)

        except subprocess.TimeoutExpired:
            raise RuntimeError("Claude CLI timed out after 300s")

    def _chat_gemini_api(
        self,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: int,
        response_format: Optional[Dict] = None
    ) -> str:
        """Chat via the Gemini API (google-genai SDK). Headless, key-based."""
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise RuntimeError(
                "google-genai is not installed. `pip install google-genai` to use gemini-api."
            ) from exc

        api_key = Config.GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is not set for LLM_PROVIDER=gemini-api")

        system_text, conversation = self._split_system_message(messages)
        contents = []
        for msg in conversation:
            role = "model" if msg.get("role") == "assistant" else "user"
            contents.append(
                types.Content(role=role, parts=[types.Part(text=msg["content"])])
            )

        want_json = bool(response_format and response_format.get("type") == "json_object")
        config = types.GenerateContentConfig(
            temperature=temperature,
            # Headroom so large JSON (e.g. ontology) isn't truncated.
            max_output_tokens=max(max_tokens, 8192),
            system_instruction=system_text or None,
            response_mime_type="application/json" if want_json else None,
            # Gemini 2.5 spends output tokens "thinking" before answering, which
            # truncates the JSON. Disable it so the budget goes to the answer.
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            # Per-request timeout (ms). Without this a hung call blocks the whole
            # OASIS round indefinitely; with it the call fails and the retry runs.
            http_options=types.HttpOptions(
                timeout=int(os.getenv("GEMINI_TIMEOUT_MS", "120000"))
            ),
        )

        try:
            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(
                model=Config.GEMINI_MODEL, contents=contents, config=config
            )
        except Exception as exc:  # noqa: BLE001 - surface as retryable RuntimeError
            raise RuntimeError(f"Gemini API failed: {str(exc)[:200]}") from exc

        return self._clean_content(resp.text or "")

    def _chat_codex_cli(
        self,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: int,
        response_format: Optional[Dict] = None
    ) -> str:
        """Chat via Codex CLI."""
        system_text, conversation = self._split_system_message(messages)

        prompt_parts = []
        if system_text:
            prompt_parts.append(f"SYSTEM INSTRUCTIONS:\n{system_text}\n")

        if response_format and response_format.get("type") == "json_object":
            prompt_parts.append("IMPORTANT: Respond with valid JSON only. No markdown, no explanation, just pure JSON.\n")

        for msg in conversation:
            role = msg.get("role", "user").upper()
            prompt_parts.append(f"{role}: {msg['content']}")

        prompt = "\n\n".join(prompt_parts)

        try:
            codex_bin = shutil.which("codex") or "codex"
            result = subprocess.run(
                [codex_bin, "exec", "--skip-git-repo-check"],
                input=prompt,
                capture_output=True, text=True, timeout=180,
                cwd=tempfile.gettempdir()
            )

            if result.returncode != 0:
                logger.error(f"Codex CLI error: {result.stderr[:200]}")
                raise RuntimeError(f"Codex CLI failed: {result.stderr[:200]}")

            raw = result.stdout.strip()
            parts = raw.split("\ncodex\n")
            if len(parts) > 1:
                content = parts[-1].strip()
                lines = content.split("\n")
                clean_lines = []
                for line in lines:
                    if line.strip() == "tokens used":
                        break
                    clean_lines.append(line)
                content = "\n".join(clean_lines).strip()
            else:
                content = raw
            return self._clean_content(content)

        except subprocess.TimeoutExpired:
            raise RuntimeError("Codex CLI timed out after 180s")

    def chat_json(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096
    ) -> Dict[str, Any]:
        """Send a chat request and return parsed JSON."""
        response = self.chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"}
        )
        cleaned_response = response.strip()
        cleaned_response = re.sub(r'^```(?:json)?\s*\n?', '', cleaned_response, flags=re.IGNORECASE)
        cleaned_response = re.sub(r'\n?```\s*$', '', cleaned_response)
        cleaned_response = cleaned_response.strip()

        try:
            return json.loads(cleaned_response)
        except json.JSONDecodeError:
            raise ValueError(f"Invalid JSON returned by LLM: {cleaned_response[:500]}")
