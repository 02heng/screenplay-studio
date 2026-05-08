from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.llm_keys_store import load_all, merge_into_stored

router = APIRouter(prefix="/api/settings", tags=["settings"])


class LlmKeysUpdate(BaseModel):
    keys: dict[str, str] = Field(default_factory=dict, description="preset_id → api_key；空字符串表示清除该预设")


@router.get("/llm-keys")
def get_llm_keys():
    """返回已保存的 Key（仅建议本机使用；文件位于用户数据目录）。"""
    return {"keys": load_all()}


@router.put("/llm-keys")
def put_llm_keys(payload: LlmKeysUpdate):
    merged = merge_into_stored(payload.keys)
    return {"keys": merged}
