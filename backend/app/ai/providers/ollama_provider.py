"""
Ollama 本地模型 Provider。

通过 HTTP API 调用本地部署的 Ollama 服务，支持离线环境。
"""
from __future__ import annotations

import json
from typing import AsyncIterator

from .base import BaseProvider, LLMResponse, LLMStreamEvent


class OllamaProvider(BaseProvider):
    """Ollama 本地模型 Provider。"""

    name = "ollama"

    DEFAULT_MODEL = "qwen2.5:7b"
    DEFAULT_BASE_URL = "http://localhost:11434"

    def __init__(self, base_url: str = "", default_model: str = "", **_):
        self.base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self.default_model = default_model or self.DEFAULT_MODEL
        self._httpx = None

    def _get_httpx(self):
        if self._httpx is None:
            try:
                import httpx
                self._httpx = httpx.AsyncClient(timeout=120.0)
            except ImportError:
                raise ImportError(
                    "httpx 未安装，请执行: pip install httpx"
                )
        return self._httpx

    async def complete(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str = "",
        temperature: float = 0.3,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        use_model = model or self.default_model
        try:
            client = self._get_httpx()
            payload = {
                "model": use_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "stream": False,
                "options": {
                    "temperature": temperature,
                    "num_predict": max_tokens,
                },
            }
            resp = await client.post(
                f"{self.base_url}/api/chat",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data.get("message", {}).get("content", "")
            # Ollama 不总是返回 token 统计
            eval_count = data.get("eval_count", 0)
            prompt_eval_count = data.get("prompt_eval_count", 0)
            return LLMResponse(
                content=content,
                model=use_model,
                input_tokens=prompt_eval_count,
                output_tokens=eval_count,
            )
        except ImportError as e:
            return LLMResponse(content="", error=str(e))
        except Exception as e:
            return LLMResponse(
                content="",
                model=use_model,
                error=f"Ollama 调用失败: {type(e).__name__}: {e}",
            )

    async def stream_complete(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str = "",
        temperature: float = 0.3,
        max_tokens: int = 2048,
    ) -> AsyncIterator[LLMStreamEvent]:
        """Ollama 原生流式调用（NDJSON，每行一个增量块）。"""
        use_model = model or self.default_model
        emitted = False
        eval_count = 0
        prompt_eval_count = 0
        stop_reason = ""
        try:
            client = self._get_httpx()
            payload = {
                "model": use_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "stream": True,
                "options": {
                    "temperature": temperature,
                    "num_predict": max_tokens,
                },
            }
            async with client.stream(
                "POST", f"{self.base_url}/api/chat", json=payload,
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = data.get("message") or {}
                    thinking = message.get("thinking", "")
                    if thinking:
                        yield LLMStreamEvent(type="thinking", text=thinking)
                    text = message.get("content", "")
                    if text:
                        emitted = True
                        yield LLMStreamEvent(type="delta", text=text)
                    if data.get("done"):
                        eval_count = data.get("eval_count", 0) or 0
                        prompt_eval_count = data.get("prompt_eval_count", 0) or 0
                        stop_reason = data.get("done_reason", "") or ""

            yield LLMStreamEvent(
                type="done",
                model=use_model,
                input_tokens=prompt_eval_count,
                output_tokens=eval_count,
                stop_reason=stop_reason,
            )
        except ImportError as e:
            yield LLMStreamEvent(type="done", model=use_model, error=str(e))
        except Exception as e:
            if emitted:
                yield LLMStreamEvent(
                    type="done",
                    model=use_model,
                    input_tokens=prompt_eval_count,
                    output_tokens=eval_count,
                    error=f"Ollama 流式调用中断: {type(e).__name__}: {e}",
                )
                return
            # 流式不可用时退化为一次性调用
            resp = await self.complete(
                system_prompt, user_prompt,
                model=model, temperature=temperature, max_tokens=max_tokens,
            )
            if resp.ok and resp.content:
                yield LLMStreamEvent(type="delta", text=resp.content)
            yield LLMStreamEvent(
                type="done",
                model=resp.model,
                input_tokens=resp.input_tokens,
                output_tokens=resp.output_tokens,
                stop_reason=resp.stop_reason,
                error=resp.error,
            )

    async def test_connection(self) -> tuple[bool, str]:
        try:
            client = self._get_httpx()
            resp = await client.get(f"{self.base_url}/api/tags")
            resp.raise_for_status()
            models = resp.json().get("models", [])
            names = [m.get("name", "") for m in models[:5]]
            return True, f"Ollama 连接成功，可用模型: {', '.join(names) or '(无)'}"
        except Exception as e:
            return False, f"Ollama 连接失败: {e}"
