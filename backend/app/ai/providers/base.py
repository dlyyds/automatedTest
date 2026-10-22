"""
AI Provider 抽象基类。

所有 LLM Provider（Claude / OpenAI / Ollama）实现统一的 complete() 接口，
AIService 通过 Provider 抽象与具体 LLM 解耦。
"""
from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import AsyncIterator, Optional


@dataclass
class LLMResponse:
    """LLM 调用结果。"""
    content: str               # 生成的文本内容
    model: str = ""            # 实际使用的模型
    input_tokens: int = 0      # 输入 token 数
    output_tokens: int = 0     # 输出 token 数
    stop_reason: str = ""      # 结束原因（max_tokens = 输出被截断）
    error: Optional[str] = None  # 错误信息（None = 成功）

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def truncated(self) -> bool:
        """输出是否因达到 max_tokens 被截断。"""
        return self.stop_reason == "max_tokens"


@dataclass
class LLMStreamEvent:
    """流式调用事件。

    type:
    - "delta"    模型正式输出的增量文本
    - "thinking" 思考型模型的推理过程增量（可选）
    - "done"     结束事件，携带结束原因与用量
    """
    type: str
    text: str = ""
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    stop_reason: str = ""
    error: Optional[str] = None

    @property
    def truncated(self) -> bool:
        """输出是否因达到 max_tokens 被截断。"""
        return self.stop_reason == "max_tokens"


class BaseProvider(abc.ABC):
    """LLM Provider 抽象基类。"""

    name: str = "base"

    @abc.abstractmethod
    async def complete(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str = "",
        temperature: float = 0.3,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        """发送一次 LLM 请求，返回 LLMResponse。

        参数:
            system_prompt: 系统提示词
            user_prompt: 用户消息
            model: 模型名（空串使用 Provider 默认）
            temperature: 生成温度
            max_tokens: 最大输出 token 数

        返回:
            LLMResponse，失败时 error 字段非空
        """
        ...

    async def stream_complete(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        model: str = "",
        temperature: float = 0.3,
        max_tokens: int = 2048,
    ) -> AsyncIterator[LLMStreamEvent]:
        """流式生成。

        默认实现退化为一次性调用：完整内容作为一个 delta 发出。
        支持流式的 Provider 应覆写此方法，逐块产出 delta。
        """
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

    @abc.abstractmethod
    async def test_connection(self) -> tuple[bool, str]:
        """测试 Provider 连通性。

        返回: (是否成功, 消息)
        """
        ...
