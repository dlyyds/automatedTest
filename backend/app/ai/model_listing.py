"""
从 AI 接入地址查询可用模型列表。

按协议调用供应商的模型列表接口：
- anthropic: GET {base_url}/v1/models
- openai:    GET {base_url}/models（兼容只填根地址的端点，回退 /v1/models）
- ollama:    GET {base_url}/api/tags

查询失败（网络不可达、鉴权失败、端点不支持等）统一返回空列表，
由调用方决定回退到手动输入，不抛异常。
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

DEFAULT_BASE_URLS = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "ollama": "http://localhost:11434",
}

_TIMEOUT_SECONDS = 10.0


def _join(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def _normalize_items(data: Any) -> list[dict]:
    """把不同供应商的返回结构统一为 [{id, label}]。"""
    if isinstance(data, dict):
        items = data.get("data") or data.get("models") or []
    elif isinstance(data, list):
        items = data
    else:
        items = []

    result: list[dict] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, str):
            model_id, label = item, item
        elif isinstance(item, dict):
            model_id = item.get("id") or item.get("name") or item.get("model") or ""
            label = item.get("display_name") or item.get("label") or item.get("name") or model_id
        else:
            continue

        model_id = str(model_id).strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)

        label = str(label or model_id).strip() or model_id
        if label != model_id:
            label = f"{label} ({model_id})"
        result.append({"id": model_id, "label": label})

    return result


async def _get_json(
    client: httpx.AsyncClient,
    url: str,
    headers: dict,
    params: Optional[dict] = None,
) -> Optional[Any]:
    """请求并解析 JSON；任何失败返回 None（不抛异常）。"""
    try:
        response = await client.get(url, headers=headers, params=params)
    except Exception:
        return None
    if response.status_code != 200:
        return None
    try:
        return response.json()
    except Exception:
        return None


async def _list_openai(client: httpx.AsyncClient, base: str, api_key: str) -> list[dict]:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    urls = [_join(base, "models")]
    if not base.rstrip("/").endswith("/v1"):
        # 用户只填了服务根地址时，再试一下 /v1/models
        urls.append(_join(base, "v1/models"))

    for url in urls:
        data = await _get_json(client, url, headers)
        if data is not None:
            return _normalize_items(data)
    return []


async def _list_anthropic(client: httpx.AsyncClient, base: str, api_key: str) -> list[dict]:
    if not api_key:
        return []
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    if base.rstrip("/").endswith("/v1"):
        urls = [_join(base, "models")]
    else:
        urls = [_join(base, "v1/models"), _join(base, "models")]

    for url in urls:
        data = await _get_json(client, url, headers, params={"limit": 1000})
        if data is not None:
            return _normalize_items(data)
    return []


async def _list_ollama(client: httpx.AsyncClient, base: str) -> list[dict]:
    data = await _get_json(client, _join(base, "api/tags"), {})
    if data is None:
        return []
    return _normalize_items(data)


async def list_models(protocol: str, base_url: str = "", api_key: str = "") -> list[dict]:
    """查询模型列表；失败时返回空列表。"""
    protocol = (protocol or "anthropic").strip().lower()
    base = (base_url or DEFAULT_BASE_URLS.get(protocol, "")).strip()
    if not base:
        return []

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            if protocol == "ollama":
                return await _list_ollama(client, base)
            if protocol == "openai":
                return await _list_openai(client, base, api_key)
            return await _list_anthropic(client, base, api_key)
    except Exception:
        return []
