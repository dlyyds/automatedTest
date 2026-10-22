"""
Anthropic Messages 协议 Provider。

使用 Anthropic 官方 SDK 调用采用该协议的模型/网关。
"""
from __future__ import annotations

import traceback
from typing import AsyncIterator, Optional

from .base import BaseProvider, LLMResponse, LLMStreamEvent


class AnthropicProvider(BaseProvider):
    """Anthropic Messages 协议 Provider。"""

    name = "anthropic"

    # 模型别名映射 → 完整 model ID
    _MODEL_ALIASES = {
        # Anthropic 原生
        "haiku": "claude-haiku-4-5-20251001",
        "haiku-4.5": "claude-haiku-4-5-20251001",
        "sonnet": "claude-sonnet-5-20260901",
        "sonnet-5": "claude-sonnet-5-20260901",
        "opus": "claude-opus-5-20260901",
        # 中智 ThunderSoft 网关别名（方便用户输入短名）
        "auto": "ts-pri-auto",
        "kimi": "ts-pri-kimi",
        "glm": "ts-pri-glm",
        "deepseek": "ts-pri-deepseek",
    }

    DEFAULT_MODEL = "ts-pri-auto"

    def __init__(self, api_key: str, base_url: str = "", default_model: str = ""):
        self.api_key = api_key
        self.base_url = base_url or None
        self.default_model = self._resolve_model(default_model) if default_model else self.DEFAULT_MODEL
        self._client = None

    def _resolve_model(self, model: str) -> str:
        return self._MODEL_ALIASES.get(model.lower(), model)

    def _get_client(self):
        if self._client is None:
            try:
                import anthropic
                # 思考型模型 + 大 max_tokens 时单次调用可能耗时较久
                kwargs = {"api_key": self.api_key, "timeout": 180.0}
                if self.base_url:
                    kwargs["base_url"] = self.base_url
                self._client = anthropic.AsyncAnthropic(**kwargs)
            except ImportError:
                raise ImportError(
                    "anthropic SDK 未安装，请执行: pip install anthropic"
                )
        return self._client

    async def complete(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str = "",
        temperature: float = 0.3,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        use_model = self._resolve_model(model) if model else self.default_model
        try:
            client = self._get_client()
            response = await client.messages.create(
                model=use_model,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
            # 提取文本内容：跳过 ThinkingBlock，拼接所有 TextBlock
            content = ""
            if response.content:
                parts = []
                for block in response.content:
                    if getattr(block, "type", "") != "text":
                        continue
                    text = getattr(block, "text", "")
                    if text:
                        parts.append(text)
                content = "".join(parts).strip()

            stop_reason = getattr(response, "stop_reason", "") or ""
            usage = response.usage

            # 思考型模型可能把 max_tokens 全部用于 thinking，导致没有任何文本输出
            if not content:
                if stop_reason == "max_tokens":
                    error = (
                        f"模型输出被截断：thinking 占用了全部 {max_tokens} tokens，未返回文本"
                        f"（model: {use_model}）。请增大 max_tokens 或关闭 thinking"
                    )
                else:
                    error = f"模型未返回文本内容（stop_reason: {stop_reason or 'unknown'}）"
                return LLMResponse(
                    content="",
                    model=use_model,
                    output_tokens=usage.output_tokens if usage else 0,
                    stop_reason=stop_reason,
                    error=error,
                )

            return LLMResponse(
                content=content,
                model=use_model,
                input_tokens=usage.input_tokens if usage else 0,
                output_tokens=usage.output_tokens if usage else 0,
                stop_reason=stop_reason,
            )
        except ImportError as e:
            return LLMResponse(content="", error=str(e))
        except Exception as e:
            return LLMResponse(
                content="",
                model=use_model,
                error=f"Anthropic 协议调用失败: {type(e).__name__}: {e}",
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
        """Anthropic Messages 原生流式调用。

        转发 TextBlock 的增量；ThinkingBlock 的增量以 "thinking" 事件单独透传，
        供前端在正式输出前展示推理进度。
        """
        use_model = self._resolve_model(model) if model else self.default_model
        emitted = False
        try:
            client = self._get_client()
            # 注意：SDK 1.15 的 messages.stream() 不接受 temperature 参数
            async with client.messages.stream(
                model=use_model,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            ) as stream:
                async for event in stream:
                    if getattr(event, "type", "") != "content_block_delta":
                        continue
                    delta = getattr(event, "delta", None)
                    delta_type = getattr(delta, "type", "")
                    if delta_type == "text_delta":
                        text = getattr(delta, "text", "")
                        if text:
                            emitted = True
                            yield LLMStreamEvent(type="delta", text=text)
                    elif delta_type == "thinking_delta":
                        # 思考型模型在正式输出前可能持续很久，透传推理过程保持前端响应
                        thinking = getattr(delta, "thinking", "")
                        if thinking:
                            yield LLMStreamEvent(type="thinking", text=thinking)
                final = await stream.get_final_message()

            usage = final.usage
            yield LLMStreamEvent(
                type="done",
                model=use_model,
                input_tokens=usage.input_tokens if usage else 0,
                output_tokens=usage.output_tokens if usage else 0,
                stop_reason=getattr(final, "stop_reason", "") or "",
            )
        except ImportError as e:
            yield LLMStreamEvent(type="done", model=use_model, error=str(e))
        except Exception as e:
            if emitted:
                # 已经输出部分内容，不能再退化为一次性调用
                yield LLMStreamEvent(
                    type="done",
                    model=use_model,
                    error=f"Anthropic 流式调用中断: {type(e).__name__}: {e}",
                )
                return
            # 网关不支持流式时退化为一次性调用
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
        # 如果配置了自定义 base_url（企业网关），优先使用网关健康检查端点
        if self.base_url:
            try:
                import httpx
                health_url = self.base_url.rstrip("/") + "/health/private"
                async with httpx.AsyncClient(timeout=10) as http:
                    r = await http.get(health_url)
                    if r.status_code == 200:
                        return True, f"连接成功 (gateway: {self.base_url}, model: {self.default_model})"
                    # 健康端点不可用，回退到实际调用测试
            except Exception:
                pass  # 回退到实际调用测试

        # 直连 Anthropic 或网关无健康端点时，发送小请求测试
        try:
            resp = await self.complete(
                system_prompt="You are a test assistant.",
                user_prompt="Reply with exactly: OK",
                max_tokens=64,
            )
            if resp.ok:
                return True, f"Anthropic 协议连接成功 (model: {resp.model})"
            return False, resp.error or "未知错误"
        except Exception as e:
            return False, f"Anthropic 协议连接失败: {e}"
