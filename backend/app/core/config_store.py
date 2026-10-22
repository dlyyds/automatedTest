"""
配置持久化。

当前阶段使用 JSON 文件保存 SSH / Workspace 配置，
避免服务重启后配置完全丢失。
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import List, Optional, Type, TypeVar
from uuid import uuid4

from pydantic import BaseModel

from app.core.test_case import AIConfig


T = TypeVar("T", bound=BaseModel)


class ConfigStore:
    def __init__(self, base_dir: str = "runtime"):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)

    def _path(self, name: str) -> str:
        return os.path.join(self.base_dir, f"{name}.json")

    def load(self, name: str, model_cls: Type[T], default: T) -> T:
        path = self._path(name)
        if not os.path.exists(path):
            return default

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return model_cls(**data)
        except Exception:
            return default

    def save(self, name: str, model: BaseModel):
        path = self._path(name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(model.model_dump(), f, ensure_ascii=False, indent=2)


class AIProfileEntry(BaseModel):
    """一份 AI 配置方案快照。"""
    id: str
    name: str
    config: AIConfig
    created_at: str
    updated_at: str


class AIProfileBundle(BaseModel):
    """所有配置方案及当前激活的方案 id。"""
    profiles: List[AIProfileEntry] = []
    active_id: Optional[str] = None


class AIProfileStore:
    """AI 配置方案存储。

    方案只是当前生效配置（ai_config.json）的快照：激活方案时把快照写回
    ai_config.json，其余业务代码无需感知方案的存在。
    """

    def __init__(self, base_dir: str = "runtime"):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)
        self.path = os.path.join(self.base_dir, "ai_profiles.json")

    def load_bundle(self) -> AIProfileBundle:
        if not os.path.exists(self.path):
            return AIProfileBundle()
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return AIProfileBundle(**json.load(f))
        except Exception:
            return AIProfileBundle()

    def _save_bundle(self, bundle: AIProfileBundle) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(bundle.model_dump(), f, ensure_ascii=False, indent=2)

    @staticmethod
    def _now() -> str:
        return datetime.now().isoformat(timespec="seconds")

    def create(self, name: str, config: AIConfig) -> AIProfileEntry:
        """用当前配置新建方案，并设为激活方案。名称重复时抛 ValueError。"""
        bundle = self.load_bundle()
        if any(p.name == name for p in bundle.profiles):
            raise ValueError(f"配置方案「{name}」已存在")
        now = self._now()
        entry = AIProfileEntry(
            id=uuid4().hex,
            name=name,
            config=config,
            created_at=now,
            updated_at=now,
        )
        bundle.profiles.append(entry)
        bundle.active_id = entry.id
        self._save_bundle(bundle)
        return entry

    def get_active(self) -> Optional[AIProfileEntry]:
        """返回当前激活方案；没有激活方案时返回 None。"""
        bundle = self.load_bundle()
        if not bundle.active_id:
            return None
        return next((p for p in bundle.profiles if p.id == bundle.active_id), None)

    def update_active(self, config: AIConfig) -> None:
        """普通保存配置时，同步更新当前激活方案的快照。"""
        bundle = self.load_bundle()
        if not bundle.active_id:
            return
        for profile in bundle.profiles:
            if profile.id == bundle.active_id:
                profile.config = config
                profile.updated_at = self._now()
                self._save_bundle(bundle)
                return

    def activate(self, profile_id: str) -> AIProfileEntry:
        bundle = self.load_bundle()
        entry = next((p for p in bundle.profiles if p.id == profile_id), None)
        if entry is None:
            raise KeyError(profile_id)
        bundle.active_id = entry.id
        self._save_bundle(bundle)
        return entry

    def delete(self, profile_id: str) -> tuple[bool, Optional[AIProfileEntry]]:
        """删除方案。

        若删除的是激活方案，自动激活剩余的第一个方案，保证始终有可编辑的
        配置项。返回 (是否发生激活切换, 删除后的激活方案)，调用方据此决定
        是否把新方案写回当前生效配置。
        """
        bundle = self.load_bundle()
        remaining = [p for p in bundle.profiles if p.id != profile_id]
        if len(remaining) == len(bundle.profiles):
            raise KeyError(profile_id)

        switched = bundle.active_id == profile_id
        bundle.profiles = remaining
        if switched:
            bundle.active_id = remaining[0].id if remaining else None
        self._save_bundle(bundle)

        active = next((p for p in remaining if p.id == bundle.active_id), None)
        return switched, active
